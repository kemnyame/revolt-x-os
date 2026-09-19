import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadSchoolConfig } from './config.js';
import { createSchoolDb, ensureSchoolSchema, migrateSchool, maybeOne, one, tx } from './db.js';
import { authorize } from './auth.js';
import { schoolFrontend } from './ui.js';
import { parentFrontend } from './parent-ui.js';
import { teacherFrontend } from './teacher-ui.js';
import { studentFrontend } from './student-ui.js';
import { admissionsFrontend } from './admissions-ui.js';
import { initializePaystack, providerStatus, sendMessage, verifyPaystack, type MessageChannel } from './providers.js';

const config=loadSchoolConfig();
const db=createSchoolDb(config);
await ensureSchoolSchema(db);
await migrateSchool(db);

const app=Fastify({logger:config.NODE_ENV!=='test',trustProxy:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(cors,{origin:config.CORS_ORIGINS==='*'?true:config.CORS_ORIGINS.split(',').map(x=>x.trim()),credentials:true});

const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
async function audit(organisationId:string,userId:string,action:string,resourceType:string,resourceId?:string|null,metadata:any={}){
  await db.query('INSERT INTO school_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[organisationId,userId,action,resourceType,resourceId??null,JSON.stringify(metadata)]);
}
async function activeYear(org:string){
  return maybeOne<any>(db,"SELECT * FROM academic_years WHERE organisation_id=$1 AND status='active' ORDER BY start_date DESC LIMIT 1",[org]);
}
async function activeTerm(org:string){
  return maybeOne<any>(db,"SELECT t.* FROM terms t JOIN academic_years y ON y.id=t.academic_year_id WHERE t.organisation_id=$1 AND y.status='active' AND t.status='active' ORDER BY t.term_no LIMIT 1",[org]);
}

function normalizePhone(phone:string){
  const p=String(phone||'').trim().replace(/[\s()-]/g,'');
  if(p.startsWith('+'))return p;
  if(/^0\d{9}$/.test(p))return '+233'+p.slice(1);
  return p;
}

async function deliverCommunication(input:{
  organisationId:string;
  actorOsUserId?:string|null|undefined;
  channel:MessageChannel;
  recipientName?:string|null|undefined;
  recipientAddress:string;
  subject?:string|null|undefined;
  body:string;
  templateKey?:string|null|undefined;
  relatedType?:string|null|undefined;
  relatedId?:string|null|undefined;
}){
  const status=providerStatus(config);
  const configured=input.channel==='email'?status.email.configured:input.channel==='sms'?status.sms.configured:status.whatsapp.configured;
  const row=await one<any>(db,`INSERT INTO communication_outbox(
      organisation_id,channel,recipient_name,recipient_address,subject,body,template_key,related_type,related_id,status,created_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[
      input.organisationId,input.channel,input.recipientName??null,input.recipientAddress,input.subject??null,input.body,
      input.templateKey??null,input.relatedType??null,input.relatedId??null,configured?'queued':'pending_configuration',input.actorOsUserId??null
    ]);
  if(!configured)return row;
  try{
    await db.query("UPDATE communication_outbox SET status='sending',attempt_count=attempt_count+1 WHERE id=$1",[row.id]);
    const sent=await sendMessage(config,{
      channel:input.channel,
      to:input.channel==='email'?input.recipientAddress:normalizePhone(input.recipientAddress),
      subject:input.subject,
      body:input.body
    });
    return await one<any>(db,`UPDATE communication_outbox
      SET status='sent',provider=$1,provider_message_id=$2,sent_at=now(),last_error=NULL
      WHERE id=$3 RETURNING *`,[sent.provider,sent.messageId,row.id]);
  }catch(error:any){
    return await one<any>(db,`UPDATE communication_outbox SET status='failed',last_error=$1 WHERE id=$2 RETURNING *`,
      [String(error?.message||error),row.id]);
  }
}

async function notifyContact(input:{
  organisationId:string;
  actorOsUserId?:string|null|undefined;
  eventKey:string;
  name?:string|null|undefined;
  email?:string|null|undefined;
  phone?:string|null|undefined;
  subject:string;
  body:string;
  relatedType?:string|null|undefined;
  relatedId?:string|null|undefined;
}){
  const rules=(await db.query('SELECT channel,enabled FROM notification_rules WHERE organisation_id=$1 AND event_key=$2',[input.organisationId,input.eventKey])).rows;
  const active=rules.length?rules.filter((r:any)=>r.enabled).map((r:any)=>r.channel):['email'];
  const results:any[]=[];
  for(const ch of active as MessageChannel[]){
    const address=ch==='email'?input.email:input.phone;
    if(!address)continue;
    results.push(await deliverCommunication({
      organisationId:input.organisationId,actorOsUserId:input.actorOsUserId,channel:ch,
      recipientName:input.name,recipientAddress:address,subject:input.subject,body:input.body,
      templateKey:input.eventKey,relatedType:input.relatedType,relatedId:input.relatedId
    }));
  }
  return results;
}

async function updateStudentFeeStatus(client:any,studentFeeId:string){
  const calc=await one<any>(client,`SELECT sf.id,(sf.amount_due-sf.discount) due,
    COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid
    FROM student_fees sf LEFT JOIN payments p ON p.student_fee_id=sf.id
    WHERE sf.id=$1 GROUP BY sf.id`,[studentFeeId]);
  const paid=Number(calc.paid),due=Number(calc.due);
  const status=paid>=due?'paid':paid>0?'part_paid':'unpaid';
  await client.query('UPDATE student_fees SET status=$1 WHERE id=$2',[status,studentFeeId]);
  return{paid,due,status,balance:Math.max(0,due-paid)};
}

async function settleOnlinePayment(reference:string){
  const intent=await maybeOne<any>(db,'SELECT * FROM payment_intents WHERE reference=$1',[reference]);
  if(!intent)throw fail(404,'Payment reference not found');
  if(intent.status==='success'&&intent.settled_payment_id)return intent;
  const verified=await verifyPaystack(config,reference);
  if(verified.status!=='success'){
    await db.query(`UPDATE payment_intents SET status=$1,failure_reason=$2,provider_payload=$3,updated_at=now() WHERE id=$4`,
      [verified.status==='failed'?'failed':'pending',verified.gatewayResponse,JSON.stringify(verified.raw),intent.id]);
    return await one<any>(db,'SELECT * FROM payment_intents WHERE id=$1',[intent.id]);
  }
  if(Math.abs(Number(intent.amount)-Number(verified.amount))>0.001||String(intent.currency)!==String(verified.currency)){
    await db.query("UPDATE payment_intents SET status='failed',failure_reason='Verified amount or currency mismatch',updated_at=now() WHERE id=$1",[intent.id]);
    throw fail(409,'Payment verification amount did not match the request');
  }
  return tx(db,async client=>{
    const locked=await one<any>(client,'SELECT * FROM payment_intents WHERE id=$1 FOR UPDATE',[intent.id]);
    if(locked.status==='success'&&locked.settled_payment_id)return locked;
    const payment=await one<any>(client,`INSERT INTO payments(
      organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id,note,source,payment_intent_id
    ) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9) RETURNING *`,[
      locked.organisation_id,locked.student_id,locked.student_fee_id,locked.amount,locked.method,
      verified.reference,'Online payment verified by Paystack',locked.initiated_by_type==='guardian'?'parent_online':'school_online',locked.id
    ]);
    if(locked.student_fee_id)await updateStudentFeeStatus(client,locked.student_fee_id);
    if(locked.payment_request_id)await client.query("UPDATE fee_payment_requests SET status='paid',paid_at=now(),updated_at=now() WHERE id=$1",[locked.payment_request_id]);
    const updated=await one<any>(client,`UPDATE payment_intents SET status='success',settled_payment_id=$1,paid_at=now(),
      provider_payload=$2,updated_at=now() WHERE id=$3 RETURNING *`,[payment.id,JSON.stringify(verified.raw),locked.id]);
    return updated;
  });
}

function hashPortalPin(pin:string){
  const salt=randomBytes(16);
  const derived=scryptSync(pin,salt,32);
  return salt.toString('hex')+':'+derived.toString('hex');
}
function verifyPortalPin(pin:string,stored:string){
  const parts=stored.split(':');if(parts.length!==2)return false;
  const salt=Buffer.from(parts[0]||'','hex'),expected=Buffer.from(parts[1]||'','hex');
  const actual=scryptSync(pin,salt,32);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
const hashPortalToken=(token:string)=>createHash('sha256').update(token).digest('hex');

async function guardianAuth(request:any){
  const auth=String(request.headers.authorization||'');
  if(!auth.startsWith('Bearer '))throw fail(401,'Parent portal sign-in required');
  const token=auth.slice(7);
  const row=await maybeOne<any>(db,`SELECT gps.id session_id,g.id guardian_id,g.organisation_id,g.first_name,g.last_name,g.phone,g.email
    FROM guardian_portal_sessions gps JOIN guardians g ON g.id=gps.guardian_id
    WHERE gps.token_hash=$1 AND gps.revoked_at IS NULL AND gps.expires_at>now() LIMIT 1`,[hashPortalToken(token)]);
  if(!row)throw fail(401,'Parent portal session has expired');
  return row;
}
async function ensureGuardianStudent(guardianId:string,studentId:string){
  const row=await maybeOne<any>(db,'SELECT s.* FROM students s JOIN student_guardians sg ON sg.student_id=s.id WHERE s.id=$1 AND sg.guardian_id=$2',[studentId,guardianId]);
  if(!row)throw fail(403,'This student is not linked to the signed-in guardian');
  return row;
}

async function studentAuth(request:any){
  const auth=String(request.headers.authorization||'');
  if(!auth.startsWith('Bearer '))throw fail(401,'Student portal sign-in required');
  const token=auth.slice(7);
  const row=await maybeOne<any>(db,`SELECT sps.id session_id,s.id student_id,s.organisation_id,s.admission_no,s.first_name,s.last_name,s.status
    FROM student_portal_sessions sps JOIN students s ON s.id=sps.student_id
    WHERE sps.token_hash=$1 AND sps.revoked_at IS NULL AND sps.expires_at>now() LIMIT 1`,[hashPortalToken(token)]);
  if(!row)throw fail(401,'Student portal session has expired');
  return row;
}
async function ensureTeacherScope(a:any,classroomId:string,subjectId?:string|null){
  if(a.role!=='teacher')return;
  const row=await maybeOne<any>(db,`SELECT 1 FROM classrooms c
    WHERE c.id=$1 AND c.organisation_id=$2 AND (
      c.class_teacher_os_user_id=$3 OR EXISTS(
        SELECT 1 FROM teacher_assignments ta
        WHERE ta.classroom_id=c.id AND ta.organisation_id=$2 AND ta.teacher_os_user_id=$3
          AND ta.is_active=true AND ($4::uuid IS NULL OR ta.subject_id IS NULL OR ta.subject_id=$4)
      )
    ) LIMIT 1`,[classroomId,a.core.organisation_id,a.core.id,subjectId??null]);
  if(!row)throw fail(403,'You are not assigned to this class or subject');
}


async function calculateStudentTermResults(orgId:string,studentId:string,termId:string){
  const rows=(await db.query(`
    WITH category_scores AS (
      SELECT
        a.subject_id,
        sub.name subject_name,
        COALESCE(ac.id,a.id) category_id,
        COALESCE(ac.code,upper(a.assessment_type)) category_code,
        COALESCE(ac.name,initcap(a.assessment_type)) category_name,
        COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,
        ROUND(AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END)::numeric,2) category_average,
        COUNT(sc.score)::int exercise_count
      FROM assessments a
      JOIN subjects sub ON sub.id=a.subject_id
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$2
      WHERE a.organisation_id=$1 AND a.term_id=$3
      GROUP BY a.subject_id,sub.name,COALESCE(ac.id,a.id),COALESCE(ac.code,upper(a.assessment_type)),
               COALESCE(ac.name,initcap(a.assessment_type)),COALESCE(ac.weight_percent,a.weight,0)
    ),
    subject_scores AS (
      SELECT subject_id,subject_name,
        SUM(CASE WHEN category_average IS NOT NULL THEN category_average*weight_percent/100.0 ELSE 0 END) weighted_points,
        SUM(CASE WHEN category_average IS NOT NULL THEN weight_percent ELSE 0 END) assessed_weight,
        SUM(exercise_count)::int assessment_count,
        jsonb_agg(jsonb_build_object(
          'categoryId',category_id,'code',category_code,'name',category_name,
          'weightPercent',weight_percent,'average',category_average,'exerciseCount',exercise_count,
          'weightedContribution',CASE WHEN category_average IS NULL THEN NULL ELSE ROUND((category_average*weight_percent/100.0)::numeric,2) END
        ) ORDER BY category_name) components
      FROM category_scores
      GROUP BY subject_id,subject_name
    )
    SELECT subject_id,subject_name,assessment_count,assessed_weight,components,
      ROUND(CASE WHEN assessed_weight>0 THEN (weighted_points/assessed_weight)*100.0 ELSE NULL END::numeric,2) percentage,
      ROUND(weighted_points::numeric,2) weighted_points
    FROM subject_scores
    ORDER BY subject_name`,[orgId,studentId,termId])).rows;
  const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[orgId])).rows;
  return rows.map((s:any)=>{
    const pct=s.percentage==null?null:Number(s.percentage);
    const band=pct==null?null:bands.find((b:any)=>pct>=Number(b.min_percentage)&&pct<=Number(b.max_percentage));
    return {...s,percentage:pct,grade:band?.name??'',remark:band?.remark??''};
  });
}

async function calculateClassRank(orgId:string,classroomId:string,termId:string,studentId:string){
  return maybeOne<any>(db,`
    WITH category_scores AS (
      SELECT e.student_id,a.subject_id,COALESCE(ac.id,a.id) category_id,
             COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,
             AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END) category_average
      FROM enrolments e
      JOIN assessments a ON a.classroom_id=e.classroom_id AND a.term_id=$3
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=e.student_id
      WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.status='active'
      GROUP BY e.student_id,a.subject_id,COALESCE(ac.id,a.id),COALESCE(ac.weight_percent,a.weight,0)
    ),
    subject_scores AS (
      SELECT student_id,subject_id,
             CASE WHEN SUM(CASE WHEN category_average IS NOT NULL THEN weight_percent ELSE 0 END)>0
               THEN SUM(CASE WHEN category_average IS NOT NULL THEN category_average*weight_percent/100.0 ELSE 0 END)
                    / SUM(CASE WHEN category_average IS NOT NULL THEN weight_percent ELSE 0 END) * 100.0
               ELSE NULL END subject_percentage
      FROM category_scores
      GROUP BY student_id,subject_id
    ),
    student_scores AS (
      SELECT student_id,AVG(subject_percentage) overall_average
      FROM subject_scores
      WHERE subject_percentage IS NOT NULL
      GROUP BY student_id
    ),
    ranked AS (
      SELECT student_id,ROUND(overall_average::numeric,2) average,
             RANK() OVER(ORDER BY overall_average DESC)::int position,
             COUNT(*) OVER()::int class_size
      FROM student_scores
    )
    SELECT * FROM ranked WHERE student_id=$4`,[orgId,classroomId,termId,studentId]);
}

async function provisionDemoTeachers(){
  if(!config.PROVISION_DEMO_TEACHERS)return;
  const base=config.CORE_OS_URL.replace(/\/$/,'');
  try{
    const previewRes=await fetch(base+'/v1/auth/preview-session',{method:'POST',signal:AbortSignal.timeout(10000)});
    if(!previewRes.ok){console.warn('Demo teacher provisioning skipped: Core OS preview access unavailable');return}
    const preview=await previewRes.json() as any;
    const token=preview.accessToken as string;
    const headers={authorization:'Bearer '+token,'content-type':'application/json'};
    const specs=[
      {email:'akua.mensah@revoltxacademy.edu.gh',firstName:'Akua',lastName:'Mensah',jobTitle:'Primary Class Teacher',employeeNumber:'RX-T001'},
      {email:'daniel.osei@revoltxacademy.edu.gh',firstName:'Daniel',lastName:'Osei',jobTitle:'Mathematics Teacher',employeeNumber:'RX-T002'},
      {email:'mabel.addo@revoltxacademy.edu.gh',firstName:'Mabel',lastName:'Addo',jobTitle:'English Language Teacher',employeeNumber:'RX-T003'},
      {email:'samuel.boateng@revoltxacademy.edu.gh',firstName:'Samuel',lastName:'Boateng',jobTitle:'Science Teacher',employeeNumber:'RX-T004'},
      {email:'grace.asante@revoltxacademy.edu.gh',firstName:'Grace',lastName:'Asante',jobTitle:'Social Studies Teacher',employeeNumber:'RX-T005'},
      {email:'linda.owusu@revoltxacademy.edu.gh',firstName:'Linda',lastName:'Owusu',jobTitle:'Computing Teacher',employeeNumber:'RX-T006'},
      {email:'josephine.tetteh@revoltxacademy.edu.gh',firstName:'Josephine',lastName:'Tetteh',jobTitle:'French Teacher',employeeNumber:'RX-T007'},
      {email:'richard.boadu@revoltxacademy.edu.gh',firstName:'Richard',lastName:'Boadu',jobTitle:'Physical Education & Creative Arts Teacher',employeeNumber:'RX-T008'}
    ];
    let usersRes=await fetch(base+'/v1/users',{headers,signal:AbortSignal.timeout(10000)});
    if(!usersRes.ok)throw new Error('Could not read Core OS users');
    let users=await usersRes.json() as any[];
    for(const spec of specs){
      if(!users.some(u=>String(u.email).toLowerCase()===spec.email)){
        const created=await fetch(base+'/v1/users',{method:'POST',headers,body:JSON.stringify({...spec,roleKey:'member'}),signal:AbortSignal.timeout(10000)});
        if(!created.ok&&created.status!==409)console.warn('Could not provision demo teacher',spec.email,created.status);
      }
    }
    usersRes=await fetch(base+'/v1/users',{headers,signal:AbortSignal.timeout(10000)});
    if(!usersRes.ok)throw new Error('Could not refresh Core OS users');
    users=await usersRes.json() as any[];
    const orgId=preview.organisationId||preview.organisation_id;
    const teacherUsers=users.filter(u=>specs.some(s=>s.email===String(u.email).toLowerCase()));
    for(const u of teacherUsers){
      if(u.membership_status!=='active'){
        await fetch(base+'/v1/users/'+u.membership_id+'/status',{method:'PATCH',headers,body:JSON.stringify({status:'active'}),signal:AbortSignal.timeout(10000)});
      }
      await db.query(`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
        VALUES($1,$2,'teacher','active')
        ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role='teacher',status='active',updated_at=now()`,[orgId,u.id]);
    }
    const year=await activeYear(orgId);if(!year)return;
    const term=await activeTerm(orgId);
    const classes=(await db.query(`SELECT c.id,c.name,g.code grade_code,g.stage FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id WHERE c.organisation_id=$1 AND c.academic_year_id=$2 AND c.is_active=true ORDER BY g.level_order,c.name`,[orgId,year.id])).rows;
    const subjects=(await db.query('SELECT id,code,stage FROM subjects WHERE organisation_id=$1 AND is_active=true',[orgId])).rows;
    const byEmail=(email:string)=>teacherUsers.find(u=>String(u.email).toLowerCase()===email);
    const subjectTeacher:Record<string,string>={
      MATH:'daniel.osei@revoltxacademy.edu.gh',ENG:'mabel.addo@revoltxacademy.edu.gh',
      SCI:'samuel.boateng@revoltxacademy.edu.gh',SOC:'grace.asante@revoltxacademy.edu.gh',
      ICT:'linda.owusu@revoltxacademy.edu.gh',FREN:'josephine.tetteh@revoltxacademy.edu.gh',
      CREA:'richard.boadu@revoltxacademy.edu.gh',PE:'richard.boadu@revoltxacademy.edu.gh',
      RME:'akua.mensah@revoltxacademy.edu.gh',CAREER:'linda.owusu@revoltxacademy.edu.gh'
    };
    const classTeacherEmails=['akua.mensah@revoltxacademy.edu.gh','mabel.addo@revoltxacademy.edu.gh','grace.asante@revoltxacademy.edu.gh','daniel.osei@revoltxacademy.edu.gh','samuel.boateng@revoltxacademy.edu.gh','linda.owusu@revoltxacademy.edu.gh','josephine.tetteh@revoltxacademy.edu.gh','richard.boadu@revoltxacademy.edu.gh','samuel.boateng@revoltxacademy.edu.gh'];
    for(let i=0;i<classes.length;i++){
      const cls=classes[i];
      const classTeacher=byEmail(classTeacherEmails[i%classTeacherEmails.length]!);
      if(classTeacher)await db.query('UPDATE classrooms SET class_teacher_os_user_id=$1 WHERE id=$2',[classTeacher.id,cls.id]);
      const allowed=subjects.filter((s:any)=>s.stage==='both'||s.stage===cls.stage);
      for(const sub of allowed){
        await db.query(`INSERT INTO class_subjects(organisation_id,academic_year_id,classroom_id,subject_id,is_active)
          VALUES($1,$2,$3,$4,true)
          ON CONFLICT(academic_year_id,classroom_id,subject_id) DO UPDATE SET is_active=true,updated_at=now()`,[orgId,year.id,cls.id,sub.id]);
        const teacherEmail=subjectTeacher[sub.code];
        const t=teacherEmail?byEmail(teacherEmail):undefined;
        if(t){
          await db.query(`INSERT INTO teacher_assignments(organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,is_active)
            SELECT $1,$2,$3,$4,$5,$6,true
            WHERE NOT EXISTS(
              SELECT 1 FROM teacher_assignments
              WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$4 AND subject_id=$5 AND teacher_os_user_id=$6
                AND (($3::uuid IS NULL AND term_id IS NULL) OR term_id=$3)
            )`,[orgId,year.id,term?.id??null,cls.id,sub.id,t.id]);
        }
      }
    }
    console.log(`Provisioned ${teacherUsers.length} demo teachers and academic assignments`);
  }catch(error){
    console.warn('Demo teacher provisioning failed',error);
  }
}

app.get('/',async(_r,p)=>p.type('text/html; charset=utf-8').send(schoolFrontend));
app.get('/parent',async(_r,p)=>p.type('text/html; charset=utf-8').send(parentFrontend));
app.get('/teacher',async(_r,p)=>p.type('text/html; charset=utf-8').send(teacherFrontend));
app.get('/student',async(_r,p)=>p.type('text/html; charset=utf-8').send(studentFrontend));
app.get('/admissions',async(_r,p)=>p.type('text/html; charset=utf-8').send(admissionsFrontend));
app.get('/health/live',async()=>({status:'ok',service:'revolt-x-school'}));
app.get('/health/ready',async(_r,p)=>{try{await db.query('SELECT 1');return{status:'ready'}}catch{return p.code(503).send({status:'unavailable'})}});

app.post('/api/auth/preview',async(_r,p)=>{
  const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/auth/preview-session',{method:'POST',signal:AbortSignal.timeout(10000)}).catch(()=>null);
  if(!res)throw fail(503,'Core Revolt-X OS could not be reached');
  const body=await res.json().catch(async()=>({error:{message:await res.text().catch(()=> 'Core OS preview request failed')}}));
  return p.code(res.status).send(body);
});

app.get('/api/context',async request=>{
  const a=await authorize(request,db,config);
  const profile=await maybeOne<any>(db,'SELECT * FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  return {core:a.core,schoolRole:a.role,profile};
});

app.post('/api/school/bootstrap',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');
  const b=z.object({schoolName:z.string().min(2).max(240).optional(),shortName:z.string().max(80).optional()}).parse(request.body??{});
  const result=await tx(db,async c=>{
    const profile=await one<any>(c,`INSERT INTO school_profiles(organisation_id,school_name,short_name)
      VALUES($1,$2,$3)
      ON CONFLICT(organisation_id) DO UPDATE SET school_name=COALESCE(EXCLUDED.school_name,school_profiles.school_name),short_name=COALESCE(EXCLUDED.short_name,school_profiles.short_name),updated_at=now()
      RETURNING *`,[a.core.organisation_id,b.schoolName||a.core.organisation_name,b.shortName??null]);
    const levels=[
      ['P1','Primary 1','primary',1],['P2','Primary 2','primary',2],['P3','Primary 3','primary',3],
      ['P4','Primary 4','primary',4],['P5','Primary 5','primary',5],['P6','Primary 6','primary',6],
      ['JHS1','JHS 1','jhs',7],['JHS2','JHS 2','jhs',8],['JHS3','JHS 3','jhs',9]
    ];
    for(const l of levels)await c.query(`INSERT INTO grade_levels(organisation_id,code,name,stage,level_order) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organisation_id,code) DO NOTHING`,[a.core.organisation_id,...l]);
    return profile;
  });
  await audit(a.core.organisation_id,a.core.id,'school.bootstrap','school_profile',a.core.organisation_id);
  return reply.code(201).send(result);
});

app.get('/api/school/profile',async request=>{
  const a=await authorize(request,db,config);
  const row=await maybeOne<any>(db,'SELECT * FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  if(!row)throw fail(404,'School profile has not been set up');
  return row;
});
app.patch('/api/school/profile',async request=>{
  const a=await authorize(request,db,config,'school.manage');
  const b=z.object({schoolName:z.string().min(2).max(240).optional(),shortName:z.string().max(80).nullable().optional(),motto:z.string().max(240).nullable().optional(),phone:z.string().max(60).nullable().optional(),email:z.string().email().nullable().optional(),address:z.string().max(2000).nullable().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE school_profiles SET school_name=COALESCE($1,school_name),short_name=CASE WHEN $2 THEN $3 ELSE short_name END,motto=CASE WHEN $4 THEN $5 ELSE motto END,phone=CASE WHEN $6 THEN $7 ELSE phone END,email=CASE WHEN $8 THEN $9 ELSE email END,address=CASE WHEN $10 THEN $11 ELSE address END,updated_at=now() WHERE organisation_id=$12 RETURNING *`,[b.schoolName??null,Object.hasOwn(b,'shortName'),b.shortName??null,Object.hasOwn(b,'motto'),b.motto??null,Object.hasOwn(b,'phone'),b.phone??null,Object.hasOwn(b,'email'),b.email??null,Object.hasOwn(b,'address'),b.address??null,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'school.profile.updated','school_profile',a.core.organisation_id);
  return row;
});

app.get('/api/dashboard',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const y=await activeYear(a.core.organisation_id),t=await activeTerm(a.core.organisation_id);
  const q=await db.query(`SELECT
    (SELECT count(*) FROM students WHERE organisation_id=$1 AND status='active') students,
    (SELECT count(*) FROM classrooms WHERE organisation_id=$1 AND is_active=true) classes,
    (SELECT count(*) FROM subjects WHERE organisation_id=$1 AND is_active=true) subjects,
    (SELECT count(*) FROM school_memberships WHERE organisation_id=$1 AND status='active') staff_users,
    (SELECT count(*) FROM attendance_records WHERE organisation_id=$1 AND attendance_date=current_date AND status='present') present_today,
    (SELECT count(*) FROM attendance_records WHERE organisation_id=$1 AND attendance_date=current_date AND status='absent') absent_today,
    (SELECT COALESCE(sum(amount),0) FROM payments WHERE organisation_id=$1 AND voided_at IS NULL) payments_received,
    (SELECT COALESCE(sum(sf.amount_due-sf.discount),0) FROM student_fees sf WHERE sf.organisation_id=$1) fees_billed`,[a.core.organisation_id]);
  return {...q.rows[0],activeYear:y,activeTerm:t};
});

app.get('/api/academic-years',async request=>{const a=await authorize(request,db,config);return (await db.query('SELECT * FROM academic_years WHERE organisation_id=$1 ORDER BY start_date DESC',[a.core.organisation_id])).rows});
app.post('/api/academic-years',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');
  const b=z.object({name:z.string().min(4).max(40),startDate:z.string().date(),endDate:z.string().date()}).parse(request.body);
  if(b.endDate<=b.startDate)throw fail(400,'Academic year end date must be after start date');
  const row=await one<any>(db,'INSERT INTO academic_years(organisation_id,name,start_date,end_date) VALUES($1,$2,$3,$4) RETURNING *',[a.core.organisation_id,b.name,b.startDate,b.endDate]);
  await audit(a.core.organisation_id,a.core.id,'academic_year.created','academic_year',row.id);
  return reply.code(201).send(row);
});
app.post('/api/academic-years/:id/activate',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  return tx(db,async c=>{await c.query("UPDATE academic_years SET status='closed' WHERE organisation_id=$1 AND status='active' AND id<>$2",[a.core.organisation_id,id]);const row=await one<any>(c,"UPDATE academic_years SET status='active' WHERE id=$1 AND organisation_id=$2 RETURNING *",[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'academic_year.activated','academic_year',id);return row});
});

app.get('/api/terms',async request=>{const a=await authorize(request,db,config);const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query('SELECT * FROM terms WHERE organisation_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) ORDER BY start_date',[a.core.organisation_id,q.academicYearId??null])).rows});
app.post('/api/terms',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');const b=z.object({academicYearId:z.string().uuid(),termNo:z.number().int().min(1).max(3),name:z.string().min(2).max(80),startDate:z.string().date(),endDate:z.string().date()}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO terms(organisation_id,academic_year_id,term_no,name,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termNo,b.name,b.startDate,b.endDate]);
  await audit(a.core.organisation_id,a.core.id,'term.created','term',row.id);return reply.code(201).send(row);
});
app.post('/api/terms/:id/activate',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  return tx(db,async c=>{const target=await one<any>(c,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await c.query("UPDATE terms SET status='closed' WHERE organisation_id=$1 AND academic_year_id=$2 AND status='active' AND id<>$3",[a.core.organisation_id,target.academic_year_id,id]);return one(c,"UPDATE terms SET status='active' WHERE id=$1 RETURNING *",[id])});
});

app.get('/api/grade-levels',async request=>{const a=await authorize(request,db,config);return (await db.query('SELECT * FROM grade_levels WHERE organisation_id=$1 ORDER BY level_order',[a.core.organisation_id])).rows});
app.get('/api/classes',async request=>{const a=await authorize(request,db,config);const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query(`SELECT c.*,g.code grade_code,g.name grade_name,
  (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=c.id AND e.status='active') student_count,
  (SELECT count(*)::int FROM class_subjects cs WHERE cs.classroom_id=c.id AND cs.is_active=true) subject_count
  FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
  WHERE c.organisation_id=$1 AND ($2::uuid IS NULL OR c.academic_year_id=$2)
  ORDER BY g.level_order,c.name`,[a.core.organisation_id,q.academicYearId??null])).rows});
app.post('/api/classes',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');const b=z.object({academicYearId:z.string().uuid(),gradeLevelId:z.string().uuid(),name:z.string().min(2).max(120),stream:z.string().max(40).optional(),capacity:z.number().int().positive().optional(),classTeacherOsUserId:z.string().uuid().optional()}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO classrooms(organisation_id,academic_year_id,grade_level_id,name,stream,capacity,class_teacher_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[a.core.organisation_id,b.academicYearId,b.gradeLevelId,b.name,b.stream??null,b.capacity??null,b.classTeacherOsUserId??null]);
  await audit(a.core.organisation_id,a.core.id,'class.created','classroom',row.id);return reply.code(201).send(row);
});
app.get('/api/subjects',async request=>{const a=await authorize(request,db,config);return (await db.query('SELECT * FROM subjects WHERE organisation_id=$1 ORDER BY name',[a.core.organisation_id])).rows});
app.post('/api/subjects',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');const b=z.object({code:z.string().min(1).max(30),name:z.string().min(2).max(120),stage:z.enum(['primary','jhs','both']).default('both')}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO subjects(organisation_id,code,name,stage) VALUES($1,$2,$3,$4) RETURNING *',[a.core.organisation_id,b.code.toUpperCase(),b.name,b.stage]);await audit(a.core.organisation_id,a.core.id,'subject.created','subject',row.id);return reply.code(201).send(row);
});

app.get('/api/class-subjects',async request=>{
  const a=await authorize(request,db,config);
  const q=z.object({academicYearId:z.string().uuid().optional(),classroomId:z.string().uuid().optional()}).parse(request.query);
  return (await db.query(`SELECT cs.*,c.name classroom_name,c.class_teacher_os_user_id,g.name grade_name,g.code grade_code,
      s.code subject_code,s.name subject_name,s.stage,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ta.id,'teacherOsUserId',ta.teacher_os_user_id,'termId',ta.term_id,'active',ta.is_active) ORDER BY ta.created_at)
                FROM teacher_assignments ta
                WHERE ta.organisation_id=cs.organisation_id AND ta.classroom_id=cs.classroom_id AND ta.subject_id=cs.subject_id),'[]'::jsonb) teacher_assignments,
      (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=cs.classroom_id AND e.status='active') student_count
    FROM class_subjects cs
    JOIN classrooms c ON c.id=cs.classroom_id
    JOIN grade_levels g ON g.id=c.grade_level_id
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.organisation_id=$1
      AND ($2::uuid IS NULL OR cs.academic_year_id=$2)
      AND ($3::uuid IS NULL OR cs.classroom_id=$3)
    ORDER BY g.level_order,c.name,s.name`,[a.core.organisation_id,q.academicYearId??null,q.classroomId??null])).rows;
});
app.post('/api/class-subjects',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.edit');
  const b=z.object({academicYearId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid()}).parse(request.body);
  const cls=await one<any>(db,'SELECT c.id,g.stage FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id WHERE c.id=$1 AND c.organisation_id=$2 AND c.academic_year_id=$3',[b.classroomId,a.core.organisation_id,b.academicYearId]);
  const subject=await one<any>(db,'SELECT id,stage FROM subjects WHERE id=$1 AND organisation_id=$2 AND is_active=true',[b.subjectId,a.core.organisation_id]);
  if(subject.stage!=='both'&&subject.stage!==cls.stage)throw fail(400,'This subject is not configured for the class stage');
  const row=await one<any>(db,`INSERT INTO class_subjects(organisation_id,academic_year_id,classroom_id,subject_id,is_active)
    VALUES($1,$2,$3,$4,true)
    ON CONFLICT(academic_year_id,classroom_id,subject_id) DO UPDATE SET is_active=true,updated_at=now()
    RETURNING *`,[a.core.organisation_id,b.academicYearId,b.classroomId,b.subjectId]);
  await audit(a.core.organisation_id,a.core.id,'class_subject.assigned','class_subject',row.id,{classroomId:b.classroomId,subjectId:b.subjectId});
  return reply.code(201).send(row);
});
app.delete('/api/class-subjects/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM class_subjects WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const used=await one<any>(db,`SELECT
    (SELECT count(*)::int FROM assessments WHERE classroom_id=$1 AND subject_id=$2) assessments,
    (SELECT count(*)::int FROM timetable_entries WHERE classroom_id=$1 AND subject_id=$2) timetable`,[row.classroom_id,row.subject_id]);
  if(Number(used.assessments)>0||Number(used.timetable)>0)throw fail(409,'This class subject is already used in assessments or the timetable');
  await db.query('DELETE FROM teacher_assignments WHERE organisation_id=$1 AND classroom_id=$2 AND subject_id=$3',[a.core.organisation_id,row.classroom_id,row.subject_id]);
  await db.query('DELETE FROM class_subjects WHERE id=$1',[id]);
  await audit(a.core.organisation_id,a.core.id,'class_subject.removed','class_subject',id,{classroomId:row.classroom_id,subjectId:row.subject_id});
  return reply.code(204).send();
});

app.get('/api/students',async request=>{
  const a=await authorize(request,db,config);const q=z.object({q:z.string().max(100).optional(),classroomId:z.string().uuid().optional(),status:z.enum(['active','graduated','transferred','withdrawn']).optional()}).parse(request.query);const s=q.q?('%'+q.q+'%'):null;
  return (await db.query(`SELECT DISTINCT s.*,c.id classroom_id,c.name classroom_name,g.name grade_name,e.academic_year_id FROM students s LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active' LEFT JOIN classrooms c ON c.id=e.classroom_id LEFT JOIN grade_levels g ON g.id=c.grade_level_id WHERE s.organisation_id=$1 AND ($2::text IS NULL OR (s.first_name||' '||s.last_name||' '||s.admission_no) ILIKE $2) AND ($3::uuid IS NULL OR c.id=$3) AND ($4::text IS NULL OR s.status=$4) ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,s,q.classroomId??null,q.status??null])).rows;
});
app.post('/api/students',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.create');const b=z.object({admissionNo:z.string().min(1).max(60),firstName:z.string().min(1).max(100),middleName:z.string().max(100).optional(),lastName:z.string().min(1).max(100),sex:z.enum(['male','female']).optional(),dateOfBirth:z.string().date().optional(),admissionDate:z.string().date().optional(),notes:z.string().max(5000).optional()}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO students(organisation_id,admission_no,first_name,middle_name,last_name,sex,date_of_birth,admission_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date,current_date),$9) RETURNING *',[a.core.organisation_id,b.admissionNo,b.firstName,b.middleName??null,b.lastName,b.sex??null,b.dateOfBirth??null,b.admissionDate??null,b.notes??null]);await audit(a.core.organisation_id,a.core.id,'student.created','student',row.id);return reply.code(201).send(row);
});
app.get('/api/students/:id',async request=>{const a=await authorize(request,db,config);const {id}=z.object({id:z.string().uuid()}).parse(request.params);const student=await maybeOne<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!student)throw fail(404,'Student not found');const guardians=(await db.query(`SELECT g.*,sg.relationship,sg.is_primary FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC,g.last_name`,[id])).rows;const enrolments=(await db.query(`SELECT e.*,c.name classroom_name,g.name grade_name,y.name academic_year FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id JOIN academic_years y ON y.id=e.academic_year_id WHERE e.student_id=$1 ORDER BY y.start_date DESC`,[id])).rows;return{...student,guardians,enrolments}});

app.get('/api/students/:id/360',async request=>{
  const a=await authorize(request,db,config);
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const student=await maybeOne<any>(db,`SELECT s.*,e.id enrolment_id,e.academic_year_id,c.id classroom_id,c.name classroom_name,c.class_teacher_os_user_id,
      g.id grade_level_id,g.code grade_code,g.name grade_name,y.name academic_year
    FROM students s
    LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active'
    LEFT JOIN classrooms c ON c.id=e.classroom_id
    LEFT JOIN grade_levels g ON g.id=c.grade_level_id
    LEFT JOIN academic_years y ON y.id=e.academic_year_id
    WHERE s.id=$1 AND s.organisation_id=$2
    ORDER BY e.enrolled_at DESC LIMIT 1`,[id,a.core.organisation_id]);
  if(!student)throw fail(404,'Student not found');
  if(student.classroom_id)await ensureTeacherScope(a,student.classroom_id,null);
  const term=await activeTerm(a.core.organisation_id);
  const guardians=(await db.query(`SELECT g.id,g.first_name,g.last_name,g.phone,g.email,g.address,sg.relationship,sg.is_primary,
      (gpa.guardian_id IS NOT NULL AND gpa.is_active=true) portal_active,gpa.last_login_at
    FROM guardians g
    JOIN student_guardians sg ON sg.guardian_id=g.id
    LEFT JOIN guardian_portal_access gpa ON gpa.guardian_id=g.id
    WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC,g.last_name`,[id])).rows;
  const enrolments=(await db.query(`SELECT e.id,e.status,e.enrolled_at,c.name classroom_name,g.name grade_name,y.name academic_year,y.start_date,y.end_date
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id JOIN academic_years y ON y.id=e.academic_year_id
    WHERE e.student_id=$1 ORDER BY y.start_date DESC`,[id])).rows;
  const attendanceRows=(await db.query(`SELECT status,count(*)::int count FROM attendance_records
    WHERE organisation_id=$1 AND student_id=$2 AND ($3::uuid IS NULL OR attendance_date BETWEEN (SELECT start_date FROM terms WHERE id=$3) AND (SELECT end_date FROM terms WHERE id=$3))
    GROUP BY status`,[a.core.organisation_id,id,term?.id??null])).rows;
  const attendance:any={present:0,absent:0,late:0,excused:0,total:0,rate:0};
  for(const r of attendanceRows){attendance[r.status]=Number(r.count);attendance.total+=Number(r.count)}
  attendance.rate=attendance.total?Math.round(((attendance.present+attendance.late)/attendance.total)*1000)/10:0;
  const recentAttendance=(await db.query(`SELECT attendance_date,status,note FROM attendance_records WHERE organisation_id=$1 AND student_id=$2 ORDER BY attendance_date DESC LIMIT 20`,[a.core.organisation_id,id])).rows;
  const fee=await one<any>(db,`SELECT
      COALESCE(sum(sf.amount_due-sf.discount),0) billed,
      COALESCE(sum((SELECT COALESCE(sum(p.amount),0) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL)),0) paid
    FROM student_fees sf WHERE sf.organisation_id=$1 AND sf.student_id=$2`,[a.core.organisation_id,id]);
  fee.outstanding=Math.max(0,Number(fee.billed)-Number(fee.paid));
  const payments=(await db.query(`SELECT p.id,p.amount,p.payment_method,p.reference,p.paid_at,p.voided_at,f.name fee_name
    FROM payments p LEFT JOIN student_fees sf ON sf.id=p.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id
    WHERE p.organisation_id=$1 AND p.student_id=$2 ORDER BY p.paid_at DESC LIMIT 15`,[a.core.organisation_id,id])).rows;
  let subjects:any[]=[];let performance:any={overallAverage:null,classPosition:null,classSize:null};
  if(term){
    subjects=await calculateStudentTermResults(a.core.organisation_id,id,term.id);
    if(subjects.length){
      const available=subjects.filter((s:any)=>s.percentage!=null);
      if(available.length)performance.overallAverage=Math.round((available.reduce((sum:number,s:any)=>sum+Number(s.percentage),0)/available.length)*100)/100;
    }
    if(student.classroom_id){
      const rank=await calculateClassRank(a.core.organisation_id,student.classroom_id,term.id,id);
      if(rank)performance={...performance,overallAverage:Number(rank.average),classPosition:rank.position,classSize:rank.class_size};
    }
  }
  const homework=(await db.query(`SELECT h.id,h.title,h.due_at,h.status,sub.name subject_name,
      COALESCE(hs.status,'not_submitted') submission_status,hs.score,hs.teacher_comment
    FROM homework_assignments h JOIN subjects sub ON sub.id=h.subject_id
    LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$2
    WHERE h.organisation_id=$1 AND ($3::uuid IS NULL OR h.term_id=$3)
      AND ($4::uuid IS NULL OR h.classroom_id=$4)
    ORDER BY h.due_at DESC NULLS LAST LIMIT 20`,[a.core.organisation_id,id,term?.id??null,student.classroom_id??null])).rows;
  const promotions=(await db.query(`SELECT p.*,fy.name from_year,ty.name to_year,fc.name from_class,tc.name to_class
    FROM student_promotions p
    JOIN academic_years fy ON fy.id=p.from_academic_year_id JOIN academic_years ty ON ty.id=p.to_academic_year_id
    LEFT JOIN classrooms fc ON fc.id=p.from_classroom_id LEFT JOIN classrooms tc ON tc.id=p.to_classroom_id
    WHERE p.organisation_id=$1 AND p.student_id=$2 ORDER BY p.created_at DESC`,[a.core.organisation_id,id])).rows;
  const comments=term?await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,id,term.id]):null;
  const portal=await maybeOne<any>(db,`SELECT spa.is_active,spa.last_login_at,
      (SELECT count(*)::int FROM student_portal_sessions sps WHERE sps.student_id=spa.student_id AND sps.revoked_at IS NULL AND sps.expires_at>now()) active_sessions
    FROM student_portal_access spa WHERE spa.student_id=$1`,[id]);
  const activity=(await db.query(`SELECT action,resource_type,resource_id,metadata,created_at FROM school_audit_logs
    WHERE organisation_id=$1 AND (resource_id=$2 OR metadata->>'studentId'=$2)
    ORDER BY created_at DESC LIMIT 20`,[a.core.organisation_id,id])).rows;
  return{student,term,guardians,enrolments,attendance,recentAttendance,fees:fee,payments,subjects,performance,homework,promotions,comments,portal,activity};
});
app.patch('/api/students/:id',async request=>{
  const a=await authorize(request,db,config,'students.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({firstName:z.string().min(1).max(100).optional(),middleName:z.string().max(100).nullable().optional(),lastName:z.string().min(1).max(100).optional(),status:z.enum(['active','graduated','transferred','withdrawn']).optional(),notes:z.string().max(5000).nullable().optional()}).parse(request.body);
  const row=await one<any>(db,`UPDATE students SET first_name=COALESCE($1,first_name),middle_name=CASE WHEN $2 THEN $3 ELSE middle_name END,last_name=COALESCE($4,last_name),status=COALESCE($5,status),notes=CASE WHEN $6 THEN $7 ELSE notes END,updated_at=now() WHERE id=$8 AND organisation_id=$9 RETURNING *`,[b.firstName??null,Object.hasOwn(b,'middleName'),b.middleName??null,b.lastName??null,b.status??null,Object.hasOwn(b,'notes'),b.notes??null,id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'student.updated','student',id);return row;
});
app.post('/api/students/:id/guardians',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({firstName:z.string().min(1).max(100),lastName:z.string().min(1).max(100),phone:z.string().min(5).max(60),email:z.string().email().optional(),address:z.string().max(2000).optional(),relationship:z.string().min(2).max(60),isPrimary:z.boolean().default(false)}).parse(request.body);
  const row=await tx(db,async c=>{const g=await one<any>(c,'INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.firstName,b.lastName,b.phone,b.email??null,b.address??null]);if(b.isPrimary)await c.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[id]);await c.query('INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary) VALUES($1,$2,$3,$4)',[id,g.id,b.relationship,b.isPrimary]);return g});await audit(a.core.organisation_id,a.core.id,'guardian.linked','student',id,{guardianId:row.id});return reply.code(201).send(row);
});
app.post('/api/enrolments',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.edit');const b=z.object({studentId:z.string().uuid(),academicYearId:z.string().uuid(),classroomId:z.string().uuid()}).parse(request.body);const row=await one<any>(db,'INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,academic_year_id) DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status=\'active\',enrolled_at=now() RETURNING *',[a.core.organisation_id,b.studentId,b.academicYearId,b.classroomId]);await audit(a.core.organisation_id,a.core.id,'student.enrolled','enrolment',row.id);return reply.code(201).send(row);
});

app.get('/api/attendance',async request=>{
  const a=await authorize(request,db,config);const q=z.object({classroomId:z.string().uuid(),date:z.string().date()}).parse(request.query);await ensureTeacherScope(a,q.classroomId,null);
  return (await db.query(`SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,COALESCE(ar.status,'unmarked') attendance_status,ar.note FROM enrolments e JOIN students s ON s.id=e.student_id LEFT JOIN attendance_records ar ON ar.student_id=s.id AND ar.classroom_id=e.classroom_id AND ar.attendance_date=$3 WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.status='active' ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,q.classroomId,q.date])).rows;
});
app.post('/api/attendance/mark',async request=>{
  const a=await authorize(request,db,config,'attendance.mark');const b=z.object({classroomId:z.string().uuid(),date:z.string().date(),records:z.array(z.object({studentId:z.string().uuid(),status:z.enum(['present','absent','late','excused']),note:z.string().max(500).optional()})).min(1).max(200)}).parse(request.body);await ensureTeacherScope(a,b.classroomId,null);
  await tx(db,async c=>{for(const r of b.records)await c.query(`INSERT INTO attendance_records(organisation_id,student_id,classroom_id,attendance_date,status,note,marked_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(student_id,classroom_id,attendance_date) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,marked_by_os_user_id=EXCLUDED.marked_by_os_user_id,updated_at=now()`,[a.core.organisation_id,r.studentId,b.classroomId,b.date,r.status,r.note??null,a.core.id])});await audit(a.core.organisation_id,a.core.id,'attendance.marked','classroom',b.classroomId,{date:b.date,count:b.records.length});return{saved:b.records.length};
});


app.get('/api/assessment-categories',async request=>{
  const a=await authorize(request,db,config,'assessment.view');
  const q=z.object({academicYearId:z.string().uuid().optional(),termId:z.string().uuid().optional()}).parse(request.query);
  const rows=(await db.query(`SELECT ac.*,
      (SELECT count(*)::int FROM assessments a WHERE a.category_id=ac.id) exercise_count
    FROM assessment_categories ac
    WHERE ac.organisation_id=$1
      AND ($2::uuid IS NULL OR ac.academic_year_id=$2)
      AND ($3::uuid IS NULL OR ac.term_id=$3)
    ORDER BY ac.sort_order,ac.name`,[a.core.organisation_id,q.academicYearId??null,q.termId??null])).rows;
  const totalWeight=rows.filter((r:any)=>r.is_active).reduce((sum:number,r:any)=>sum+Number(r.weight_percent),0);
  return{categories:rows,totalWeight:Math.round(totalWeight*100)/100};
});
app.post('/api/assessment-categories',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.create');
  const b=z.object({
    academicYearId:z.string().uuid(),
    termId:z.string().uuid(),
    code:z.string().min(1).max(40),
    name:z.string().min(2).max(120),
    defaultMaxScore:z.number().positive(),
    weightPercent:z.number().min(0).max(100),
    sortOrder:z.number().int().default(0)
  }).parse(request.body);
  const total=await one<any>(db,`SELECT COALESCE(sum(weight_percent),0) total FROM assessment_categories
    WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id=$3 AND is_active=true`,
    [a.core.organisation_id,b.academicYearId,b.termId]);
  if(Number(total.total)+b.weightPercent>100.0001)throw fail(400,'Assessment category weights cannot exceed 100% for a term');
  const row=await one<any>(db,`INSERT INTO assessment_categories(
      organisation_id,academic_year_id,term_id,code,name,default_max_score,weight_percent,sort_order
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [a.core.organisation_id,b.academicYearId,b.termId,b.code.toUpperCase(),b.name,b.defaultMaxScore,b.weightPercent,b.sortOrder]);
  await audit(a.core.organisation_id,a.core.id,'assessment_category.created','assessment_category',row.id,{weight:b.weightPercent});
  return reply.code(201).send(row);
});
app.patch('/api/assessment-categories/:id',async request=>{
  const a=await authorize(request,db,config,'assessment.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    name:z.string().min(2).max(120).optional(),
    defaultMaxScore:z.number().positive().optional(),
    weightPercent:z.number().min(0).max(100).optional(),
    sortOrder:z.number().int().optional(),
    isActive:z.boolean().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM assessment_categories WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const nextWeight=b.weightPercent??Number(current.weight_percent);
  const total=await one<any>(db,`SELECT COALESCE(sum(weight_percent),0) total FROM assessment_categories
    WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id=$3 AND id<>$4 AND is_active=true`,
    [a.core.organisation_id,current.academic_year_id,current.term_id,id]);
  if((b.isActive??current.is_active)&&Number(total.total)+nextWeight>100.0001)throw fail(400,'Assessment category weights cannot exceed 100% for a term');
  const row=await one<any>(db,`UPDATE assessment_categories SET
      name=COALESCE($1,name),
      default_max_score=COALESCE($2,default_max_score),
      weight_percent=COALESCE($3,weight_percent),
      sort_order=COALESCE($4,sort_order),
      is_active=COALESCE($5,is_active),
      updated_at=now()
    WHERE id=$6 AND organisation_id=$7 RETURNING *`,
    [b.name??null,b.defaultMaxScore??null,b.weightPercent??null,b.sortOrder??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment_category.updated','assessment_category',id);
  return row;
});
app.delete('/api/assessment-categories/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.delete');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const used=await one<any>(db,'SELECT count(*)::int n FROM assessments WHERE category_id=$1',[id]);
  if(Number(used.n)>0)throw fail(409,'This assessment category already has exercises. Disable it instead of deleting it.');
  await one<any>(db,'DELETE FROM assessment_categories WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment_category.deleted','assessment_category',id);
  return reply.code(204).send();
});

app.get('/api/assessments',async request=>{
  const a=await authorize(request,db,config,'assessment.view');
  const q=z.object({termId:z.string().uuid().optional(),classroomId:z.string().uuid().optional(),subjectId:z.string().uuid().optional(),categoryId:z.string().uuid().optional()}).parse(request.query);
  let rows=(await db.query(`SELECT a.*,s.name subject_name,c.name classroom_name,t.name term_name,
      ac.name category_name,ac.code category_code,ac.weight_percent category_weight,ac.default_max_score,
      (SELECT count(*)::int FROM assessment_scores sc WHERE sc.assessment_id=a.id) scored_students
    FROM assessments a
    JOIN subjects s ON s.id=a.subject_id
    JOIN classrooms c ON c.id=a.classroom_id
    JOIN terms t ON t.id=a.term_id
    LEFT JOIN assessment_categories ac ON ac.id=a.category_id
    WHERE a.organisation_id=$1
      AND ($2::uuid IS NULL OR a.term_id=$2)
      AND ($3::uuid IS NULL OR a.classroom_id=$3)
      AND ($4::uuid IS NULL OR a.subject_id=$4)
      AND ($5::uuid IS NULL OR a.category_id=$5)
    ORDER BY ac.sort_order NULLS LAST,a.assessment_date DESC NULLS LAST,a.created_at DESC`,
    [a.core.organisation_id,q.termId??null,q.classroomId??null,q.subjectId??null,q.categoryId??null])).rows;
  if(a.role==='teacher'){
    const allowed=(await db.query(`SELECT DISTINCT classroom_id,subject_id FROM teacher_assignments
      WHERE organisation_id=$1 AND teacher_os_user_id=$2 AND is_active=true
      UNION SELECT id,NULL::uuid FROM classrooms WHERE organisation_id=$1 AND class_teacher_os_user_id=$2`,
      [a.core.organisation_id,a.core.id])).rows;
    rows=rows.filter((r:any)=>allowed.some((x:any)=>x.classroom_id===r.classroom_id&&(x.subject_id==null||x.subject_id===r.subject_id)));
  }
  return rows;
});
app.post('/api/assessments',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.create');
  const b=z.object({
    academicYearId:z.string().uuid(),
    termId:z.string().uuid(),
    classroomId:z.string().uuid(),
    subjectId:z.string().uuid(),
    categoryId:z.string().uuid().optional(),
    assessmentType:z.enum(['classwork','homework','project','test','exam','other']).optional(),
    name:z.string().min(2).max(160),
    maxScore:z.number().positive().optional(),
    assessmentDate:z.string().date().optional()
  }).parse(request.body);
  await ensureTeacherScope(a,b.classroomId,b.subjectId);
  let category:any=null;
  if(b.categoryId){
    category=await one<any>(db,`SELECT * FROM assessment_categories
      WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND term_id=$4 AND is_active=true`,
      [b.categoryId,a.core.organisation_id,b.academicYearId,b.termId]);
  }else{
    const code=({classwork:'CLASSWORK',homework:'HOMEWORK',project:'PROJECT',test:'MIDTERM',exam:'EXAM',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];
    category=await maybeOne<any>(db,`SELECT * FROM assessment_categories
      WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id=$3 AND code=$4 AND is_active=true`,
      [a.core.organisation_id,b.academicYearId,b.termId,code]);
  }
  if(!category)throw fail(400,'Select a valid assessment category for this term');
  const type=category.code==='CLASSWORK'?'classwork':category.code==='HOMEWORK'?'homework':category.code==='PROJECT'?'project':category.code==='EXAM'?'exam':category.code==='MIDTERM'?'test':'other';
  const maxScore=b.maxScore??Number(category.default_max_score);
  const row=await one<any>(db,`INSERT INTO assessments(
      organisation_id,academic_year_id,term_id,classroom_id,subject_id,category_id,name,assessment_type,max_score,weight,assessment_date,created_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,category.id,b.name,type,maxScore,category.weight_percent,b.assessmentDate??null,a.core.id]);
  await audit(a.core.organisation_id,a.core.id,'assessment.created','assessment',row.id,{categoryId:category.id});
  return reply.code(201).send(row);
});
app.get('/api/assessments/:id/scores',async request=>{
  const a=await authorize(request,db,config,'assessment.view');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const ass=await maybeOne<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!ass)throw fail(404,'Assessment not found');await ensureTeacherScope(a,ass.classroom_id,ass.subject_id);const rows=(await db.query(`SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,sc.score,sc.comment FROM enrolments e JOIN students s ON s.id=e.student_id LEFT JOIN assessment_scores sc ON sc.student_id=s.id AND sc.assessment_id=$1 WHERE e.classroom_id=$2 AND e.status='active' ORDER BY s.last_name,s.first_name`,[id,ass.classroom_id])).rows;return{assessment:ass,students:rows};
});
app.post('/api/assessments/:id/scores',async request=>{
  const a=await authorize(request,db,config,'assessment.score');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({scores:z.array(z.object({studentId:z.string().uuid(),score:z.number().min(0),comment:z.string().max(500).optional()})).min(1).max(200)}).parse(request.body);const ass=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,ass.classroom_id,ass.subject_id);for(const s of b.scores)if(Number(s.score)>Number(ass.max_score))throw fail(400,`Score cannot exceed ${ass.max_score}`);await tx(db,async c=>{for(const s of b.scores)await c.query(`INSERT INTO assessment_scores(assessment_id,student_id,score,comment) VALUES($1,$2,$3,$4) ON CONFLICT(assessment_id,student_id) DO UPDATE SET score=EXCLUDED.score,comment=EXCLUDED.comment,updated_at=now()`,[id,s.studentId,s.score,s.comment??null])});await audit(a.core.organisation_id,a.core.id,'assessment.scores_saved','assessment',id,{count:b.scores.length});return{saved:b.scores.length};
});

app.get('/api/report-cards/:studentId',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const q=z.object({termId:z.string().uuid()}).parse(request.query);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[studentId,a.core.organisation_id]);
  const term=await one<any>(db,`SELECT t.*,y.name academic_year,y.start_date academic_year_start,y.end_date academic_year_end
    FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
    WHERE t.id=$1 AND t.organisation_id=$2`,[q.termId,a.core.organisation_id]);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.name classroom_name,c.class_teacher_os_user_id,g.name grade_name,g.code grade_code,
      e.academic_year_id,y.name academic_year
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id JOIN academic_years y ON y.id=e.academic_year_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id]);
  if(current?.classroom_id)await ensureTeacherScope(a,current.classroom_id,null);
  const subjects=await calculateStudentTermResults(a.core.organisation_id,studentId,q.termId);
  let overallAverage=subjects.length?Math.round((subjects.filter((s:any)=>s.percentage!=null).reduce((sum:number,s:any)=>sum+Number(s.percentage||0),0)/Math.max(1,subjects.filter((s:any)=>s.percentage!=null).length))*100)/100:null;
  let classPosition:number|null=null,classSize:number|null=null;
  if(current?.classroom_id){
    const rank=await calculateClassRank(a.core.organisation_id,current.classroom_id,q.termId,studentId);
    if(rank){overallAverage=Number(rank.average);classPosition=rank.position;classSize=rank.class_size}
  }
  const attendanceRows=(await db.query(`SELECT status,count(*)::int count FROM attendance_records ar
    WHERE ar.organisation_id=$1 AND ar.student_id=$2 AND ar.attendance_date BETWEEN $3::date AND $4::date
    GROUP BY status`,[a.core.organisation_id,studentId,term.start_date,term.end_date])).rows;
  const attendance:any={present:0,absent:0,late:0,excused:0,total:0,rate:0};
  for(const r of attendanceRows){attendance[r.status]=Number(r.count);attendance.total+=Number(r.count)}
  attendance.rate=attendance.total?Math.round(((attendance.present+attendance.late)/attendance.total)*1000)/10:0;
  const comments=await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,q.termId]);
  const school=await one<any>(db,'SELECT school_name,short_name,motto,phone,email,address,currency FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  return{
    school,
    student:{...student,...(current||{})},
    term,
    termId:q.termId,
    subjects,
    performance:{overallAverage,classPosition,classSize},
    attendance,
    comments,
    generatedAt:new Date().toISOString()
  };
});

app.get('/api/fee-items',async request=>{const a=await authorize(request,db,config);const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query(`SELECT f.*,g.name grade_name,t.name term_name FROM fee_items f LEFT JOIN grade_levels g ON g.id=f.grade_level_id LEFT JOIN terms t ON t.id=f.term_id WHERE f.organisation_id=$1 AND ($2::uuid IS NULL OR f.academic_year_id=$2) ORDER BY f.created_at DESC`,[a.core.organisation_id,q.academicYearId??null])).rows});
app.post('/api/fee-items',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.create');const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().optional(),gradeLevelId:z.string().uuid().optional(),name:z.string().min(2).max(160),amount:z.number().min(0),mandatory:z.boolean().default(true)}).parse(request.body);const row=await one<any>(db,'INSERT INTO fee_items(organisation_id,academic_year_id,term_id,grade_level_id,name,amount,mandatory) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termId??null,b.gradeLevelId??null,b.name,b.amount,b.mandatory]);await audit(a.core.organisation_id,a.core.id,'fee_item.created','fee_item',row.id);return reply.code(201).send(row);
});
app.post('/api/fees/assign',async request=>{
  const a=await authorize(request,db,config,'fees.create');const b=z.object({feeItemId:z.string().uuid(),studentId:z.string().uuid().optional(),classroomId:z.string().uuid().optional()}).refine(v=>v.studentId||v.classroomId,{message:'studentId or classroomId is required'}).parse(request.body);const fee=await one<any>(db,'SELECT * FROM fee_items WHERE id=$1 AND organisation_id=$2',[b.feeItemId,a.core.organisation_id]);let students:string[]=[];if(b.studentId)students=[b.studentId];else students=(await db.query("SELECT student_id FROM enrolments WHERE organisation_id=$1 AND classroom_id=$2 AND status='active'",[a.core.organisation_id,b.classroomId])).rows.map((x:any)=>x.student_id);for(const sid of students)await db.query(`INSERT INTO student_fees(organisation_id,student_id,fee_item_id,amount_due) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,fee_item_id) DO NOTHING`,[a.core.organisation_id,sid,fee.id,fee.amount]);await audit(a.core.organisation_id,a.core.id,'fees.assigned','fee_item',fee.id,{count:students.length});return{assigned:students.length};
});
app.get('/api/fees/student/:studentId',async request=>{
  const a=await authorize(request,db,config);const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);const items=(await db.query(`SELECT sf.*,f.name fee_name,f.amount original_amount,COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) paid FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id WHERE sf.organisation_id=$1 AND sf.student_id=$2 ORDER BY sf.created_at DESC`,[a.core.organisation_id,studentId])).rows;const payments=(await db.query('SELECT * FROM payments WHERE organisation_id=$1 AND student_id=$2 ORDER BY paid_at DESC',[a.core.organisation_id,studentId])).rows;return{items,payments};
});
app.post('/api/payments',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.record');
  const b=z.object({
    studentId:z.string().uuid(),
    studentFeeId:z.string().uuid().optional(),
    amount:z.number().positive(),
    paymentMethod:z.enum(['cash','mobile_money','bank','card','other']),
    reference:z.string().max(120).optional(),
    note:z.string().max(500).optional()
  }).parse(request.body);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
  const row=await tx(db,async client=>{
    if(b.studentFeeId){
      const fee=await one<any>(client,`SELECT (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
        FROM student_fees sf WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3`,[b.studentFeeId,b.studentId,a.core.organisation_id]);
      if(b.amount>Number(fee.balance)+0.001)throw fail(400,'Payment cannot exceed the outstanding fee balance');
    }
    const p=await one<any>(client,`INSERT INTO payments(
      organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id,note,source
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'school_manual') RETURNING *`,[
      a.core.organisation_id,b.studentId,b.studentFeeId??null,b.amount,b.paymentMethod,b.reference??null,a.core.id,b.note??null
    ]);
    if(b.studentFeeId)await updateStudentFeeStatus(client,b.studentFeeId);
    return p;
  });
  const guardian=await maybeOne<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id
    WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC LIMIT 1`,[b.studentId]);
  if(guardian){
    const school=await one<any>(db,'SELECT school_name,currency FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
    await notifyContact({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'fees.payment_received',
      name:guardian.first_name+' '+guardian.last_name,email:guardian.email,phone:guardian.phone,
      subject:'School fee payment received',
      body:`${school.school_name} has recorded a payment of ${school.currency||'GHS'} ${Number(b.amount).toFixed(2)} for ${student.first_name} ${student.last_name}. Method: ${b.paymentMethod.replace('_',' ')}.${b.reference?' Reference: '+b.reference+'.':''}`,
      relatedType:'payment',relatedId:row.id
    });
  }
  await audit(a.core.organisation_id,a.core.id,'payment.recorded','payment',row.id,{amount:b.amount,method:b.paymentMethod});
  return reply.code(201).send(row);
});

app.get('/api/timetable',async request=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional(),academicYearId:z.string().uuid().optional()}).parse(request.query);
  return (await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name,t.name term_name,y.name academic_year
    FROM timetable_entries tt JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    JOIN academic_years y ON y.id=tt.academic_year_id LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1 AND ($2::uuid IS NULL OR tt.classroom_id=$2)
      AND ($3::uuid IS NULL OR tt.term_id=$3) AND ($4::uuid IS NULL OR tt.academic_year_id=$4)
    ORDER BY tt.day_of_week,tt.start_time,c.name`,[a.core.organisation_id,q.classroomId??null,q.termId??null,q.academicYearId??null])).rows;
});
app.get('/api/timetable/export.csv',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional(),academicYearId:z.string().uuid().optional()}).parse(request.query);
  const rows=(await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name,t.name term_name,y.name academic_year
    FROM timetable_entries tt JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    JOIN academic_years y ON y.id=tt.academic_year_id LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1 AND ($2::uuid IS NULL OR tt.classroom_id=$2)
      AND ($3::uuid IS NULL OR tt.term_id=$3) AND ($4::uuid IS NULL OR tt.academic_year_id=$4)
    ORDER BY c.name,tt.day_of_week,tt.start_time`,[a.core.organisation_id,q.classroomId??null,q.termId??null,q.academicYearId??null])).rows;
  let users:any[]=[];
  try{
    const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/users',{headers:{authorization:request.headers.authorization!},signal:AbortSignal.timeout(8000)});
    if(res.ok)users=await res.json() as any[];
  }catch{}
  const userName=(id:string|null)=>{const u=users.find(x=>x.id===id);return u?u.first_name+' '+u.last_name:''};
  const csv=(v:any)=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const days=['','Monday','Tuesday','Wednesday','Thursday','Friday'];
  const lines=[['Academic Year','Term','Class','Day','Start','End','Subject','Teacher','Room'].map(csv).join(',')];
  for(const r of rows)lines.push([r.academic_year,r.term_name||'',r.classroom_name,days[r.day_of_week],String(r.start_time).slice(0,5),String(r.end_time).slice(0,5),r.subject_name,userName(r.teacher_os_user_id),r.room||''].map(csv).join(','));
  reply.header('content-type','text/csv; charset=utf-8');
  reply.header('content-disposition','attachment; filename="revolt-x-school-timetable.csv"');
  return '\ufeff'+lines.join('\n');
});
app.post('/api/timetable',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.manage');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid().optional(),classroomId:z.string().uuid(),
    subjectId:z.string().uuid(),teacherOsUserId:z.string().uuid().optional(),dayOfWeek:z.number().int().min(1).max(5),
    startTime:z.string().regex(/^\d{2}:\d{2}$/),endTime:z.string().regex(/^\d{2}:\d{2}$/),room:z.string().max(80).optional()
  }).parse(request.body);
  if(b.endTime<=b.startTime)throw fail(400,'End time must be after start time');
  const conflict=await maybeOne<any>(db,`SELECT tt.id,c.name classroom_name,s.name subject_name FROM timetable_entries tt
    JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    WHERE tt.organisation_id=$1 AND tt.academic_year_id=$2 AND tt.day_of_week=$3
      AND tt.start_time<$5::time AND tt.end_time>$4::time
      AND (
        tt.classroom_id=$6 OR
        ($7::uuid IS NOT NULL AND tt.teacher_os_user_id=$7)
      )
      AND (tt.term_id IS NOT DISTINCT FROM $8::uuid OR tt.term_id IS NULL OR $8::uuid IS NULL)
    LIMIT 1`,[a.core.organisation_id,b.academicYearId,b.dayOfWeek,b.startTime,b.endTime,b.classroomId,b.teacherOsUserId??null,b.termId??null]);
  if(conflict)throw fail(409,`Timetable conflict with ${conflict.classroom_name} - ${conflict.subject_name}`);
  const row=await one<any>(db,`INSERT INTO timetable_entries(
    organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,room
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[
    a.core.organisation_id,b.academicYearId,b.termId??null,b.classroomId,b.subjectId,b.teacherOsUserId??null,b.dayOfWeek,b.startTime,b.endTime,b.room??null
  ]);
  await audit(a.core.organisation_id,a.core.id,'timetable.created','timetable_entry',row.id);
  return reply.code(201).send(row);
});

app.get('/api/staff/core-users',async request=>{
  const a=await authorize(request,db,config,'staff.view');const auth=request.headers.authorization!;const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/users',{headers:{authorization:auth},signal:AbortSignal.timeout(10000)});if(!res.ok)throw fail(res.status,'Could not load Core OS users');return res.json();
});

app.post('/api/staff/teachers',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.create');
  const auth=request.headers.authorization!;
  const b=z.object({
    email:z.string().email(),
    firstName:z.string().min(1).max(100),
    lastName:z.string().min(1).max(100),
    jobTitle:z.string().min(2).max(160).default('Teacher'),
    employeeNumber:z.string().max(80).optional()
  }).parse(request.body);
  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const created=await fetch(base+'/v1/users',{
    method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:JSON.stringify({...b,roleKey:'member'}),
    signal:AbortSignal.timeout(10000)
  });
  const payload=await created.json().catch(()=>null) as any;
  if(!created.ok)throw fail(created.status,payload?.error?.message||'Could not create teacher in Core OS');
  await fetch(base+'/v1/users/'+payload.id+'/status',{
    method:'PATCH',
    headers:{authorization:auth,'content-type':'application/json'},
    body:JSON.stringify({status:'active'}),
    signal:AbortSignal.timeout(10000)
  }).catch(()=>null);
  await db.query(`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
    VALUES($1,$2,'teacher','active')
    ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role='teacher',status='active',updated_at=now()`,[a.core.organisation_id,payload.user_id]);
  await audit(a.core.organisation_id,a.core.id,'teacher.created','school_membership',payload.id,{email:b.email,osUserId:payload.user_id});
  return reply.code(201).send({osUserId:payload.user_id,membershipId:payload.id,email:b.email,firstName:b.firstName,lastName:b.lastName,jobTitle:b.jobTitle});
});
app.get('/api/staff/module-memberships',async request=>{const a=await authorize(request,db,config,'staff.view');return (await db.query('SELECT * FROM school_memberships WHERE organisation_id=$1 ORDER BY created_at',[a.core.organisation_id])).rows});
app.post('/api/staff/module-memberships',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.edit');const b=z.object({osUserId:z.string().uuid(),role:z.enum(['school_admin','headteacher','teacher','bursar','registrar']),status:z.enum(['active','suspended']).default('active')}).parse(request.body);const row=await one<any>(db,`INSERT INTO school_memberships(organisation_id,os_user_id,role,status) VALUES($1,$2,$3,$4) ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,updated_at=now() RETURNING *`,[a.core.organisation_id,b.osUserId,b.role,b.status]);await audit(a.core.organisation_id,a.core.id,'school_staff.assigned','school_membership',row.id,{role:b.role});return reply.code(201).send(row);
});


app.patch('/api/academic-years/:id',async request=>{
  const a=await authorize(request,db,config,'academic.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(4).max(40).optional(),startDate:z.string().date().optional(),endDate:z.string().date().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM academic_years WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const start=b.startDate??String(current.start_date).slice(0,10),end=b.endDate??String(current.end_date).slice(0,10);
  if(end<=start)throw fail(400,'Academic year end date must be after start date');
  const row=await one<any>(db,'UPDATE academic_years SET name=COALESCE($1,name),start_date=COALESCE($2::date,start_date),end_date=COALESCE($3::date,end_date) WHERE id=$4 AND organisation_id=$5 RETURNING *',[b.name??null,b.startDate??null,b.endDate??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'academic_year.updated','academic_year',id);
  return row;
});
app.delete('/api/academic-years/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const y=await one<any>(db,'SELECT * FROM academic_years WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(y.status==='active')throw fail(409,'Close or activate another academic year before deleting this one');
  const count=await one<any>(db,'SELECT count(*)::int n FROM enrolments WHERE academic_year_id=$1',[id]);
  if(count.n>0)throw fail(409,'This academic year has student enrolments and cannot be deleted');
  await db.query('DELETE FROM academic_years WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'academic_year.deleted','academic_year',id,{name:y.name});
  return reply.code(204).send();
});

app.patch('/api/terms/:id',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(80).optional(),startDate:z.string().date().optional(),endDate:z.string().date().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const start=b.startDate??String(current.start_date).slice(0,10),end=b.endDate??String(current.end_date).slice(0,10);
  if(end<=start)throw fail(400,'Term end date must be after start date');
  const row=await one<any>(db,'UPDATE terms SET name=COALESCE($1,name),start_date=COALESCE($2::date,start_date),end_date=COALESCE($3::date,end_date) WHERE id=$4 AND organisation_id=$5 RETURNING *',[b.name??null,b.startDate??null,b.endDate??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'term.updated','term',id);return row;
});
app.delete('/api/terms/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const t=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(t.status==='active')throw fail(409,'An active term cannot be deleted');
  await db.query('DELETE FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'term.deleted','term',id,{name:t.name});return reply.code(204).send();
});

app.patch('/api/grade-levels/:id',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(80).optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE grade_levels SET name=COALESCE($1,name),is_active=COALESCE($2,is_active) WHERE id=$3 AND organisation_id=$4 RETURNING *',[b.name??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'grade_level.updated','grade_level',id);return row;
});

app.patch('/api/classes/:id',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(120).optional(),stream:z.string().max(40).nullable().optional(),capacity:z.number().int().positive().nullable().optional(),classTeacherOsUserId:z.string().uuid().nullable().optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE classrooms SET name=COALESCE($1,name),stream=CASE WHEN $2 THEN $3 ELSE stream END,capacity=CASE WHEN $4 THEN $5 ELSE capacity END,class_teacher_os_user_id=CASE WHEN $6 THEN $7 ELSE class_teacher_os_user_id END,is_active=COALESCE($8,is_active) WHERE id=$9 AND organisation_id=$10 RETURNING *`,[b.name??null,Object.hasOwn(b,'stream'),b.stream??null,Object.hasOwn(b,'capacity'),b.capacity??null,Object.hasOwn(b,'classTeacherOsUserId'),b.classTeacherOsUserId??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'class.updated','classroom',id);return row;
});
app.delete('/api/classes/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM classrooms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const count=await one<any>(db,'SELECT count(*)::int n FROM enrolments WHERE classroom_id=$1',[id]);
  if(count.n>0)throw fail(409,'Move or remove enrolled students before deleting this class');
  await db.query('DELETE FROM classrooms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'class.deleted','classroom',id,{name:row.name});return reply.code(204).send();
});

app.patch('/api/subjects/:id',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({code:z.string().min(1).max(30).optional(),name:z.string().min(2).max(120).optional(),stage:z.enum(['primary','jhs','both']).optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE subjects SET code=COALESCE($1,code),name=COALESCE($2,name),stage=COALESCE($3,stage),is_active=COALESCE($4,is_active) WHERE id=$5 AND organisation_id=$6 RETURNING *',[b.code?.toUpperCase()??null,b.name??null,b.stage??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'subject.updated','subject',id);return row;
});
app.delete('/api/subjects/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM subjects WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await db.query('DELETE FROM subjects WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'subject.deleted','subject',id,{name:row.name});return reply.code(204).send();
});

app.delete('/api/students/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await tx(db,async c=>{
    const guardians=(await c.query('SELECT guardian_id FROM student_guardians WHERE student_id=$1',[id])).rows.map((x:any)=>x.guardian_id);
    await c.query('DELETE FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    for(const gid of guardians)await c.query('DELETE FROM guardians g WHERE g.id=$1 AND g.organisation_id=$2 AND NOT EXISTS(SELECT 1 FROM student_guardians sg WHERE sg.guardian_id=g.id)',[gid,a.core.organisation_id]);
  });
  await audit(a.core.organisation_id,a.core.id,'student.deleted','student',id,{admissionNo:student.admission_no,name:`${student.first_name} ${student.last_name}`});return reply.code(204).send();
});
app.patch('/api/students/:studentId/guardians/:guardianId',async request=>{
  const a=await authorize(request,db,config,'students.edit');const p=z.object({studentId:z.string().uuid(),guardianId:z.string().uuid()}).parse(request.params);
  const b=z.object({firstName:z.string().min(1).max(100).optional(),lastName:z.string().min(1).max(100).optional(),phone:z.string().min(5).max(60).optional(),email:z.string().email().nullable().optional(),address:z.string().max(2000).nullable().optional(),relationship:z.string().min(2).max(60).optional(),isPrimary:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const linked=await maybeOne<any>(db,'SELECT 1 FROM student_guardians WHERE student_id=$1 AND guardian_id=$2',[p.studentId,p.guardianId]);if(!linked)throw fail(404,'Guardian link not found');
  if(b.isPrimary===true)await db.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[p.studentId]);
  await db.query(`UPDATE guardians SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),phone=COALESCE($3,phone),email=CASE WHEN $4 THEN $5 ELSE email END,address=CASE WHEN $6 THEN $7 ELSE address END,updated_at=now() WHERE id=$8 AND organisation_id=$9`,[b.firstName??null,b.lastName??null,b.phone??null,Object.hasOwn(b,'email'),b.email??null,Object.hasOwn(b,'address'),b.address??null,p.guardianId,a.core.organisation_id]);
  await db.query('UPDATE student_guardians SET relationship=COALESCE($1,relationship),is_primary=COALESCE($2,is_primary) WHERE student_id=$3 AND guardian_id=$4',[b.relationship??null,b.isPrimary??null,p.studentId,p.guardianId]);
  await audit(a.core.organisation_id,a.core.id,'guardian.updated','guardian',p.guardianId,{studentId:p.studentId});
  return one<any>(db,`SELECT g.*,sg.relationship,sg.is_primary FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id WHERE g.id=$1 AND sg.student_id=$2`,[p.guardianId,p.studentId]);
});
app.delete('/api/students/:studentId/guardians/:guardianId',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.delete');const p=z.object({studentId:z.string().uuid(),guardianId:z.string().uuid()}).parse(request.params);
  await db.query('DELETE FROM student_guardians WHERE student_id=$1 AND guardian_id=$2',[p.studentId,p.guardianId]);
  await db.query('DELETE FROM guardians g WHERE g.id=$1 AND g.organisation_id=$2 AND NOT EXISTS(SELECT 1 FROM student_guardians sg WHERE sg.guardian_id=g.id)',[p.guardianId,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'guardian.unlinked','guardian',p.guardianId,{studentId:p.studentId});return reply.code(204).send();
});
app.delete('/api/enrolments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'DELETE FROM enrolments WHERE id=$1 AND organisation_id=$2 RETURNING *',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'enrolment.deleted','enrolment',id,{studentId:row.student_id});return reply.code(204).send();
});

app.delete('/api/attendance',async(request,reply)=>{
  const a=await authorize(request,db,config,'attendance.mark');const q=z.object({classroomId:z.string().uuid(),date:z.string().date()}).parse(request.query);
  const result=await db.query('DELETE FROM attendance_records WHERE organisation_id=$1 AND classroom_id=$2 AND attendance_date=$3',[a.core.organisation_id,q.classroomId,q.date]);
  await audit(a.core.organisation_id,a.core.id,'attendance.cleared','classroom',q.classroomId,{date:q.date,count:result.rowCount??0});return reply.code(200).send({deleted:result.rowCount??0});
});

app.patch('/api/assessments/:id',async request=>{
  const a=await authorize(request,db,config,'assessment.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    name:z.string().min(2).max(160).optional(),
    categoryId:z.string().uuid().optional(),
    maxScore:z.number().positive().optional(),
    assessmentDate:z.string().date().nullable().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,current.classroom_id,current.subject_id);
  let category:any=null;
  if(b.categoryId){
    category=await one<any>(db,`SELECT * FROM assessment_categories
      WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND term_id=$4 AND is_active=true`,
      [b.categoryId,a.core.organisation_id,current.academic_year_id,current.term_id]);
  }
  const type=category?(category.code==='CLASSWORK'?'classwork':category.code==='HOMEWORK'?'homework':category.code==='PROJECT'?'project':category.code==='EXAM'?'exam':category.code==='MIDTERM'?'test':'other'):null;
  const row=await one<any>(db,`UPDATE assessments SET
      name=COALESCE($1,name),
      category_id=COALESCE($2,category_id),
      assessment_type=COALESCE($3,assessment_type),
      max_score=COALESCE($4,max_score),
      weight=COALESCE($5,weight),
      assessment_date=CASE WHEN $6 THEN $7::date ELSE assessment_date END
    WHERE id=$8 AND organisation_id=$9 RETURNING *`,
    [b.name??null,b.categoryId??null,type,b.maxScore??null,category?.weight_percent??null,Object.hasOwn(b,'assessmentDate'),b.assessmentDate??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment.updated','assessment',id,{categoryId:b.categoryId??current.category_id});
  return row;
});
app.delete('/api/assessments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.delete');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,row.classroom_id,row.subject_id);
  await db.query('DELETE FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment.deleted','assessment',id,{name:row.name});
  return reply.code(204).send();
});

app.patch('/api/fee-items/:id',async request=>{
  const a=await authorize(request,db,config,'fees.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(160).optional(),amount:z.number().min(0).optional(),mandatory:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE fee_items SET name=COALESCE($1,name),amount=COALESCE($2,amount),mandatory=COALESCE($3,mandatory) WHERE id=$4 AND organisation_id=$5 RETURNING *',[b.name??null,b.amount??null,b.mandatory??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'fee_item.updated','fee_item',id);return row;
});
app.delete('/api/fee-items/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM fee_items WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const paid=await one<any>(db,'SELECT count(*)::int n FROM payments p JOIN student_fees sf ON sf.id=p.student_fee_id WHERE sf.fee_item_id=$1 AND p.voided_at IS NULL',[id]);
  if(paid.n>0)throw fail(409,'This fee has payments and cannot be deleted');
  await db.query('DELETE FROM fee_items WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'fee_item.deleted','fee_item',id,{name:row.name});return reply.code(204).send();
});
app.get('/api/fees/open-items',async request=>{
  const a=await authorize(request,db,config);const q=z.object({studentId:z.string().uuid().optional()}).parse(request.query);
  return (await db.query(`SELECT sf.id student_fee_id,sf.student_id,s.admission_no,s.first_name,s.last_name,f.name fee_name,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid,((sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0)) balance,sf.status FROM student_fees sf JOIN students s ON s.id=sf.student_id JOIN fee_items f ON f.id=sf.fee_item_id LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.organisation_id=$1 AND ($2::uuid IS NULL OR sf.student_id=$2) GROUP BY sf.id,s.id,f.id HAVING ((sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0))>0 ORDER BY s.last_name,s.first_name,f.name`,[a.core.organisation_id,q.studentId??null])).rows;
});
app.get('/api/payments',async request=>{
  const a=await authorize(request,db,config);const q=z.object({studentId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
  return (await db.query(`SELECT p.*,s.admission_no,s.first_name,s.last_name,f.name fee_name FROM payments p JOIN students s ON s.id=p.student_id LEFT JOIN student_fees sf ON sf.id=p.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id WHERE p.organisation_id=$1 AND ($2::uuid IS NULL OR p.student_id=$2) ORDER BY p.paid_at DESC LIMIT $3`,[a.core.organisation_id,q.studentId??null,q.limit])).rows;
});
app.post('/api/payments/:id/void',async request=>{
  const a=await authorize(request,db,config,'fees.void');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({reason:z.string().min(2).max(500)}).parse(request.body);
  const row=await one<any>(db,'UPDATE payments SET voided_at=now(),voided_by_os_user_id=$1,void_reason=$2 WHERE id=$3 AND organisation_id=$4 AND voided_at IS NULL RETURNING *',[a.core.id,b.reason,id,a.core.organisation_id]);
  if(row.student_fee_id){const calc=await one<any>(db,`SELECT sf.id,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid FROM student_fees sf LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.id=$1 GROUP BY sf.id`,[row.student_fee_id]);const status=Number(calc.paid)>=Number(calc.due)?'paid':Number(calc.paid)>0?'part_paid':'unpaid';await db.query('UPDATE student_fees SET status=$1 WHERE id=$2',[status,row.student_fee_id])}
  await audit(a.core.organisation_id,a.core.id,'payment.voided','payment',id,{reason:b.reason});return row;
});

app.patch('/api/timetable/:id',async request=>{
  const a=await authorize(request,db,config,'timetable.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    subjectId:z.string().uuid().optional(),teacherOsUserId:z.string().uuid().nullable().optional(),
    dayOfWeek:z.number().int().min(1).max(5).optional(),startTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),room:z.string().max(80).nullable().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM timetable_entries WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const day=b.dayOfWeek??current.day_of_week,start=b.startTime??String(current.start_time).slice(0,5),end=b.endTime??String(current.end_time).slice(0,5);
  const teacher=Object.hasOwn(b,'teacherOsUserId')?b.teacherOsUserId:current.teacher_os_user_id;
  if(end<=start)throw fail(400,'End time must be after start time');
  const conflict=await maybeOne<any>(db,`SELECT tt.id,c.name classroom_name,s.name subject_name FROM timetable_entries tt
    JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    WHERE tt.organisation_id=$1 AND tt.academic_year_id=$2 AND tt.day_of_week=$3 AND tt.id<>$4
      AND tt.start_time<$6::time AND tt.end_time>$5::time
      AND (tt.classroom_id=$7 OR ($8::uuid IS NOT NULL AND tt.teacher_os_user_id=$8))
      AND (tt.term_id IS NOT DISTINCT FROM $9::uuid OR tt.term_id IS NULL OR $9::uuid IS NULL)
    LIMIT 1`,[a.core.organisation_id,current.academic_year_id,day,id,start,end,current.classroom_id,teacher??null,current.term_id]);
  if(conflict)throw fail(409,`Timetable conflict with ${conflict.classroom_name} - ${conflict.subject_name}`);
  const row=await one<any>(db,`UPDATE timetable_entries SET subject_id=COALESCE($1,subject_id),
    teacher_os_user_id=CASE WHEN $2 THEN $3 ELSE teacher_os_user_id END,day_of_week=COALESCE($4,day_of_week),
    start_time=COALESCE($5::time,start_time),end_time=COALESCE($6::time,end_time),
    room=CASE WHEN $7 THEN $8 ELSE room END WHERE id=$9 AND organisation_id=$10 RETURNING *`,[
    b.subjectId??null,Object.hasOwn(b,'teacherOsUserId'),b.teacherOsUserId??null,b.dayOfWeek??null,b.startTime??null,b.endTime??null,
    Object.hasOwn(b,'room'),b.room??null,id,a.core.organisation_id
  ]);
  await audit(a.core.organisation_id,a.core.id,'timetable.updated','timetable_entry',id);
  return row;
});
app.delete('/api/timetable/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await one<any>(db,'DELETE FROM timetable_entries WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'timetable.deleted','timetable_entry',id);return reply.code(204).send();
});

app.patch('/api/staff/module-memberships/:id',async request=>{
  const a=await authorize(request,db,config,'staff.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({role:z.enum(['school_admin','headteacher','teacher','bursar','registrar']).optional(),status:z.enum(['active','suspended']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE school_memberships SET role=COALESCE($1,role),status=COALESCE($2,status),updated_at=now() WHERE id=$3 AND organisation_id=$4 RETURNING *',[b.role??null,b.status??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'school_staff.updated','school_membership',id,{role:row.role,status:row.status});return row;
});
app.delete('/api/staff/module-memberships/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM school_memberships WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(row.os_user_id===a.core.id)throw fail(409,'You cannot remove your own School access');
  await db.query('DELETE FROM school_memberships WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'school_staff.removed','school_membership',id,{osUserId:row.os_user_id});return reply.code(204).send();
});


app.get('/api/teacher-assignments',async request=>{
  const a=await authorize(request,db,config,'staff.view');
  return (await db.query(`SELECT ta.*,c.name classroom_name,s.name subject_name
    FROM teacher_assignments ta
    JOIN classrooms c ON c.id=ta.classroom_id
    LEFT JOIN subjects s ON s.id=ta.subject_id
    WHERE ta.organisation_id=$1
    ORDER BY c.name,s.name NULLS FIRST,ta.created_at DESC`,[a.core.organisation_id])).rows;
});
app.post('/api/teacher-assignments',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.edit');
  const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().nullable().optional(),classroomId:z.string().uuid(),subjectId:z.string().uuid().nullable().optional(),teacherOsUserId:z.string().uuid()}).parse(request.body);
  const row=await one<any>(db,`INSERT INTO teacher_assignments(organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id)
    DO UPDATE SET is_active=true
    RETURNING *`,[a.core.organisation_id,b.academicYearId,b.termId??null,b.classroomId,b.subjectId??null,b.teacherOsUserId]);
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.created','teacher_assignment',row.id,{teacherOsUserId:b.teacherOsUserId});
  return reply.code(201).send(row);
});
app.patch('/api/teacher-assignments/:id',async request=>{
  const a=await authorize(request,db,config,'staff.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({isActive:z.boolean()}).parse(request.body);
  const row=await one<any>(db,'UPDATE teacher_assignments SET is_active=$1 WHERE id=$2 AND organisation_id=$3 RETURNING *',[b.isActive,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.updated','teacher_assignment',id,{isActive:b.isActive});return row;
});
app.delete('/api/teacher-assignments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await one<any>(db,'DELETE FROM teacher_assignments WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.deleted','teacher_assignment',id);return reply.code(204).send();
});

app.get('/api/grading-bands',async request=>{
  const a=await authorize(request,db,config);
  return (await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 ORDER BY sort_order,min_percentage DESC',[a.core.organisation_id])).rows;
});
app.post('/api/grading-bands',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.create');
  const b=z.object({name:z.string().min(1).max(40),minPercentage:z.number().min(0).max(100),maxPercentage:z.number().min(0).max(100),remark:z.string().max(120).optional(),sortOrder:z.number().int().default(0)}).parse(request.body);
  if(b.maxPercentage<b.minPercentage)throw fail(400,'Maximum percentage must be greater than or equal to minimum percentage');
  const row=await one<any>(db,'INSERT INTO grading_bands(organisation_id,name,min_percentage,max_percentage,remark,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.name,b.minPercentage,b.maxPercentage,b.remark??null,b.sortOrder]);
  await audit(a.core.organisation_id,a.core.id,'grading_band.created','grading_band',row.id);return reply.code(201).send(row);
});
app.patch('/api/grading-bands/:id',async request=>{
  const a=await authorize(request,db,config,'assessment.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(1).max(40).optional(),minPercentage:z.number().min(0).max(100).optional(),maxPercentage:z.number().min(0).max(100).optional(),remark:z.string().max(120).nullable().optional(),sortOrder:z.number().int().optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM grading_bands WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const min=b.minPercentage??Number(current.min_percentage),max=b.maxPercentage??Number(current.max_percentage);if(max<min)throw fail(400,'Maximum percentage must be greater than or equal to minimum percentage');
  const row=await one<any>(db,`UPDATE grading_bands SET name=COALESCE($1,name),min_percentage=COALESCE($2,min_percentage),max_percentage=COALESCE($3,max_percentage),remark=CASE WHEN $4 THEN $5 ELSE remark END,sort_order=COALESCE($6,sort_order),is_active=COALESCE($7,is_active) WHERE id=$8 AND organisation_id=$9 RETURNING *`,[b.name??null,b.minPercentage??null,b.maxPercentage??null,Object.hasOwn(b,'remark'),b.remark??null,b.sortOrder??null,b.isActive??null,id,a.core.organisation_id]);return row;
});
app.delete('/api/grading-bands/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await one<any>(db,'DELETE FROM grading_bands WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);return reply.code(204).send();
});

app.get('/api/homework',async request=>{
  const a=await authorize(request,db,config);const q=z.object({classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional(),status:z.enum(['draft','published','closed']).optional()}).parse(request.query);
  let rows=(await db.query(`SELECT h.*,c.name classroom_name,s.name subject_name FROM homework_assignments h JOIN classrooms c ON c.id=h.classroom_id JOIN subjects s ON s.id=h.subject_id WHERE h.organisation_id=$1 AND ($2::uuid IS NULL OR h.classroom_id=$2) AND ($3::uuid IS NULL OR h.term_id=$3) AND ($4::text IS NULL OR h.status=$4) ORDER BY h.created_at DESC`,[a.core.organisation_id,q.classroomId??null,q.termId??null,q.status??null])).rows;
  if(a.role==='teacher'){
    const allowed=(await db.query(`SELECT DISTINCT classroom_id,subject_id FROM teacher_assignments WHERE organisation_id=$1 AND teacher_os_user_id=$2 AND is_active=true UNION SELECT id,NULL::uuid FROM classrooms WHERE organisation_id=$1 AND class_teacher_os_user_id=$2`,[a.core.organisation_id,a.core.id])).rows;
    rows=rows.filter((r:any)=>allowed.some((x:any)=>x.classroom_id===r.classroom_id&&(x.subject_id==null||x.subject_id===r.subject_id)));
  }
  return rows;
});
app.post('/api/homework',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.create');const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),title:z.string().min(2).max(200),instructions:z.string().min(1).max(10000),dueAt:z.string().datetime().optional(),maxScore:z.number().positive().optional()}).parse(request.body);
  await ensureTeacherScope(a,b.classroomId,b.subjectId);
  const row=await one<any>(db,`INSERT INTO homework_assignments(organisation_id,academic_year_id,term_id,classroom_id,subject_id,title,instructions,due_at,max_score,created_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,b.title,b.instructions,b.dueAt??null,b.maxScore??null,a.core.id]);
  await audit(a.core.organisation_id,a.core.id,'homework.created','homework',row.id);return reply.code(201).send(row);
});
app.patch('/api/homework/:id',async request=>{
  const a=await authorize(request,db,config,'assessment.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,current.classroom_id,current.subject_id);
  const b=z.object({title:z.string().min(2).max(200).optional(),instructions:z.string().min(1).max(10000).optional(),dueAt:z.string().datetime().nullable().optional(),maxScore:z.number().positive().nullable().optional(),status:z.enum(['draft','published','closed']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE homework_assignments SET title=COALESCE($1,title),instructions=COALESCE($2,instructions),due_at=CASE WHEN $3 THEN $4::timestamptz ELSE due_at END,max_score=CASE WHEN $5 THEN $6 ELSE max_score END,status=COALESCE($7,status),updated_at=now() WHERE id=$8 RETURNING *`,[b.title??null,b.instructions??null,Object.hasOwn(b,'dueAt'),b.dueAt??null,Object.hasOwn(b,'maxScore'),b.maxScore??null,b.status??null,id]);
  return row;
});
app.post('/api/homework/:id/publish',async request=>{
  const a=await authorize(request,db,config,'assessment.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  return tx(db,async c=>{const row=await one<any>(c,"UPDATE homework_assignments SET status='published',updated_at=now() WHERE id=$1 RETURNING *",[id]);await c.query(`INSERT INTO homework_submissions(homework_id,student_id) SELECT $1,e.student_id FROM enrolments e WHERE e.classroom_id=$2 AND e.status='active' ON CONFLICT(homework_id,student_id) DO NOTHING`,[id,h.classroom_id]);await audit(a.core.organisation_id,a.core.id,'homework.published','homework',id);return row});
});
app.get('/api/homework/:id/submissions',async request=>{
  const a=await authorize(request,db,config);const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  return (await db.query(`SELECT hs.*,s.admission_no,s.first_name,s.last_name FROM homework_submissions hs JOIN students s ON s.id=hs.student_id WHERE hs.homework_id=$1 ORDER BY s.last_name,s.first_name`,[id])).rows;
});
app.post('/api/homework/:id/submissions',async request=>{
  const a=await authorize(request,db,config,'assessment.score');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  const b=z.object({records:z.array(z.object({studentId:z.string().uuid(),status:z.enum(['not_submitted','submitted','late','graded']),score:z.number().min(0).nullable().optional(),teacherComment:z.string().max(1000).nullable().optional()})).min(1).max(200)}).parse(request.body);
  for(const r of b.records)if(r.score!=null&&h.max_score!=null&&r.score>Number(h.max_score))throw fail(400,`Homework score cannot exceed ${h.max_score}`);
  await tx(db,async c=>{for(const r of b.records)await c.query(`INSERT INTO homework_submissions(homework_id,student_id,status,submitted_at,score,teacher_comment) VALUES($1,$2,$3,CASE WHEN $3 IN('submitted','late','graded') THEN now() ELSE NULL END,$4,$5) ON CONFLICT(homework_id,student_id) DO UPDATE SET status=EXCLUDED.status,submitted_at=COALESCE(homework_submissions.submitted_at,EXCLUDED.submitted_at),score=EXCLUDED.score,teacher_comment=EXCLUDED.teacher_comment,updated_at=now()`,[id,r.studentId,r.status,r.score??null,r.teacherComment??null])});return{saved:b.records.length};
});
app.delete('/api/homework/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  await db.query('DELETE FROM homework_assignments WHERE id=$1',[id]);await audit(a.core.organisation_id,a.core.id,'homework.deleted','homework',id);return reply.code(204).send();
});

app.get('/api/announcements',async request=>{
  const a=await authorize(request,db,config);return (await db.query(`SELECT a.*,c.name classroom_name FROM school_announcements a LEFT JOIN classrooms c ON c.id=a.classroom_id WHERE a.organisation_id=$1 ORDER BY a.created_at DESC`,[a.core.organisation_id])).rows;
});
app.post('/api/announcements',async(request,reply)=>{
  const a=await authorize(request,db,config,'communications.manage');const b=z.object({audience:z.enum(['all','staff','parents','students','class']),classroomId:z.string().uuid().nullable().optional(),title:z.string().min(2).max(200),body:z.string().min(1).max(10000),status:z.enum(['draft','published']).default('draft')}).parse(request.body);
  if(b.audience==='class'&&!b.classroomId)throw fail(400,'A classroom is required for class announcements');
  const row=await one<any>(db,`INSERT INTO school_announcements(organisation_id,audience,classroom_id,title,body,status,published_at,created_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='published' THEN now() ELSE NULL END,$7) RETURNING *`,[a.core.organisation_id,b.audience,b.classroomId??null,b.title,b.body,b.status,a.core.id]);await audit(a.core.organisation_id,a.core.id,'announcement.created','announcement',row.id);return reply.code(201).send(row);
});
app.patch('/api/announcements/:id',async request=>{
  const a=await authorize(request,db,config,'communications.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({audience:z.enum(['all','staff','parents','students','class']).optional(),classroomId:z.string().uuid().nullable().optional(),title:z.string().min(2).max(200).optional(),body:z.string().min(1).max(10000).optional(),status:z.enum(['draft','published','archived']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE school_announcements SET audience=COALESCE($1,audience),classroom_id=CASE WHEN $2 THEN $3 ELSE classroom_id END,title=COALESCE($4,title),body=COALESCE($5,body),status=COALESCE($6,status),published_at=CASE WHEN $6='published' AND published_at IS NULL THEN now() WHEN $6 IS NULL THEN published_at ELSE published_at END,updated_at=now() WHERE id=$7 AND organisation_id=$8 RETURNING *`,[b.audience??null,Object.hasOwn(b,'classroomId'),b.classroomId??null,b.title??null,b.body??null,b.status??null,id,a.core.organisation_id]);return row;
});
app.delete('/api/announcements/:id',async(request,reply)=>{const a=await authorize(request,db,config,'communications.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);await one<any>(db,'DELETE FROM school_announcements WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);return reply.code(204).send()});

app.get('/api/report-comments/:studentId',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const q=z.object({termId:z.string().uuid()}).parse(request.query);
  return (await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,q.termId]))??null;
});
app.put('/api/report-comments/:studentId',async request=>{
  const a=await authorize(request,db,config,'reports.edit');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const b=z.object({
    termId:z.string().uuid(),
    classTeacherComment:z.string().max(4000).nullable().optional(),
    conduct:z.string().max(80).nullable().optional(),
    interest:z.string().max(1000).nullable().optional(),
    nextTermBegins:z.string().date().nullable().optional()
  }).parse(request.body);
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[b.termId,a.core.organisation_id]);
  const current=await one<any>(db,`SELECT c.id classroom_id,c.class_teacher_os_user_id
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 AND e.organisation_id=$3
    ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id,a.core.organisation_id]);
  await ensureTeacherScope(a,current.classroom_id,null);
  if(a.role==='teacher'&&current.class_teacher_os_user_id!==a.core.id)throw fail(403,'Only the assigned class teacher can complete report remarks for this class');
  const existing=await maybeOne<any>(db,'SELECT workflow_status FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,b.termId]);
  if(existing?.workflow_status==='submitted'||existing?.workflow_status==='approved')throw fail(409,'This report is already submitted for review. Return it to the class teacher before editing.');
  const row=await one<any>(db,`INSERT INTO report_comments(
      organisation_id,student_id,term_id,class_teacher_comment,conduct,interest,next_term_begins,updated_by_os_user_id,workflow_status
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft')
    ON CONFLICT(student_id,term_id) DO UPDATE SET
      class_teacher_comment=EXCLUDED.class_teacher_comment,conduct=EXCLUDED.conduct,interest=EXCLUDED.interest,
      next_term_begins=EXCLUDED.next_term_begins,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,
      workflow_status=CASE WHEN report_comments.workflow_status='returned' THEN 'draft' ELSE report_comments.workflow_status END,
      return_note=NULL,updated_at=now()
    RETURNING *`,[
      a.core.organisation_id,studentId,b.termId,b.classTeacherComment??null,b.conduct??null,b.interest??null,b.nextTermBegins??null,a.core.id
    ]);
  await audit(a.core.organisation_id,a.core.id,'report.remarks_saved','report_comment',row.id,{studentId,termId:b.termId});
  return row;
});
app.post('/api/report-comments/:studentId/submit',async request=>{
  const a=await authorize(request,db,config,'reports.submit');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const b=z.object({termId:z.string().uuid()}).parse(request.body);
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[b.termId,a.core.organisation_id]);
  const current=await one<any>(db,`SELECT c.id classroom_id,c.class_teacher_os_user_id
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 AND e.organisation_id=$3
    ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id,a.core.organisation_id]);
  await ensureTeacherScope(a,current.classroom_id,null);
  if(a.role==='teacher'&&current.class_teacher_os_user_id!==a.core.id)throw fail(403,'Only the assigned class teacher can submit this report');
  const report=await one<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,b.termId]);
  if(!report.class_teacher_comment)throw fail(409,'Enter the class teacher remark before submitting the report');
  if(!['draft','returned'].includes(report.workflow_status))throw fail(409,'Only draft or returned reports can be submitted');
  const updated=await one<any>(db,`UPDATE report_comments SET workflow_status='submitted',submitted_by_os_user_id=$1,submitted_at=now(),
    return_note=NULL,updated_at=now() WHERE id=$2 RETURNING *`,[a.core.id,report.id]);
  await audit(a.core.organisation_id,a.core.id,'report.submitted','report_comment',report.id,{studentId,termId:b.termId,classroomId:current.classroom_id});
  return updated;
});
app.get('/api/report-review-queue',async request=>{
  const a=await authorize(request,db,config,'reports.approve');
  const q=z.object({status:z.enum(['submitted','approved','returned']).optional(),termId:z.string().uuid().optional()}).parse(request.query);
  let rows=(await db.query(`SELECT rc.*,s.admission_no,s.first_name,s.last_name,c.id classroom_id,c.name classroom_name,t.name term_name,y.name academic_year,
      c.class_teacher_os_user_id
    FROM report_comments rc
    JOIN students s ON s.id=rc.student_id
    JOIN terms t ON t.id=rc.term_id JOIN academic_years y ON y.id=t.academic_year_id
    JOIN enrolments e ON e.student_id=s.id AND e.academic_year_id=t.academic_year_id
    JOIN classrooms c ON c.id=e.classroom_id
    WHERE rc.organisation_id=$1 AND ($2::text IS NULL OR rc.workflow_status=$2) AND ($3::uuid IS NULL OR rc.term_id=$3)
    ORDER BY CASE rc.workflow_status WHEN 'submitted' THEN 0 WHEN 'returned' THEN 1 ELSE 2 END,rc.updated_at DESC`,
    [a.core.organisation_id,q.status??null,q.termId??null])).rows;
  if(a.role!=='school_admin'&&a.role!=='headteacher'){
    const assigned=(await db.query('SELECT classroom_id FROM report_reviewer_assignments WHERE organisation_id=$1 AND reviewer_os_user_id=$2 AND is_active=true',[a.core.organisation_id,a.core.id])).rows.map((x:any)=>x.classroom_id);
    rows=rows.filter((r:any)=>assigned.includes(r.classroom_id));
  }
  return rows;
});
app.post('/api/report-comments/:studentId/review',async request=>{
  const a=await authorize(request,db,config,'reports.approve');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const b=z.object({
    termId:z.string().uuid(),
    action:z.enum(['approve','return']),
    headteacherComment:z.string().max(4000).nullable().optional(),
    returnNote:z.string().max(2000).nullable().optional(),
    nextTermBegins:z.string().date().nullable().optional()
  }).parse(request.body);
  const report=await one<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,b.termId]);
  if(report.workflow_status!=='submitted')throw fail(409,'Only submitted reports can be reviewed');
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1',[b.termId]);
  const current=await one<any>(db,`SELECT c.id classroom_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id]);
  if(a.role!=='school_admin'&&a.role!=='headteacher'){
    const assignment=await maybeOne<any>(db,'SELECT 1 FROM report_reviewer_assignments WHERE organisation_id=$1 AND classroom_id=$2 AND reviewer_os_user_id=$3 AND is_active=true',[a.core.organisation_id,current.classroom_id,a.core.id]);
    if(!assignment)throw fail(403,'You are not assigned to review reports for this class');
  }
  if(b.action==='return'&&!b.returnNote)throw fail(400,'Give the class teacher a reason for returning the report');
  const status=b.action==='approve'?'approved':'returned';
  const updated=await one<any>(db,`UPDATE report_comments SET workflow_status=$1,
      headteacher_comment=CASE WHEN $1='approved' THEN $2 ELSE headteacher_comment END,
      next_term_begins=CASE WHEN $1='approved' AND $3 THEN $4::date ELSE next_term_begins END,
      return_note=CASE WHEN $1='returned' THEN $5 ELSE NULL END,
      reviewed_by_os_user_id=$6,reviewed_at=now(),updated_at=now()
    WHERE id=$7 RETURNING *`,[
      status,b.headteacherComment??null,Object.hasOwn(b,'nextTermBegins'),b.nextTermBegins??null,b.returnNote??null,a.core.id,report.id
    ]);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1',[studentId]);
  const guardian=await maybeOne<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id
    WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC LIMIT 1`,[studentId]);
  if(guardian&&status==='approved'){
    await notifyContact({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'reports.approved',
      name:guardian.first_name+' '+guardian.last_name,email:guardian.email,phone:guardian.phone,
      subject:'Student report card approved',
      body:`The report card for ${student.first_name} ${student.last_name} has been approved and is now available in the Parent Portal.`,
      relatedType:'report_comment',relatedId:report.id
    });
  }
  await audit(a.core.organisation_id,a.core.id,'report.'+status,'report_comment',report.id,{studentId,termId:b.termId});
  return updated;
});
app.get('/api/report-reviewers',async request=>{
  const a=await authorize(request,db,config,'staff.view');
  return (await db.query(`SELECT rra.*,c.name classroom_name FROM report_reviewer_assignments rra
    JOIN classrooms c ON c.id=rra.classroom_id WHERE rra.organisation_id=$1 ORDER BY c.name,rra.created_at`,[a.core.organisation_id])).rows;
});
app.post('/api/report-reviewers',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.edit');
  const b=z.object({classroomId:z.string().uuid(),reviewerOsUserId:z.string().uuid(),isActive:z.boolean().default(true)}).parse(request.body);
  const row=await one<any>(db,`INSERT INTO report_reviewer_assignments(organisation_id,classroom_id,reviewer_os_user_id,is_active)
    VALUES($1,$2,$3,$4) ON CONFLICT(organisation_id,classroom_id,reviewer_os_user_id)
    DO UPDATE SET is_active=EXCLUDED.is_active RETURNING *`,[a.core.organisation_id,b.classroomId,b.reviewerOsUserId,b.isActive]);
  await audit(a.core.organisation_id,a.core.id,'report_reviewer.assigned','report_reviewer_assignment',row.id,{classroomId:b.classroomId,reviewerOsUserId:b.reviewerOsUserId});
  return reply.code(201).send(row);
});

app.get('/api/promotions/preview',async request=>{
  const a=await authorize(request,db,config,'promotion.manage');
  const q=z.object({
    fromAcademicYearId:z.string().uuid(),
    toAcademicYearId:z.string().uuid(),
    classroomId:z.string().uuid()
  }).parse(request.query);
  const classroom=await one<any>(db,`SELECT c.*,g.level_order,g.name grade_name,g.code grade_code
    FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.id=$1 AND c.academic_year_id=$2 AND c.organisation_id=$3`,
    [q.classroomId,q.fromAcademicYearId,a.core.organisation_id]);
  const nextGrade=await maybeOne<any>(db,`SELECT * FROM grade_levels WHERE organisation_id=$1 AND is_active=true AND level_order>$2
    ORDER BY level_order LIMIT 1`,[a.core.organisation_id,classroom.level_order]);
  const destinations=nextGrade?(await db.query(`SELECT c.id,c.name,c.stream,g.name grade_name,g.code grade_code
    FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.organisation_id=$1 AND c.academic_year_id=$2 AND c.grade_level_id=$3 AND c.is_active=true
    ORDER BY c.name`,[a.core.organisation_id,q.toAcademicYearId,nextGrade.id])).rows:[];
  const repeatDestinations=(await db.query(`SELECT c.id,c.name,c.stream,g.name grade_name,g.code grade_code
    FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.organisation_id=$1 AND c.academic_year_id=$2 AND g.code=$3 AND c.is_active=true ORDER BY c.name`,
    [a.core.organisation_id,q.toAcademicYearId,classroom.grade_code])).rows;
  const students=(await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,s.status,
      e.id enrolment_id,c.name classroom_name,g.name grade_name
    FROM enrolments e JOIN students s ON s.id=e.student_id JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE e.organisation_id=$1 AND e.academic_year_id=$2 AND e.classroom_id=$3 AND e.status='active'
    ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,q.fromAcademicYearId,q.classroomId])).rows;
  return{
    classroom,
    nextGrade,
    defaultOutcome:nextGrade?'promoted':'completed',
    destinations,
    repeatDestinations,
    students
  };
});
app.post('/api/promotions/batch',async request=>{
  const a=await authorize(request,db,config,'promotion.manage');
  const b=z.object({
    fromAcademicYearId:z.string().uuid(),
    toAcademicYearId:z.string().uuid(),
    fromClassroomId:z.string().uuid().optional(),
    records:z.array(z.object({
      studentId:z.string().uuid(),
      toClassroomId:z.string().uuid().nullable().optional(),
      outcome:z.enum(['promoted','repeated','completed'])
    })).min(1).max(300)
  }).parse(request.body);
  if(b.fromAcademicYearId===b.toAcademicYearId)throw fail(400,'Choose a different destination academic year');
  return tx(db,async client=>{
    const batch=await one<any>(client,`INSERT INTO promotion_batches(
      organisation_id,from_academic_year_id,to_academic_year_id,from_classroom_id,processed_by_os_user_id,total_students
    ) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[
      a.core.organisation_id,b.fromAcademicYearId,b.toAcademicYearId,b.fromClassroomId??null,a.core.id,b.records.length
    ]);
    let processed=0,promoted=0,repeated=0,completed=0;
    for(const r of b.records){
      const old=await maybeOne<any>(client,`SELECT e.*,c.grade_level_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
        WHERE e.student_id=$1 AND e.academic_year_id=$2 AND e.organisation_id=$3 AND e.status='active' FOR UPDATE`,
        [r.studentId,b.fromAcademicYearId,a.core.organisation_id]);
      if(!old)throw fail(409,'One or more selected students no longer have an active enrolment in the source year');
      if(b.fromClassroomId&&old.classroom_id!==b.fromClassroomId)throw fail(409,'A selected student is no longer in the source class');
      if(r.outcome!=='completed'){
        if(!r.toClassroomId)throw fail(400,'A destination class is required for promoted or repeated students');
        const dest=await one<any>(client,`SELECT c.*,g.level_order FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
          WHERE c.id=$1 AND c.organisation_id=$2 AND c.academic_year_id=$3 AND c.is_active=true`,
          [r.toClassroomId,a.core.organisation_id,b.toAcademicYearId]);
        if(r.outcome==='repeated'&&dest.grade_level_id!==old.grade_level_id)throw fail(400,'A repeated student must remain in the same grade level');
      }
      if(r.outcome==='completed'){
        await client.query("UPDATE enrolments SET status='completed' WHERE id=$1",[old.id]);
        await client.query("UPDATE students SET status='graduated',updated_at=now() WHERE id=$1",[r.studentId]);
        completed++;
      }else{
        await client.query("UPDATE enrolments SET status=$1 WHERE id=$2",[r.outcome==='promoted'?'promoted':'repeated',old.id]);
        await client.query(`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status)
          VALUES($1,$2,$3,$4,'active')
          ON CONFLICT(student_id,academic_year_id)
          DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status='active',enrolled_at=now()`,
          [a.core.organisation_id,r.studentId,b.toAcademicYearId,r.toClassroomId]);
        await client.query("UPDATE students SET status='active',updated_at=now() WHERE id=$1",[r.studentId]);
        if(r.outcome==='promoted')promoted++;else repeated++;
      }
      await client.query(`INSERT INTO student_promotions(
        organisation_id,student_id,from_academic_year_id,to_academic_year_id,from_classroom_id,to_classroom_id,outcome,processed_by_os_user_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(student_id,to_academic_year_id)
      DO UPDATE SET from_classroom_id=EXCLUDED.from_classroom_id,to_classroom_id=EXCLUDED.to_classroom_id,
        outcome=EXCLUDED.outcome,processed_by_os_user_id=EXCLUDED.processed_by_os_user_id,created_at=now()`,
        [a.core.organisation_id,r.studentId,b.fromAcademicYearId,b.toAcademicYearId,old.classroom_id,r.toClassroomId??null,r.outcome,a.core.id]);
      processed++;
    }
    await client.query(`UPDATE promotion_batches SET promoted_count=$1,repeated_count=$2,completed_count=$3 WHERE id=$4`,
      [promoted,repeated,completed,batch.id]);
    await audit(a.core.organisation_id,a.core.id,'students.promoted','promotion_batch',batch.id,{processed,promoted,repeated,completed});
    return{batchId:batch.id,processed,promoted,repeated,completed};
  });
});
app.get('/api/promotions',async request=>{const a=await authorize(request,db,config,'reports.view');return (await db.query(`SELECT p.*,s.admission_no,s.first_name,s.last_name,fc.name from_class,tc.name to_class,fy.name from_year,ty.name to_year FROM student_promotions p JOIN students s ON s.id=p.student_id LEFT JOIN classrooms fc ON fc.id=p.from_classroom_id LEFT JOIN classrooms tc ON tc.id=p.to_classroom_id JOIN academic_years fy ON fy.id=p.from_academic_year_id JOIN academic_years ty ON ty.id=p.to_academic_year_id WHERE p.organisation_id=$1 ORDER BY p.created_at DESC`,[a.core.organisation_id])).rows});

app.post('/api/guardians/:id/portal-reset',async request=>{
  const a=await authorize(request,db,config,'portals.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const guardian=await maybeOne<any>(db,'SELECT * FROM guardians WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!guardian)throw fail(404,'Guardian not found');
  const pin=String(randomInt(100000,1000000));
  await db.query(`INSERT INTO guardian_portal_access(guardian_id,pin_hash,is_active) VALUES($1,$2,true) ON CONFLICT(guardian_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash,is_active=true,updated_at=now()`,[id,hashPortalPin(pin)]);
  await db.query('UPDATE guardian_portal_sessions SET revoked_at=now() WHERE guardian_id=$1 AND revoked_at IS NULL',[id]);
  await audit(a.core.organisation_id,a.core.id,'guardian.portal_pin_reset','guardian',id);
  return{guardianId:id,pin};
});

app.post('/api/parent/login',async request=>{
  const b=z.object({phone:z.string().min(5).max(60),admissionNo:z.string().min(1).max(60),pin:z.string().regex(/^\d{6}$/)}).parse(request.body);
  const row=await maybeOne<any>(db,`SELECT g.*,gpa.pin_hash,gpa.is_active FROM guardians g JOIN guardian_portal_access gpa ON gpa.guardian_id=g.id JOIN student_guardians sg ON sg.guardian_id=g.id JOIN students s ON s.id=sg.student_id WHERE g.phone=$1 AND s.admission_no=$2 LIMIT 1`,[b.phone,b.admissionNo]);
  if(!row||!row.is_active||!verifyPortalPin(b.pin,row.pin_hash))throw fail(401,'Invalid parent portal credentials');
  const token=randomBytes(48).toString('base64url');
  await db.query(`INSERT INTO guardian_portal_sessions(guardian_id,token_hash,expires_at) VALUES($1,$2,now()+interval '8 hours')`,[row.id,hashPortalToken(token)]);
  await db.query('UPDATE guardian_portal_access SET last_login_at=now() WHERE guardian_id=$1',[row.id]);
  return{token,expiresIn:28800};
});
app.post('/api/parent/logout',async request=>{const g=await guardianAuth(request);await db.query('UPDATE guardian_portal_sessions SET revoked_at=now() WHERE id=$1',[g.session_id]);return{ok:true}});
app.get('/api/parent/me',async request=>{
  const g=await guardianAuth(request);
  const students=(await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,s.status,c.name classroom_name FROM student_guardians sg JOIN students s ON s.id=sg.student_id LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active' LEFT JOIN classrooms c ON c.id=e.classroom_id WHERE sg.guardian_id=$1 ORDER BY s.first_name,s.last_name`,[g.guardian_id])).rows;
  const school=await one<any>(db,'SELECT school_name,short_name,motto,phone,email,address FROM school_profiles WHERE organisation_id=$1',[g.organisation_id]);
  return{guardian:g,students,school};
});
app.get('/api/parent/students/:id/dashboard',async request=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);const student=await ensureGuardianStudent(g.guardian_id,id);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.name classroom_name,g.name grade_name,e.academic_year_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id WHERE e.student_id=$1 AND e.status='active' ORDER BY e.enrolled_at DESC LIMIT 1`,[id]);
  Object.assign(student,current||{});
  const fee=await one<any>(db,`SELECT COALESCE(sum((sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0)),0) outstanding FROM student_fees sf WHERE sf.organisation_id=$1 AND sf.student_id=$2`,[g.organisation_id,id]);
  const attRows=(await db.query('SELECT status,count(*)::int count FROM attendance_records WHERE organisation_id=$1 AND student_id=$2 GROUP BY status',[g.organisation_id,id])).rows;const attendance:any={};for(const x of attRows)attendance[x.status]=x.count;
  const homework=current?(await db.query(`SELECT h.id,h.title,h.instructions,h.due_at,h.status,s.name subject_name,hs.status submission_status,hs.score FROM homework_assignments h JOIN subjects s ON s.id=h.subject_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$2 WHERE h.organisation_id=$1 AND h.classroom_id=$3 AND h.status='published' ORDER BY h.due_at DESC NULLS LAST LIMIT 20`,[g.organisation_id,id,current.classroom_id])).rows:[];
  const announcements=(await db.query(`SELECT a.title,a.body,a.audience,a.published_at FROM school_announcements a WHERE a.organisation_id=$1 AND a.status='published' AND (a.audience IN('all','parents') OR (a.audience='class' AND a.classroom_id=$2)) ORDER BY a.published_at DESC LIMIT 20`,[g.organisation_id,current?.classroom_id??null])).rows;
  return{student,fees:fee,attendance,homework,announcements};
});
app.get('/api/parent/students/:id/fees',async request=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);await ensureGuardianStudent(g.guardian_id,id);
  const items=(await db.query(`SELECT sf.id,f.name fee_name,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid,((sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0)) balance,sf.status FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.organisation_id=$1 AND sf.student_id=$2 GROUP BY sf.id,f.id ORDER BY sf.created_at DESC`,[g.organisation_id,id])).rows;
  const payments=(await db.query('SELECT id,amount,payment_method,reference,paid_at,note FROM payments WHERE organisation_id=$1 AND student_id=$2 AND voided_at IS NULL ORDER BY paid_at DESC',[g.organisation_id,id])).rows;return{items,payments};
});
app.get('/api/parent/students/:id/latest-report',async request=>{
  const g=await guardianAuth(request);
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await ensureGuardianStudent(g.guardian_id,id);
  const approved=await maybeOne<any>(db,`SELECT rc.*,t.name term_name,t.id term_id,t.academic_year_id
    FROM report_comments rc JOIN terms t ON t.id=rc.term_id
    WHERE rc.organisation_id=$1 AND rc.student_id=$2 AND rc.workflow_status='approved'
    ORDER BY rc.reviewed_at DESC NULLS LAST,rc.updated_at DESC LIMIT 1`,[g.organisation_id,id]);
  if(!approved)return{available:false,term:null,subjects:[],comments:null};
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1',[approved.term_id]);
  const subjects=await calculateStudentTermResults(g.organisation_id,id,term.id);
  return{available:true,term,subjects,comments:approved};
});

app.get('/api/payments/:id/receipt',async request=>{
  const a=await authorize(request,db,config,'fees.view');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const payment=await one<any>(db,`SELECT p.*,s.admission_no,s.first_name,s.last_name,f.name fee_name,sp.school_name,sp.phone school_phone,sp.email school_email,sp.address school_address FROM payments p JOIN students s ON s.id=p.student_id LEFT JOIN student_fees sf ON sf.id=p.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id JOIN school_profiles sp ON sp.organisation_id=p.organisation_id WHERE p.id=$1 AND p.organisation_id=$2`,[id,a.core.organisation_id]);return payment;
});


app.get('/api/teacher/context',async request=>{
  const a=await authorize(request,db,config);
  if(!['teacher','headteacher','school_admin'].includes(a.role))throw fail(403,'Teacher portal access is not enabled for this school role');
  const school=await one<any>(db,'SELECT * FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  return{core:a.core,schoolRole:a.role,school};
});
app.get('/api/teacher/classes',async request=>{
  const a=await authorize(request,db,config);
  if(!['teacher','headteacher','school_admin'].includes(a.role))throw fail(403,'Teacher portal access is not enabled for this school role');
  if(a.role==='teacher'){
    return (await db.query(`SELECT DISTINCT c.id classroom_id,c.name classroom_name,g.name grade_name,ta.subject_id,s.name subject_name,
      (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=c.id AND e.status='active') student_count
      FROM classrooms c
      JOIN grade_levels g ON g.id=c.grade_level_id
      LEFT JOIN teacher_assignments ta ON ta.classroom_id=c.id AND ta.organisation_id=c.organisation_id AND ta.teacher_os_user_id=$2 AND ta.is_active=true
      LEFT JOIN subjects s ON s.id=ta.subject_id
      WHERE c.organisation_id=$1 AND c.is_active=true AND (c.class_teacher_os_user_id=$2 OR ta.id IS NOT NULL)
      ORDER BY c.name,s.name NULLS FIRST`,[a.core.organisation_id,a.core.id])).rows;
  }
  return (await db.query(`SELECT c.id classroom_id,c.name classroom_name,g.name grade_name,NULL::uuid subject_id,NULL::text subject_name,
    (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=c.id AND e.status='active') student_count
    FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.organisation_id=$1 AND c.is_active=true ORDER BY g.level_order,c.name`,[a.core.organisation_id])).rows;
});
app.get('/api/teacher/students',async request=>{
  const a=await authorize(request,db,config);
  if(!['teacher','headteacher','school_admin'].includes(a.role))throw fail(403,'Teacher portal access is not enabled for this school role');
  if(a.role==='teacher'){
    return (await db.query(`SELECT DISTINCT s.id,s.admission_no,s.first_name,s.last_name,s.status,c.id classroom_id,c.name classroom_name,g.name grade_name
      FROM enrolments e
      JOIN students s ON s.id=e.student_id
      JOIN classrooms c ON c.id=e.classroom_id
      JOIN grade_levels g ON g.id=c.grade_level_id
      LEFT JOIN teacher_assignments ta ON ta.classroom_id=c.id AND ta.organisation_id=c.organisation_id AND ta.teacher_os_user_id=$2 AND ta.is_active=true
      WHERE e.organisation_id=$1 AND e.status='active' AND (c.class_teacher_os_user_id=$2 OR ta.id IS NOT NULL)
      ORDER BY c.name,s.last_name,s.first_name`,[a.core.organisation_id,a.core.id])).rows;
  }
  return (await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,s.status,c.id classroom_id,c.name classroom_name,g.name grade_name
    FROM enrolments e JOIN students s ON s.id=e.student_id JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE e.organisation_id=$1 AND e.status='active' ORDER BY c.name,s.last_name,s.first_name`,[a.core.organisation_id])).rows;
});
app.get('/api/teacher/dashboard',async request=>{
  const a=await authorize(request,db,config);
  if(!['teacher','headteacher','school_admin'].includes(a.role))throw fail(403,'Teacher portal access is not enabled for this school role');
  const term=await activeTerm(a.core.organisation_id);
  let classIds:string[]=[];
  if(a.role==='teacher'){
    classIds=(await db.query(`SELECT DISTINCT c.id FROM classrooms c LEFT JOIN teacher_assignments ta ON ta.classroom_id=c.id AND ta.teacher_os_user_id=$2 AND ta.is_active=true WHERE c.organisation_id=$1 AND c.is_active=true AND (c.class_teacher_os_user_id=$2 OR ta.id IS NOT NULL)`,[a.core.organisation_id,a.core.id])).rows.map((x:any)=>x.id);
  }else{
    classIds=(await db.query('SELECT id FROM classrooms WHERE organisation_id=$1 AND is_active=true',[a.core.organisation_id])).rows.map((x:any)=>x.id);
  }
  if(!classIds.length)return{assignedClasses:0,students:0,homework:0,assessments:0,presentToday:0,absentToday:0,term};
  const q=await db.query(`SELECT
    (SELECT count(DISTINCT e.student_id)::int FROM enrolments e WHERE e.classroom_id=ANY($1::uuid[]) AND e.status='active') students,
    (SELECT count(*)::int FROM homework_assignments h WHERE h.classroom_id=ANY($1::uuid[]) AND h.status<>'closed') homework,
    (SELECT count(*)::int FROM assessments a WHERE a.classroom_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR a.term_id=$2)) assessments,
    (SELECT count(*)::int FROM attendance_records ar WHERE ar.classroom_id=ANY($1::uuid[]) AND ar.attendance_date=current_date AND ar.status='present') present_today,
    (SELECT count(*)::int FROM attendance_records ar WHERE ar.classroom_id=ANY($1::uuid[]) AND ar.attendance_date=current_date AND ar.status='absent') absent_today`,[classIds,term?.id??null]);
  return{assignedClasses:classIds.length,students:q.rows[0]?.students??0,homework:q.rows[0]?.homework??0,assessments:q.rows[0]?.assessments??0,presentToday:q.rows[0]?.present_today??0,absentToday:q.rows[0]?.absent_today??0,term};
});

app.post('/api/students/:id/portal-reset',async request=>{
  const a=await authorize(request,db,config,'portals.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const student=await maybeOne<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!student)throw fail(404,'Student not found');
  const pin=String(randomInt(100000,1000000));
  await db.query(`INSERT INTO student_portal_access(student_id,pin_hash,is_active) VALUES($1,$2,true)
    ON CONFLICT(student_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash,is_active=true,updated_at=now()`,[id,hashPortalPin(pin)]);
  await db.query('UPDATE student_portal_sessions SET revoked_at=now() WHERE student_id=$1 AND revoked_at IS NULL',[id]);
  await audit(a.core.organisation_id,a.core.id,'student.portal_pin_reset','student',id);
  return{studentId:id,pin};
});
app.post('/api/student/login',async request=>{
  const b=z.object({admissionNo:z.string().min(1).max(60),pin:z.string().regex(/^\d{6}$/)}).parse(request.body);
  const row=await maybeOne<any>(db,`SELECT s.*,spa.pin_hash,spa.is_active FROM students s JOIN student_portal_access spa ON spa.student_id=s.id WHERE s.admission_no=$1 AND s.status='active' LIMIT 1`,[b.admissionNo]);
  if(!row||!row.is_active||!verifyPortalPin(b.pin,row.pin_hash))throw fail(401,'Invalid student portal credentials');
  const token=randomBytes(48).toString('base64url');
  await db.query(`INSERT INTO student_portal_sessions(student_id,token_hash,expires_at) VALUES($1,$2,now()+interval '8 hours')`,[row.id,hashPortalToken(token)]);
  await db.query('UPDATE student_portal_access SET last_login_at=now() WHERE student_id=$1',[row.id]);
  return{token,expiresIn:28800};
});
app.post('/api/student/logout',async request=>{const s=await studentAuth(request);await db.query('UPDATE student_portal_sessions SET revoked_at=now() WHERE id=$1',[s.session_id]);return{ok:true}});
app.get('/api/student/me',async request=>{
  const s=await studentAuth(request);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.name classroom_name,g.name grade_name,e.academic_year_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id WHERE e.student_id=$1 AND e.status='active' ORDER BY e.enrolled_at DESC LIMIT 1`,[s.student_id]);
  const student={...s,...(current||{})};
  const school=await one<any>(db,'SELECT school_name,short_name,motto,phone,email,address FROM school_profiles WHERE organisation_id=$1',[s.organisation_id]);
  const attRows=(await db.query('SELECT status,count(*)::int count FROM attendance_records WHERE organisation_id=$1 AND student_id=$2 GROUP BY status',[s.organisation_id,s.student_id])).rows;const attendance:any={};for(const x of attRows)attendance[x.status]=x.count;
  const homework=current?(await db.query(`SELECT h.id,h.title,h.instructions,h.due_at,h.status,sub.name subject_name,hs.status submission_status,hs.score FROM homework_assignments h JOIN subjects sub ON sub.id=h.subject_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$2 WHERE h.organisation_id=$1 AND h.classroom_id=$3 AND h.status='published' ORDER BY h.due_at DESC NULLS LAST LIMIT 30`,[s.organisation_id,s.student_id,current.classroom_id])).rows:[];
  const timetable=current?(await db.query(`SELECT tt.*,sub.name subject_name FROM timetable_entries tt JOIN subjects sub ON sub.id=tt.subject_id WHERE tt.organisation_id=$1 AND tt.classroom_id=$2 ORDER BY tt.day_of_week,tt.start_time`,[s.organisation_id,current.classroom_id])).rows:[];
  const announcements=(await db.query(`SELECT title,body,published_at FROM school_announcements WHERE organisation_id=$1 AND status='published' AND (audience IN('all','students') OR (audience='class' AND classroom_id=$2)) ORDER BY published_at DESC LIMIT 30`,[s.organisation_id,current?.classroom_id??null])).rows;
  return{student,school,attendance,homework,timetable,announcements};
});
app.get('/api/student/latest-report',async request=>{
  const s=await studentAuth(request);
  const approved=await maybeOne<any>(db,`SELECT rc.*,t.id term_id FROM report_comments rc
    JOIN terms t ON t.id=rc.term_id
    WHERE rc.organisation_id=$1 AND rc.student_id=$2 AND rc.workflow_status='approved'
    ORDER BY rc.reviewed_at DESC NULLS LAST,rc.updated_at DESC LIMIT 1`,[s.organisation_id,s.student_id]);
  if(!approved)return{available:false,term:null,subjects:[],comments:null};
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1',[approved.term_id]);
  const subjects=await calculateStudentTermResults(s.organisation_id,s.student_id,term.id);
  return{available:true,term,subjects,comments:approved};
});

async function createAdmissionApplication(input:{
  organisationId:string;
  source:'external'|'internal';
  actorOsUserId?:string|null|undefined;
  data:any;
}){
  const b=input.data;
  const grade=await maybeOne<any>(db,'SELECT 1 FROM grade_levels WHERE organisation_id=$1 AND code=$2 AND is_active=true',[input.organisationId,b.requestedGradeCode]);
  if(!grade)throw fail(400,'Requested grade is not available');
  const applicationNo='ADM-'+new Date().getUTCFullYear()+'-'+randomBytes(3).toString('hex').toUpperCase();
  const row=await one<any>(db,`INSERT INTO admission_applications(
      organisation_id,application_no,source,first_name,middle_name,last_name,sex,date_of_birth,requested_grade_code,previous_school,
      guardian_first_name,guardian_last_name,guardian_phone,guardian_alt_phone,guardian_email,guardian_relationship,address,
      emergency_contact_name,emergency_contact_phone,notes
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[
      input.organisationId,applicationNo,input.source,b.firstName,b.middleName??null,b.lastName,b.sex??null,b.dateOfBirth??null,
      b.requestedGradeCode,b.previousSchool??null,b.guardianFirstName,b.guardianLastName,b.guardianPhone,b.guardianAltPhone??null,
      b.guardianEmail??null,b.guardianRelationship,b.address??null,b.emergencyContactName??null,b.emergencyContactPhone??null,b.notes??null
    ]);
  await db.query(`INSERT INTO admission_status_history(organisation_id,application_id,old_status,new_status,note,actor_os_user_id)
    VALUES($1,$2,NULL,'submitted',$3,$4)`,[
      input.organisationId,row.id,input.source==='external'?'Application received through public portal':'Application created internally',input.actorOsUserId??null
    ]);
  const school=await one<any>(db,'SELECT school_name FROM school_profiles WHERE organisation_id=$1',[input.organisationId]);
  await notifyContact({
    organisationId:input.organisationId,actorOsUserId:input.actorOsUserId,eventKey:'admission.received',
    name:b.guardianFirstName+' '+b.guardianLastName,email:b.guardianEmail??null,phone:b.guardianPhone,
    subject:'Admission application received',
    body:`${school.school_name} has received the admission application for ${b.firstName} ${b.lastName}. Application number: ${applicationNo}. You can use this number and the guardian phone number to check the status.`,
    relatedType:'admission_application',relatedId:row.id
  });
  return row;
}

app.get('/api/public/school',async()=>{
  const school=await maybeOne<any>(db,'SELECT organisation_id,school_name,short_name,motto,phone,email,address FROM school_profiles ORDER BY created_at LIMIT 1');
  if(!school)throw fail(404,'School admissions are not configured');
  const grades=(await db.query('SELECT code,name,stage FROM grade_levels WHERE organisation_id=$1 AND is_active=true ORDER BY level_order',[school.organisation_id])).rows;
  return{school,grades};
});
app.post('/api/public/admissions',async(request,reply)=>{
  const school=await maybeOne<any>(db,'SELECT organisation_id FROM school_profiles ORDER BY created_at LIMIT 1');
  if(!school)throw fail(404,'School admissions are not configured');
  const b=z.object({
    firstName:z.string().min(1).max(100),middleName:z.string().max(100).optional(),lastName:z.string().min(1).max(100),
    sex:z.enum(['male','female']).optional(),dateOfBirth:z.string().date().optional(),requestedGradeCode:z.string().min(1).max(20),
    previousSchool:z.string().max(240).optional(),guardianFirstName:z.string().min(1).max(100),guardianLastName:z.string().min(1).max(100),
    guardianPhone:z.string().min(5).max(60),guardianAltPhone:z.string().max(60).optional(),guardianEmail:z.string().email().optional(),
    guardianRelationship:z.string().min(2).max(60),address:z.string().max(2000).optional(),
    emergencyContactName:z.string().max(200).optional(),emergencyContactPhone:z.string().max(60).optional(),notes:z.string().max(5000).optional()
  }).parse(request.body);
  const row=await createAdmissionApplication({organisationId:school.organisation_id,source:'external',data:b});
  return reply.code(201).send({id:row.id,applicationNo:row.application_no,status:row.status});
});
app.get('/api/public/admissions/status',async request=>{
  const q=z.object({applicationNo:z.string().min(1).max(40),phone:z.string().min(5).max(60)}).parse(request.query);
  const row=await maybeOne<any>(db,`SELECT application_no,status,review_note,submitted_at,updated_at
    FROM admission_applications WHERE application_no=$1 AND guardian_phone=$2`,[q.applicationNo,q.phone]);
  if(!row)throw fail(404,'Application not found');
  const history=(await db.query(`SELECT new_status,note,created_at FROM admission_status_history h
    JOIN admission_applications a ON a.id=h.application_id
    WHERE a.application_no=$1 AND a.guardian_phone=$2 ORDER BY h.created_at`,[q.applicationNo,q.phone])).rows;
  return{applicationNo:row.application_no,status:row.status,reviewNote:row.review_note,submittedAt:row.submitted_at,updatedAt:row.updated_at,history};
});
app.get('/api/admissions',async request=>{
  const a=await authorize(request,db,config,'admissions.view');
  const q=z.object({status:z.enum(['submitted','under_review','approved','waitlisted','declined','enrolled']).optional(),source:z.enum(['external','internal']).optional(),q:z.string().max(100).optional()}).parse(request.query);
  const like=q.q?'%'+q.q+'%':null;
  return (await db.query(`SELECT aa.*,gl.name requested_grade_name
    FROM admission_applications aa
    LEFT JOIN grade_levels gl ON gl.organisation_id=aa.organisation_id AND gl.code=aa.requested_grade_code
    WHERE aa.organisation_id=$1 AND ($2::text IS NULL OR aa.status=$2) AND ($3::text IS NULL OR aa.source=$3)
      AND ($4::text IS NULL OR aa.application_no ILIKE $4 OR aa.first_name ILIKE $4 OR aa.last_name ILIKE $4 OR aa.guardian_phone ILIKE $4)
    ORDER BY aa.submitted_at DESC`,[a.core.organisation_id,q.status??null,q.source??null,like])).rows;
});
app.post('/api/admissions/internal',async(request,reply)=>{
  const a=await authorize(request,db,config,'admissions.manage');
  const b=z.object({
    firstName:z.string().min(1).max(100),middleName:z.string().max(100).optional(),lastName:z.string().min(1).max(100),
    sex:z.enum(['male','female']).optional(),dateOfBirth:z.string().date().optional(),requestedGradeCode:z.string().min(1).max(20),
    previousSchool:z.string().max(240).optional(),guardianFirstName:z.string().min(1).max(100),guardianLastName:z.string().min(1).max(100),
    guardianPhone:z.string().min(5).max(60),guardianAltPhone:z.string().max(60).optional(),guardianEmail:z.string().email().optional(),
    guardianRelationship:z.string().min(2).max(60),address:z.string().max(2000).optional(),
    emergencyContactName:z.string().max(200).optional(),emergencyContactPhone:z.string().max(60).optional(),notes:z.string().max(5000).optional()
  }).parse(request.body);
  const row=await createAdmissionApplication({organisationId:a.core.organisation_id,source:'internal',actorOsUserId:a.core.id,data:b});
  await audit(a.core.organisation_id,a.core.id,'admission.created_internal','admission_application',row.id);
  return reply.code(201).send(row);
});
app.get('/api/admissions/:id',async request=>{
  const a=await authorize(request,db,config,'admissions.view');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const application=await one<any>(db,`SELECT aa.*,gl.name requested_grade_name
    FROM admission_applications aa LEFT JOIN grade_levels gl ON gl.organisation_id=aa.organisation_id AND gl.code=aa.requested_grade_code
    WHERE aa.id=$1 AND aa.organisation_id=$2`,[id,a.core.organisation_id]);
  const history=(await db.query('SELECT * FROM admission_status_history WHERE application_id=$1 ORDER BY created_at',[id])).rows;
  const contacts=(await db.query('SELECT * FROM admission_contacts WHERE application_id=$1 ORDER BY created_at DESC',[id])).rows;
  return{application,history,contacts};
});
app.patch('/api/admissions/:id',async request=>{
  const a=await authorize(request,db,config,'admissions.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    status:z.enum(['submitted','under_review','approved','waitlisted','declined']),
    reviewNote:z.string().max(5000).nullable().optional(),
    assignedReviewerOsUserId:z.string().uuid().nullable().optional()
  }).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(current.status==='enrolled')throw fail(409,'An enrolled application cannot be moved back into review');
  const row=await one<any>(db,`UPDATE admission_applications SET status=$1,
      review_note=CASE WHEN $2 THEN $3 ELSE review_note END,
      assigned_reviewer_os_user_id=CASE WHEN $4 THEN $5 ELSE assigned_reviewer_os_user_id END,
      reviewed_by_os_user_id=$6,reviewed_at=now(),updated_at=now()
    WHERE id=$7 AND organisation_id=$8 RETURNING *`,[
      b.status,Object.hasOwn(b,'reviewNote'),b.reviewNote??null,Object.hasOwn(b,'assignedReviewerOsUserId'),b.assignedReviewerOsUserId??null,
      a.core.id,id,a.core.organisation_id
    ]);
  if(current.status!==row.status){
    await db.query(`INSERT INTO admission_status_history(organisation_id,application_id,old_status,new_status,note,actor_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[a.core.organisation_id,id,current.status,row.status,b.reviewNote??null,a.core.id]);
    await notifyContact({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'admission.status_changed',
      name:row.guardian_first_name+' '+row.guardian_last_name,email:row.guardian_email,phone:row.guardian_phone,
      subject:'Admission application status updated',
      body:`Admission application ${row.application_no} for ${row.first_name} ${row.last_name} is now ${row.status.replace('_',' ')}.${row.review_note?' Note: '+row.review_note:''}`,
      relatedType:'admission_application',relatedId:id
    });
  }
  await audit(a.core.organisation_id,a.core.id,'admission.reviewed','admission_application',id,{status:b.status});
  return row;
});
app.post('/api/admissions/:id/contact',async(request,reply)=>{
  const a=await authorize(request,db,config,'communications.send');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({method:z.enum(['call','email','sms','whatsapp']),subject:z.string().max(300).optional(),message:z.string().max(5000).optional(),note:z.string().max(2000).optional()}).parse(request.body);
  const application=await one<any>(db,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const recipient=b.method==='email'?application.guardian_email:application.guardian_phone;
  if(!recipient)throw fail(409,b.method==='email'?'Guardian email is not available':'Guardian phone number is not available');
  let status='initiated';
  if(b.method!=='call'){
    const result=await deliverCommunication({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,channel:b.method,
      recipientName:application.guardian_first_name+' '+application.guardian_last_name,recipientAddress:recipient,
      subject:b.subject||'Admission application '+application.application_no,
      body:b.message||('Regarding admission application '+application.application_no),
      templateKey:'admission.contact',relatedType:'admission_application',relatedId:id
    });
    status=result.status==='sent'?'sent':result.status==='failed'?'failed':'initiated';
  }
  const contact=await one<any>(db,`INSERT INTO admission_contacts(organisation_id,application_id,method,recipient,note,status,actor_os_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[a.core.organisation_id,id,b.method,recipient,b.note??b.message??null,status,a.core.id]);
  await audit(a.core.organisation_id,a.core.id,'admission.contact_'+b.method,'admission_application',id,{recipient});
  return reply.code(201).send({contact,callUri:b.method==='call'?'tel:'+normalizePhone(recipient):null});
});
app.post('/api/admissions/:id/enrol',async(request,reply)=>{
  const a=await authorize(request,db,config,'admissions.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({admissionNo:z.string().min(1).max(60).optional(),classroomId:z.string().uuid()}).parse(request.body);
  const result=await tx(db,async client=>{
    const appRow=await one<any>(client,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
    if(appRow.status!=='approved')throw fail(409,'Approve the application before enrolling the student');
    if(appRow.student_id)throw fail(409,'This application is already linked to a student');
    const count=await one<any>(client,'SELECT count(*)::int n FROM students WHERE organisation_id=$1',[a.core.organisation_id]);
    const admissionNo=b.admissionNo||('RX/'+new Date().getUTCFullYear()+'/'+String(Number(count.n)+1).padStart(4,'0'));
    const student=await one<any>(client,`INSERT INTO students(
      organisation_id,admission_no,first_name,middle_name,last_name,sex,date_of_birth,admission_date,status,notes
    ) VALUES($1,$2,$3,$4,$5,$6,$7,current_date,'active',$8) RETURNING *`,[
      a.core.organisation_id,admissionNo,appRow.first_name,appRow.middle_name,appRow.last_name,appRow.sex,appRow.date_of_birth,appRow.notes
    ]);
    let guardian=await maybeOne<any>(client,'SELECT * FROM guardians WHERE organisation_id=$1 AND phone=$2 ORDER BY created_at LIMIT 1',[a.core.organisation_id,appRow.guardian_phone]);
    if(!guardian){
      guardian=await one<any>(client,`INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[
        a.core.organisation_id,appRow.guardian_first_name,appRow.guardian_last_name,appRow.guardian_phone,appRow.guardian_email,appRow.address
      ]);
    }
    await client.query(`INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary)
      VALUES($1,$2,$3,true) ON CONFLICT(student_id,guardian_id) DO UPDATE SET relationship=EXCLUDED.relationship,is_primary=true`,
      [student.id,guardian.id,appRow.guardian_relationship]);
    const classroom=await one<any>(client,'SELECT id,academic_year_id FROM classrooms WHERE id=$1 AND organisation_id=$2 AND is_active=true',[b.classroomId,a.core.organisation_id]);
    await client.query(`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status)
      VALUES($1,$2,$3,$4,'active')`,[a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id]);
    await client.query(`UPDATE admission_applications SET status='enrolled',student_id=$1,reviewed_by_os_user_id=$2,reviewed_at=now(),updated_at=now()
      WHERE id=$3`,[student.id,a.core.id,id]);
    await client.query(`INSERT INTO admission_status_history(organisation_id,application_id,old_status,new_status,note,actor_os_user_id)
      VALUES($1,$2,'approved','enrolled','Applicant enrolled and student record created',$3)`,[a.core.organisation_id,id,a.core.id]);
    return{student,guardian,classroom};
  });
  await audit(a.core.organisation_id,a.core.id,'admission.enrolled','admission_application',id,{studentId:result.student.id,classroomId:b.classroomId});
  await notifyContact({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'admission.status_changed',
    name:result.guardian.first_name+' '+result.guardian.last_name,email:result.guardian.email,phone:result.guardian.phone,
    subject:'Admission completed',
    body:`Admission has been completed for ${result.student.first_name} ${result.student.last_name}. Student admission number: ${result.student.admission_no}.`,
    relatedType:'admission_application',relatedId:id
  });
  return reply.code(201).send(result);
});

app.get('/api/roles/capabilities',async request=>{
  const a=await authorize(request,db,config,'roles.view');
  const capabilities=(await db.query(`SELECT * FROM school_capabilities ORDER BY sort_order,module,action,label`)).rows;
  const mappings=(await db.query(`SELECT role,capability_key,allowed FROM school_role_capabilities ORDER BY role,capability_key`)).rows;
  const manage=await maybeOne<any>(db,'SELECT allowed FROM school_role_capabilities WHERE role=$1 AND capability_key=$2',[a.role,'roles.manage']);
  return{
    currentRole:a.role,
    canManage:a.role==='school_admin'||Boolean(manage?.allowed),
    roles:['school_admin','headteacher','teacher','bursar','registrar'],
    capabilities,
    mappings
  };
});
app.put('/api/roles/:role/capabilities',async request=>{
  const a=await authorize(request,db,config,'roles.manage');
  const {role}=z.object({role:z.enum(['headteacher','teacher','bursar','registrar'])}).parse(request.params);
  const b=z.object({permissions:z.array(z.object({capabilityKey:z.string().min(1).max(100),allowed:z.boolean()})).min(1).max(100)}).parse(request.body);
  const known=(await db.query('SELECT key FROM school_capabilities')).rows.map((x:any)=>x.key);
  for(const p of b.permissions)if(!known.includes(p.capabilityKey))throw fail(400,`Unknown school capability: ${p.capabilityKey}`);
  await tx(db,async client=>{
    for(const p of b.permissions){
      await client.query(`INSERT INTO school_role_capabilities(role,capability_key,allowed,updated_at)
        VALUES($1,$2,$3,now())
        ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now()`,
        [role,p.capabilityKey,p.allowed]);
    }
  });
  await audit(a.core.organisation_id,a.core.id,'role_capabilities.updated','school_role',role,{count:b.permissions.length});
  return{role,updated:b.permissions.length};
});

app.get('/api/search',async request=>{
  const a=await authorize(request,db,config);
  const q=z.object({q:z.string().trim().min(1).max(100),limit:z.coerce.number().int().min(1).max(30).default(15)}).parse(request.query);
  const like='%'+q.q+'%';
  const rows=(await db.query(`
    SELECT * FROM (
      SELECT 'student' type,s.id::text id,(s.first_name||' '||s.last_name) title,
             (s.admission_no||COALESCE(' • '||c.name,'')) subtitle,'students' section,1 rank
      FROM students s
      LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active'
      LEFT JOIN classrooms c ON c.id=e.classroom_id
      WHERE s.organisation_id=$1 AND (
        s.first_name ILIKE $2 OR s.last_name ILIKE $2 OR s.admission_no ILIKE $2 OR
        (s.first_name||' '||s.last_name) ILIKE $2
      )
      UNION ALL
      SELECT 'guardian',g.id::text,(g.first_name||' '||g.last_name),
             (g.phone||COALESCE(' • '||g.email,'')),'students',2
      FROM guardians g WHERE g.organisation_id=$1 AND (
        g.first_name ILIKE $2 OR g.last_name ILIKE $2 OR g.phone ILIKE $2 OR COALESCE(g.email,'') ILIKE $2
      )
      UNION ALL
      SELECT 'class',c.id::text,c.name,(gl.name||' • '||COALESCE(c.stream,'No stream')),'classes',3
      FROM classrooms c JOIN grade_levels gl ON gl.id=c.grade_level_id
      WHERE c.organisation_id=$1 AND (c.name ILIKE $2 OR gl.name ILIKE $2)
      UNION ALL
      SELECT 'subject',s.id::text,s.name,(s.code||' • '||s.stage),'classes',4
      FROM subjects s WHERE s.organisation_id=$1 AND (s.name ILIKE $2 OR s.code ILIKE $2)
      UNION ALL
      SELECT 'admission',aa.id::text,(aa.first_name||' '||aa.last_name),
             (aa.application_no||' • '||aa.status),'admissions',5
      FROM admission_applications aa WHERE aa.organisation_id=$1 AND (
        aa.first_name ILIKE $2 OR aa.last_name ILIKE $2 OR aa.application_no ILIKE $2 OR aa.guardian_phone ILIKE $2
      )
      UNION ALL
      SELECT 'fee',f.id::text,f.name,('GHS '||f.amount::text),'fees',6
      FROM fee_items f WHERE f.organisation_id=$1 AND f.name ILIKE $2
    ) x
    ORDER BY rank,title
    LIMIT $3`,[a.core.organisation_id,like,q.limit])).rows;
  const auth=request.headers.authorization;
  let staff:any[]=[];
  if(auth){
    try{
      const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/users',{headers:{authorization:auth},signal:AbortSignal.timeout(5000)});
      if(res.ok){
        const users=await res.json() as any[];
        const needle=q.q.toLowerCase();
        staff=users.filter(u=>(u.first_name+' '+u.last_name+' '+u.email+' '+(u.job_title||'')).toLowerCase().includes(needle)).slice(0,5).map(u=>({
          type:'staff',id:u.id,title:u.first_name+' '+u.last_name,subtitle:(u.job_title||'Staff')+' • '+u.email,section:'staff'
        }));
      }
    }catch{}
  }
  return[...rows,...staff].slice(0,q.limit);
});


app.get('/api/communications/status',async request=>{
  const a=await authorize(request,db,config,'communications.view');
  const rules=(await db.query('SELECT event_key,channel,enabled,updated_at FROM notification_rules WHERE organisation_id=$1 ORDER BY event_key,channel',[a.core.organisation_id])).rows;
  return{providers:providerStatus(config),rules};
});
app.put('/api/communications/rules',async request=>{
  const a=await authorize(request,db,config,'communications.manage');
  const b=z.object({rules:z.array(z.object({
    eventKey:z.string().min(1).max(100),
    channel:z.enum(['email','sms','whatsapp']),
    enabled:z.boolean()
  })).min(1).max(100)}).parse(request.body);
  await tx(db,async client=>{
    for(const r of b.rules){
      await client.query(`INSERT INTO notification_rules(organisation_id,event_key,channel,enabled,updated_by_os_user_id,updated_at)
        VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(organisation_id,event_key,channel)
        DO UPDATE SET enabled=EXCLUDED.enabled,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now()`,
        [a.core.organisation_id,r.eventKey,r.channel,r.enabled,a.core.id]);
    }
  });
  await audit(a.core.organisation_id,a.core.id,'notification_rules.updated','notification_rule',null,{count:b.rules.length});
  return{updated:b.rules.length};
});
app.get('/api/communications/outbox',async request=>{
  const a=await authorize(request,db,config,'communications.view');
  const q=z.object({status:z.enum(['queued','pending_configuration','sending','sent','failed']).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
  return (await db.query(`SELECT * FROM communication_outbox
    WHERE organisation_id=$1 AND ($2::text IS NULL OR status=$2)
    ORDER BY created_at DESC LIMIT $3`,[a.core.organisation_id,q.status??null,q.limit])).rows;
});
app.post('/api/communications/send',async(request,reply)=>{
  const a=await authorize(request,db,config,'communications.send');
  const b=z.object({
    channels:z.array(z.enum(['email','sms','whatsapp'])).min(1).max(3),
    recipientName:z.string().max(200).optional(),
    email:z.string().email().optional(),
    phone:z.string().min(5).max(60).optional(),
    subject:z.string().max(300).optional(),
    body:z.string().min(1).max(5000)
  }).parse(request.body);
  const results:any[]=[];
  for(const channel of b.channels){
    const address=channel==='email'?b.email:b.phone;
    if(!address)throw fail(400,channel==='email'?'Email address is required':'Phone number is required');
    results.push(await deliverCommunication({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,channel,
      recipientName:b.recipientName,recipientAddress:address,subject:b.subject,body:b.body,
      templateKey:'manual.message'
    }));
  }
  await audit(a.core.organisation_id,a.core.id,'communication.sent','communication_outbox',null,{channels:b.channels});
  return reply.code(201).send(results);
});

app.get('/api/payments/provider-status',async request=>{
  const a=await authorize(request,db,config,'payments.configure');
  const s=providerStatus(config);
  return{payments:s.payments,email:s.email,sms:s.sms,whatsapp:s.whatsapp};
});
app.get('/api/fees/payment-requests',async request=>{
  const a=await authorize(request,db,config,'fees.view');
  const q=z.object({status:z.enum(['open','paid','cancelled','expired']).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
  return (await db.query(`SELECT pr.*,s.admission_no,s.first_name,s.last_name,f.name fee_name,
      g.first_name guardian_first_name,g.last_name guardian_last_name,g.phone guardian_phone,g.email guardian_email
    FROM fee_payment_requests pr
    JOIN students s ON s.id=pr.student_id
    LEFT JOIN student_fees sf ON sf.id=pr.student_fee_id
    LEFT JOIN fee_items f ON f.id=sf.fee_item_id
    LEFT JOIN guardians g ON g.id=pr.guardian_id
    WHERE pr.organisation_id=$1 AND ($2::text IS NULL OR pr.status=$2)
    ORDER BY pr.created_at DESC LIMIT $3`,[a.core.organisation_id,q.status??null,q.limit])).rows;
});
app.post('/api/fees/payment-requests',async(request,reply)=>{
  const a=await authorize(request,db,config,'payments.initiate');
  const b=z.object({
    studentId:z.string().uuid(),
    studentFeeId:z.string().uuid().optional(),
    guardianId:z.string().uuid().optional(),
    amount:z.number().positive(),
    note:z.string().max(1000).optional(),
    expiresAt:z.string().datetime().optional()
  }).parse(request.body);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
  let fee:any=null;
  if(b.studentFeeId){
    fee=await one<any>(db,`SELECT sf.*,f.name fee_name,(sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
      FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id
      WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3`,[b.studentFeeId,b.studentId,a.core.organisation_id]);
    if(b.amount>Number(fee.balance)+0.001)throw fail(400,'Payment request cannot exceed the outstanding fee balance');
  }
  const guardian=b.guardianId
    ?await one<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id
      WHERE g.id=$1 AND sg.student_id=$2`,[b.guardianId,b.studentId])
    :await maybeOne<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id
      WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC LIMIT 1`,[b.studentId]);
  if(!guardian)throw fail(409,'Link a guardian to the student before sending a payment request');
  const row=await one<any>(db,`INSERT INTO fee_payment_requests(
      organisation_id,student_id,student_fee_id,guardian_id,amount,note,requested_by_os_user_id,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[
      a.core.organisation_id,b.studentId,b.studentFeeId??null,guardian.id,b.amount,b.note??null,a.core.id,b.expiresAt??null
    ]);
  const school=await one<any>(db,'SELECT school_name,currency FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  await notifyContact({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'fees.payment_requested',
    name:guardian.first_name+' '+guardian.last_name,email:guardian.email,phone:guardian.phone,
    subject:'School fee payment request',
    body:`${school.school_name} has requested a fee payment of ${school.currency||'GHS'} ${Number(b.amount).toFixed(2)} for ${student.first_name} ${student.last_name}${fee?' - '+fee.fee_name:''}. Sign in to the Parent Portal to review and pay.`,
    relatedType:'fee_payment_request',relatedId:row.id
  });
  await audit(a.core.organisation_id,a.core.id,'fee_payment_request.created','fee_payment_request',row.id,{studentId:b.studentId,amount:b.amount});
  return reply.code(201).send(row);
});
app.post('/api/fees/payment-requests/:id/cancel',async request=>{
  const a=await authorize(request,db,config,'payments.initiate');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,`UPDATE fee_payment_requests SET status='cancelled',updated_at=now()
    WHERE id=$1 AND organisation_id=$2 AND status='open' RETURNING *`,[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'fee_payment_request.cancelled','fee_payment_request',id);
  return row;
});

app.get('/api/payment-intents',async request=>{
  const a=await authorize(request,db,config,'fees.view');
  const q=z.object({limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
  return (await db.query(`SELECT pi.*,s.admission_no,s.first_name,s.last_name,f.name fee_name
    FROM payment_intents pi JOIN students s ON s.id=pi.student_id
    LEFT JOIN student_fees sf ON sf.id=pi.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id
    WHERE pi.organisation_id=$1 ORDER BY pi.created_at DESC LIMIT $2`,[a.core.organisation_id,q.limit])).rows;
});

app.post('/api/payment-intents',async(request,reply)=>{
  const a=await authorize(request,db,config,'payments.initiate');
  if(!providerStatus(config).payments.configured)throw fail(503,'Online payment provider is not configured');
  const b=z.object({
    studentId:z.string().uuid(),
    studentFeeId:z.string().uuid().optional(),
    guardianId:z.string().uuid().optional(),
    amount:z.number().positive(),
    method:z.enum(['card','mobile_money'])
  }).parse(request.body);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
  const guardian=b.guardianId
    ?await one<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id WHERE g.id=$1 AND sg.student_id=$2`,[b.guardianId,b.studentId])
    :await maybeOne<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC LIMIT 1`,[b.studentId]);
  if(!guardian?.email)throw fail(409,'The guardian needs an email address before an online payment can be initialized');
  if(b.studentFeeId){
    const open=await one<any>(db,`SELECT (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
      FROM student_fees sf WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3`,[b.studentFeeId,b.studentId,a.core.organisation_id]);
    if(b.amount>Number(open.balance)+0.001)throw fail(400,'Payment cannot exceed the outstanding fee balance');
  }
  const reference='RXS-'+Date.now().toString(36).toUpperCase()+'-'+randomBytes(4).toString('hex').toUpperCase();
  const intent=await one<any>(db,`INSERT INTO payment_intents(
      organisation_id,student_id,student_fee_id,guardian_id,amount,currency,method,provider,reference,status,initiated_by_type,initiated_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'paystack',$8,'initialized','school',$9) RETURNING *`,[
      a.core.organisation_id,b.studentId,b.studentFeeId??null,guardian.id,b.amount,config.PAYSTACK_CURRENCY,b.method,reference,a.core.id
    ]);
  try{
    const base=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
    const initialized=await initializePaystack(config,{
      email:guardian.email,amount:b.amount,currency:config.PAYSTACK_CURRENCY,reference,
      channels:[b.method],callbackUrl:base+'/payment/callback',
      metadata:{schoolPaymentIntentId:intent.id,studentId:b.studentId,studentFeeId:b.studentFeeId||null}
    });
    const updated=await one<any>(db,`UPDATE payment_intents SET status='pending',authorization_url=$1,provider_access_code=$2,updated_at=now()
      WHERE id=$3 RETURNING *`,[initialized.authorizationUrl,initialized.accessCode,intent.id]);
    await audit(a.core.organisation_id,a.core.id,'payment_intent.created','payment_intent',intent.id,{method:b.method,amount:b.amount});
    return reply.code(201).send(updated);
  }catch(error:any){
    await db.query("UPDATE payment_intents SET status='failed',failure_reason=$1,updated_at=now() WHERE id=$2",[String(error?.message||error),intent.id]);
    throw error;
  }
});

app.get('/api/parent/students/:id/payment-requests',async request=>{
  const g=await guardianAuth(request);
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await ensureGuardianStudent(g.guardian_id,id);
  return (await db.query(`SELECT pr.*,f.name fee_name
    FROM fee_payment_requests pr
    LEFT JOIN student_fees sf ON sf.id=pr.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id
    WHERE pr.organisation_id=$1 AND pr.student_id=$2 AND pr.guardian_id=$3 AND pr.status='open'
      AND (pr.expires_at IS NULL OR pr.expires_at>now())
    ORDER BY pr.created_at DESC`,[g.organisation_id,id,g.guardian_id])).rows;
});
app.post('/api/parent/payment-intents',async(request,reply)=>{
  const g=await guardianAuth(request);
  if(!providerStatus(config).payments.configured)throw fail(503,'Online payment is not yet configured by the school');
  const b=z.object({
    studentId:z.string().uuid(),
    studentFeeId:z.string().uuid().optional(),
    paymentRequestId:z.string().uuid().optional(),
    amount:z.number().positive(),
    method:z.enum(['card','mobile_money'])
  }).parse(request.body);
  await ensureGuardianStudent(g.guardian_id,b.studentId);
  if(!g.email)throw fail(409,'Add an email address to your guardian record before making an online payment');
  let requestRow:any=null;
  if(b.paymentRequestId){
    requestRow=await one<any>(db,`SELECT * FROM fee_payment_requests
      WHERE id=$1 AND organisation_id=$2 AND student_id=$3 AND guardian_id=$4 AND status='open'
      AND (expires_at IS NULL OR expires_at>now())`,[b.paymentRequestId,g.organisation_id,b.studentId,g.guardian_id]);
    if(Math.abs(Number(requestRow.amount)-b.amount)>0.001)throw fail(400,'Payment amount must match the school payment request');
  }
  const feeId=b.studentFeeId??requestRow?.student_fee_id??null;
  if(feeId){
    const open=await one<any>(db,`SELECT (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
      FROM student_fees sf WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3`,[feeId,b.studentId,g.organisation_id]);
    if(b.amount>Number(open.balance)+0.001)throw fail(400,'Payment cannot exceed the outstanding fee balance');
  }
  const reference='RXP-'+Date.now().toString(36).toUpperCase()+'-'+randomBytes(4).toString('hex').toUpperCase();
  const intent=await one<any>(db,`INSERT INTO payment_intents(
      organisation_id,student_id,student_fee_id,payment_request_id,guardian_id,amount,currency,method,provider,reference,status,initiated_by_type,initiated_by_guardian_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,'initialized','guardian',$10) RETURNING *`,[
      g.organisation_id,b.studentId,feeId,b.paymentRequestId??null,g.guardian_id,b.amount,config.PAYSTACK_CURRENCY,b.method,reference,g.guardian_id
    ]);
  try{
    const base=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
    const initialized=await initializePaystack(config,{
      email:g.email,amount:b.amount,currency:config.PAYSTACK_CURRENCY,reference,
      channels:[b.method],callbackUrl:base+'/payment/callback',
      metadata:{schoolPaymentIntentId:intent.id,studentId:b.studentId,guardianId:g.guardian_id}
    });
    const updated=await one<any>(db,`UPDATE payment_intents SET status='pending',authorization_url=$1,provider_access_code=$2,updated_at=now()
      WHERE id=$3 RETURNING *`,[initialized.authorizationUrl,initialized.accessCode,intent.id]);
    return reply.code(201).send(updated);
  }catch(error:any){
    await db.query("UPDATE payment_intents SET status='failed',failure_reason=$1,updated_at=now() WHERE id=$2",[String(error?.message||error),intent.id]);
    throw error;
  }
});
app.get('/payment/callback',async(request,reply)=>{
  const q=z.object({reference:z.string().min(1).max(120)}).parse(request.query);
  try{
    const intent=await settleOnlinePayment(q.reference);
    const base=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
    return reply.redirect(base+'/parent?payment='+encodeURIComponent(intent.status)+'&reference='+encodeURIComponent(q.reference));
  }catch{
    const base=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
    return reply.redirect(base+'/parent?payment=failed&reference='+encodeURIComponent(q.reference));
  }
});
app.post('/api/payments/paystack/webhook',async(request,reply)=>{
  const event=request.body as any;
  const reference=String(event?.data?.reference||'');
  if(event?.event!=='charge.success'||!reference)return reply.code(200).send({ok:true});
  try{
    const intent=await settleOnlinePayment(reference);
    if(intent.status==='success'){
      const guardian=intent.guardian_id?await maybeOne<any>(db,'SELECT * FROM guardians WHERE id=$1',[intent.guardian_id]):null;
      const student=await maybeOne<any>(db,'SELECT * FROM students WHERE id=$1',[intent.student_id]);
      if(guardian&&student){
        await notifyContact({
          organisationId:intent.organisation_id,eventKey:'fees.payment_received',
          name:guardian.first_name+' '+guardian.last_name,email:guardian.email,phone:guardian.phone,
          subject:'School fee payment received',
          body:`Payment of ${intent.currency} ${Number(intent.amount).toFixed(2)} for ${student.first_name} ${student.last_name} has been received successfully. Reference: ${intent.reference}.`,
          relatedType:'payment_intent',relatedId:intent.id
        });
      }
    }
  }catch(error:any){
    console.error('Paystack webhook settlement failed',error?.message||error);
  }
  return reply.code(200).send({ok:true});
});

app.get('/api/audit',async request=>{const a=await authorize(request,db,config,'reports.view');return (await db.query('SELECT * FROM school_audit_logs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 100',[a.core.organisation_id])).rows});

app.setErrorHandler((error:any,_request,reply)=>{
  let status=Number(error.statusCode)||400;
  if(error.code==='23505')status=409;
  if(error.code==='23503')status=409;
  const message=error.code==='23505'?'A record with the same unique value already exists':error.code==='23503'?'This record is still in use and cannot be deleted':(error.message||'Unexpected school service error');
  reply.code(status>=400&&status<600?status:500).send({error:{message}});
});

let shutting=false;
async function shutdown(){if(shutting)return;shutting=true;await app.close();await db.end()}
process.once('SIGTERM',()=>void shutdown().finally(()=>process.exit(0)));
process.once('SIGINT',()=>void shutdown().finally(()=>process.exit(0)));

await provisionDemoTeachers();

await app.listen({host:config.HOST,port:config.PORT});
console.log(`Revolt-X School listening on ${config.HOST}:${config.PORT}`);
