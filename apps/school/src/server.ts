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
        const t=byEmail(subjectTeacher[sub.code]);
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
  const a=await authorize(request,db,config,'reports.read');
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
  const a=await authorize(request,db,config,'academic.manage');
  const b=z.object({name:z.string().min(4).max(40),startDate:z.string().date(),endDate:z.string().date()}).parse(request.body);
  if(b.endDate<=b.startDate)throw fail(400,'Academic year end date must be after start date');
  const row=await one<any>(db,'INSERT INTO academic_years(organisation_id,name,start_date,end_date) VALUES($1,$2,$3,$4) RETURNING *',[a.core.organisation_id,b.name,b.startDate,b.endDate]);
  await audit(a.core.organisation_id,a.core.id,'academic_year.created','academic_year',row.id);
  return reply.code(201).send(row);
});
app.post('/api/academic-years/:id/activate',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  return tx(db,async c=>{await c.query("UPDATE academic_years SET status='closed' WHERE organisation_id=$1 AND status='active' AND id<>$2",[a.core.organisation_id,id]);const row=await one<any>(c,"UPDATE academic_years SET status='active' WHERE id=$1 AND organisation_id=$2 RETURNING *",[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'academic_year.activated','academic_year',id);return row});
});

app.get('/api/terms',async request=>{const a=await authorize(request,db,config);const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query('SELECT * FROM terms WHERE organisation_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) ORDER BY start_date',[a.core.organisation_id,q.academicYearId??null])).rows});
app.post('/api/terms',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');const b=z.object({academicYearId:z.string().uuid(),termNo:z.number().int().min(1).max(3),name:z.string().min(2).max(80),startDate:z.string().date(),endDate:z.string().date()}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO terms(organisation_id,academic_year_id,term_no,name,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termNo,b.name,b.startDate,b.endDate]);
  await audit(a.core.organisation_id,a.core.id,'term.created','term',row.id);return reply.code(201).send(row);
});
app.post('/api/terms/:id/activate',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const a=await authorize(request,db,config,'academic.manage');const b=z.object({academicYearId:z.string().uuid(),gradeLevelId:z.string().uuid(),name:z.string().min(2).max(120),stream:z.string().max(40).optional(),capacity:z.number().int().positive().optional(),classTeacherOsUserId:z.string().uuid().optional()}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO classrooms(organisation_id,academic_year_id,grade_level_id,name,stream,capacity,class_teacher_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[a.core.organisation_id,b.academicYearId,b.gradeLevelId,b.name,b.stream??null,b.capacity??null,b.classTeacherOsUserId??null]);
  await audit(a.core.organisation_id,a.core.id,'class.created','classroom',row.id);return reply.code(201).send(row);
});
app.get('/api/subjects',async request=>{const a=await authorize(request,db,config);return (await db.query('SELECT * FROM subjects WHERE organisation_id=$1 ORDER BY name',[a.core.organisation_id])).rows});
app.post('/api/subjects',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');const b=z.object({code:z.string().min(1).max(30),name:z.string().min(2).max(120),stage:z.enum(['primary','jhs','both']).default('both')}).parse(request.body);
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
  const a=await authorize(request,db,config,'academic.manage');
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
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const a=await authorize(request,db,config,'students.manage');const b=z.object({admissionNo:z.string().min(1).max(60),firstName:z.string().min(1).max(100),middleName:z.string().max(100).optional(),lastName:z.string().min(1).max(100),sex:z.enum(['male','female']).optional(),dateOfBirth:z.string().date().optional(),admissionDate:z.string().date().optional(),notes:z.string().max(5000).optional()}).parse(request.body);
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
    const rawSubjects=(await db.query(`SELECT sub.id subject_id,sub.name subject_name,
      ROUND(AVG((sc.score/a.max_score)*100)::numeric,2) percentage,COUNT(sc.score)::int assessment_count
      FROM assessments a JOIN subjects sub ON sub.id=a.subject_id
      JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$1
      WHERE a.organisation_id=$2 AND a.term_id=$3
      GROUP BY sub.id,sub.name ORDER BY sub.name`,[id,a.core.organisation_id,term.id])).rows;
    const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[a.core.organisation_id])).rows;
    subjects=rawSubjects.map((s:any)=>{const pct=Number(s.percentage),band=bands.find((b:any)=>pct>=Number(b.min_percentage)&&pct<=Number(b.max_percentage));return{...s,grade:band?.name??'',remark:band?.remark??''}});
    if(subjects.length)performance.overallAverage=Math.round((subjects.reduce((sum:number,s:any)=>sum+Number(s.percentage),0)/subjects.length)*100)/100;
    if(student.classroom_id){
      const rank=await maybeOne<any>(db,`WITH class_scores AS (
          SELECT e.student_id,AVG((sc.score/a.max_score)*100.0) avg_pct
          FROM enrolments e
          JOIN assessments a ON a.classroom_id=e.classroom_id AND a.term_id=$2
          JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=e.student_id
          WHERE e.classroom_id=$1 AND e.status='active'
          GROUP BY e.student_id
        ), ranked AS (
          SELECT student_id,ROUND(avg_pct::numeric,2) average,
                 RANK() OVER(ORDER BY avg_pct DESC)::int position,
                 COUNT(*) OVER()::int class_size
          FROM class_scores
        )
        SELECT * FROM ranked WHERE student_id=$3`,[student.classroom_id,term.id,id]);
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
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({firstName:z.string().min(1).max(100).optional(),middleName:z.string().max(100).nullable().optional(),lastName:z.string().min(1).max(100).optional(),status:z.enum(['active','graduated','transferred','withdrawn']).optional(),notes:z.string().max(5000).nullable().optional()}).parse(request.body);
  const row=await one<any>(db,`UPDATE students SET first_name=COALESCE($1,first_name),middle_name=CASE WHEN $2 THEN $3 ELSE middle_name END,last_name=COALESCE($4,last_name),status=COALESCE($5,status),notes=CASE WHEN $6 THEN $7 ELSE notes END,updated_at=now() WHERE id=$8 AND organisation_id=$9 RETURNING *`,[b.firstName??null,Object.hasOwn(b,'middleName'),b.middleName??null,b.lastName??null,b.status??null,Object.hasOwn(b,'notes'),b.notes??null,id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'student.updated','student',id);return row;
});
app.post('/api/students/:id/guardians',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({firstName:z.string().min(1).max(100),lastName:z.string().min(1).max(100),phone:z.string().min(5).max(60),email:z.string().email().optional(),address:z.string().max(2000).optional(),relationship:z.string().min(2).max(60),isPrimary:z.boolean().default(false)}).parse(request.body);
  const row=await tx(db,async c=>{const g=await one<any>(c,'INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.firstName,b.lastName,b.phone,b.email??null,b.address??null]);if(b.isPrimary)await c.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[id]);await c.query('INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary) VALUES($1,$2,$3,$4)',[id,g.id,b.relationship,b.isPrimary]);return g});await audit(a.core.organisation_id,a.core.id,'guardian.linked','student',id,{guardianId:row.id});return reply.code(201).send(row);
});
app.post('/api/enrolments',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.manage');const b=z.object({studentId:z.string().uuid(),academicYearId:z.string().uuid(),classroomId:z.string().uuid()}).parse(request.body);const row=await one<any>(db,'INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,academic_year_id) DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status=\'active\',enrolled_at=now() RETURNING *',[a.core.organisation_id,b.studentId,b.academicYearId,b.classroomId]);await audit(a.core.organisation_id,a.core.id,'student.enrolled','enrolment',row.id);return reply.code(201).send(row);
});

app.get('/api/attendance',async request=>{
  const a=await authorize(request,db,config);const q=z.object({classroomId:z.string().uuid(),date:z.string().date()}).parse(request.query);await ensureTeacherScope(a,q.classroomId,null);
  return (await db.query(`SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,COALESCE(ar.status,'unmarked') attendance_status,ar.note FROM enrolments e JOIN students s ON s.id=e.student_id LEFT JOIN attendance_records ar ON ar.student_id=s.id AND ar.classroom_id=e.classroom_id AND ar.attendance_date=$3 WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.status='active' ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,q.classroomId,q.date])).rows;
});
app.post('/api/attendance/mark',async request=>{
  const a=await authorize(request,db,config,'attendance.manage');const b=z.object({classroomId:z.string().uuid(),date:z.string().date(),records:z.array(z.object({studentId:z.string().uuid(),status:z.enum(['present','absent','late','excused']),note:z.string().max(500).optional()})).min(1).max(200)}).parse(request.body);await ensureTeacherScope(a,b.classroomId,null);
  await tx(db,async c=>{for(const r of b.records)await c.query(`INSERT INTO attendance_records(organisation_id,student_id,classroom_id,attendance_date,status,note,marked_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(student_id,classroom_id,attendance_date) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,marked_by_os_user_id=EXCLUDED.marked_by_os_user_id,updated_at=now()`,[a.core.organisation_id,r.studentId,b.classroomId,b.date,r.status,r.note??null,a.core.id])});await audit(a.core.organisation_id,a.core.id,'attendance.marked','classroom',b.classroomId,{date:b.date,count:b.records.length});return{saved:b.records.length};
});

app.get('/api/assessments',async request=>{
  const a=await authorize(request,db,config);const q=z.object({termId:z.string().uuid().optional(),classroomId:z.string().uuid().optional()}).parse(request.query);
  let rows=(await db.query(`SELECT a.*,s.name subject_name,c.name classroom_name,t.name term_name FROM assessments a JOIN subjects s ON s.id=a.subject_id JOIN classrooms c ON c.id=a.classroom_id JOIN terms t ON t.id=a.term_id WHERE a.organisation_id=$1 AND ($2::uuid IS NULL OR a.term_id=$2) AND ($3::uuid IS NULL OR a.classroom_id=$3) ORDER BY a.assessment_date DESC NULLS LAST,a.created_at DESC`,[a.core.organisation_id,q.termId??null,q.classroomId??null])).rows;
  if(a.role==='teacher'){
    const allowed=(await db.query(`SELECT DISTINCT classroom_id,subject_id FROM teacher_assignments WHERE organisation_id=$1 AND teacher_os_user_id=$2 AND is_active=true UNION SELECT id,NULL::uuid FROM classrooms WHERE organisation_id=$1 AND class_teacher_os_user_id=$2`,[a.core.organisation_id,a.core.id])).rows;
    rows=rows.filter((r:any)=>allowed.some((x:any)=>x.classroom_id===r.classroom_id&&(x.subject_id==null||x.subject_id===r.subject_id)));
  }
  return rows;
});
app.post('/api/assessments',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.manage');const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),name:z.string().min(2).max(160),assessmentType:z.enum(['classwork','homework','project','test','exam','other']),maxScore:z.number().positive(),weight:z.number().positive().max(100).default(100),assessmentDate:z.string().date().optional()}).parse(request.body);await ensureTeacherScope(a,b.classroomId,b.subjectId);
  const row=await one<any>(db,'INSERT INTO assessments(organisation_id,academic_year_id,term_id,classroom_id,subject_id,name,assessment_type,max_score,weight,assessment_date,created_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,b.name,b.assessmentType,b.maxScore,b.weight,b.assessmentDate??null,a.core.id]);await audit(a.core.organisation_id,a.core.id,'assessment.created','assessment',row.id);return reply.code(201).send(row);
});
app.get('/api/assessments/:id/scores',async request=>{
  const a=await authorize(request,db,config);const {id}=z.object({id:z.string().uuid()}).parse(request.params);const ass=await maybeOne<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!ass)throw fail(404,'Assessment not found');await ensureTeacherScope(a,ass.classroom_id,ass.subject_id);const rows=(await db.query(`SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,sc.score,sc.comment FROM enrolments e JOIN students s ON s.id=e.student_id LEFT JOIN assessment_scores sc ON sc.student_id=s.id AND sc.assessment_id=$1 WHERE e.classroom_id=$2 AND e.status='active' ORDER BY s.last_name,s.first_name`,[id,ass.classroom_id])).rows;return{assessment:ass,students:rows};
});
app.post('/api/assessments/:id/scores',async request=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({scores:z.array(z.object({studentId:z.string().uuid(),score:z.number().min(0),comment:z.string().max(500).optional()})).min(1).max(200)}).parse(request.body);const ass=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,ass.classroom_id,ass.subject_id);for(const s of b.scores)if(Number(s.score)>Number(ass.max_score))throw fail(400,`Score cannot exceed ${ass.max_score}`);await tx(db,async c=>{for(const s of b.scores)await c.query(`INSERT INTO assessment_scores(assessment_id,student_id,score,comment) VALUES($1,$2,$3,$4) ON CONFLICT(assessment_id,student_id) DO UPDATE SET score=EXCLUDED.score,comment=EXCLUDED.comment,updated_at=now()`,[id,s.studentId,s.score,s.comment??null])});await audit(a.core.organisation_id,a.core.id,'assessment.scores_saved','assessment',id,{count:b.scores.length});return{saved:b.scores.length};
});

app.get('/api/report-cards/:studentId',async request=>{
  const a=await authorize(request,db,config,'reports.read');
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
  const results=(await db.query(`SELECT sub.id subject_id,sub.name subject_name,
      ROUND(AVG((sc.score/a.max_score)*100)::numeric,2) percentage,
      COUNT(sc.score)::int assessment_count
    FROM assessments a JOIN subjects sub ON sub.id=a.subject_id
    LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$1
    WHERE a.organisation_id=$2 AND a.term_id=$3
    GROUP BY sub.id,sub.name ORDER BY sub.name`,[studentId,a.core.organisation_id,q.termId])).rows;
  const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[a.core.organisation_id])).rows;
  const subjects=results.map((s:any)=>{const pct=Number(s.percentage),band=bands.find((b:any)=>pct>=Number(b.min_percentage)&&pct<=Number(b.max_percentage));return{...s,grade:band?.name??'',remark:band?.remark??''}});
  let overallAverage=subjects.length?Math.round((subjects.reduce((sum:number,s:any)=>sum+Number(s.percentage||0),0)/subjects.length)*100)/100:null;
  let classPosition:number|null=null,classSize:number|null=null;
  if(current?.classroom_id){
    const rank=await maybeOne<any>(db,`WITH class_scores AS (
        SELECT e.student_id,AVG((sc.score/a.max_score)*100.0) avg_pct
        FROM enrolments e
        JOIN assessments a ON a.classroom_id=e.classroom_id AND a.term_id=$2
        JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=e.student_id
        WHERE e.classroom_id=$1 AND e.academic_year_id=$3
        GROUP BY e.student_id
      ), ranked AS (
        SELECT student_id,ROUND(avg_pct::numeric,2) average,
               RANK() OVER(ORDER BY avg_pct DESC)::int position,
               COUNT(*) OVER()::int class_size
        FROM class_scores
      )
      SELECT * FROM ranked WHERE student_id=$4`,[current.classroom_id,q.termId,term.academic_year_id,studentId]);
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
  const a=await authorize(request,db,config,'fees.manage');const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().optional(),gradeLevelId:z.string().uuid().optional(),name:z.string().min(2).max(160),amount:z.number().min(0),mandatory:z.boolean().default(true)}).parse(request.body);const row=await one<any>(db,'INSERT INTO fee_items(organisation_id,academic_year_id,term_id,grade_level_id,name,amount,mandatory) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termId??null,b.gradeLevelId??null,b.name,b.amount,b.mandatory]);await audit(a.core.organisation_id,a.core.id,'fee_item.created','fee_item',row.id);return reply.code(201).send(row);
});
app.post('/api/fees/assign',async request=>{
  const a=await authorize(request,db,config,'fees.manage');const b=z.object({feeItemId:z.string().uuid(),studentId:z.string().uuid().optional(),classroomId:z.string().uuid().optional()}).refine(v=>v.studentId||v.classroomId,{message:'studentId or classroomId is required'}).parse(request.body);const fee=await one<any>(db,'SELECT * FROM fee_items WHERE id=$1 AND organisation_id=$2',[b.feeItemId,a.core.organisation_id]);let students:string[]=[];if(b.studentId)students=[b.studentId];else students=(await db.query("SELECT student_id FROM enrolments WHERE organisation_id=$1 AND classroom_id=$2 AND status='active'",[a.core.organisation_id,b.classroomId])).rows.map((x:any)=>x.student_id);for(const sid of students)await db.query(`INSERT INTO student_fees(organisation_id,student_id,fee_item_id,amount_due) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,fee_item_id) DO NOTHING`,[a.core.organisation_id,sid,fee.id,fee.amount]);await audit(a.core.organisation_id,a.core.id,'fees.assigned','fee_item',fee.id,{count:students.length});return{assigned:students.length};
});
app.get('/api/fees/student/:studentId',async request=>{
  const a=await authorize(request,db,config);const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);const items=(await db.query(`SELECT sf.*,f.name fee_name,f.amount original_amount,COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) paid FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id WHERE sf.organisation_id=$1 AND sf.student_id=$2 ORDER BY sf.created_at DESC`,[a.core.organisation_id,studentId])).rows;const payments=(await db.query('SELECT * FROM payments WHERE organisation_id=$1 AND student_id=$2 ORDER BY paid_at DESC',[a.core.organisation_id,studentId])).rows;return{items,payments};
});
app.post('/api/payments',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.manage');const b=z.object({studentId:z.string().uuid(),studentFeeId:z.string().uuid().optional(),amount:z.number().positive(),paymentMethod:z.enum(['cash','mobile_money','bank','card','other']),reference:z.string().max(120).optional(),note:z.string().max(500).optional()}).parse(request.body);const row=await tx(db,async c=>{const p=await one<any>(c,'INSERT INTO payments(organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[a.core.organisation_id,b.studentId,b.studentFeeId??null,b.amount,b.paymentMethod,b.reference??null,a.core.id,b.note??null]);if(b.studentFeeId){const calc=await one<any>(c,`SELECT sf.id,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount),0) paid FROM student_fees sf LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.id=$1 GROUP BY sf.id`,[b.studentFeeId]);const status=Number(calc.paid)>=Number(calc.due)?'paid':Number(calc.paid)>0?'part_paid':'unpaid';await c.query('UPDATE student_fees SET status=$1 WHERE id=$2',[status,b.studentFeeId])}return p});await audit(a.core.organisation_id,a.core.id,'payment.recorded','payment',row.id,{amount:b.amount});return reply.code(201).send(row);
});

app.get('/api/timetable',async request=>{const a=await authorize(request,db,config);const q=z.object({classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional()}).parse(request.query);return (await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name FROM timetable_entries tt JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id WHERE tt.organisation_id=$1 AND ($2::uuid IS NULL OR tt.classroom_id=$2) AND ($3::uuid IS NULL OR tt.term_id=$3) ORDER BY tt.day_of_week,tt.start_time`,[a.core.organisation_id,q.classroomId??null,q.termId??null])).rows});
app.post('/api/timetable',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.manage');const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().optional(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),teacherOsUserId:z.string().uuid().optional(),dayOfWeek:z.number().int().min(1).max(5),startTime:z.string().regex(/^\d{2}:\d{2}$/),endTime:z.string().regex(/^\d{2}:\d{2}$/),room:z.string().max(80).optional()}).parse(request.body);const row=await one<any>(db,'INSERT INTO timetable_entries(organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,room) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termId??null,b.classroomId,b.subjectId,b.teacherOsUserId??null,b.dayOfWeek,b.startTime,b.endTime,b.room??null]);await audit(a.core.organisation_id,a.core.id,'timetable.created','timetable_entry',row.id);return reply.code(201).send(row);
});

app.get('/api/staff/core-users',async request=>{
  const a=await authorize(request,db,config,'school.manage');const auth=request.headers.authorization!;const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/users',{headers:{authorization:auth},signal:AbortSignal.timeout(10000)});if(!res.ok)throw fail(res.status,'Could not load Core OS users');return res.json();
});

app.post('/api/staff/teachers',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');
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
app.get('/api/staff/module-memberships',async request=>{const a=await authorize(request,db,config,'school.manage');return (await db.query('SELECT * FROM school_memberships WHERE organisation_id=$1 ORDER BY created_at',[a.core.organisation_id])).rows});
app.post('/api/staff/module-memberships',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');const b=z.object({osUserId:z.string().uuid(),role:z.enum(['school_admin','headteacher','teacher','bursar','registrar']),status:z.enum(['active','suspended']).default('active')}).parse(request.body);const row=await one<any>(db,`INSERT INTO school_memberships(organisation_id,os_user_id,role,status) VALUES($1,$2,$3,$4) ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,updated_at=now() RETURNING *`,[a.core.organisation_id,b.osUserId,b.role,b.status]);await audit(a.core.organisation_id,a.core.id,'school_staff.assigned','school_membership',row.id,{role:b.role});return reply.code(201).send(row);
});


app.patch('/api/academic-years/:id',async request=>{
  const a=await authorize(request,db,config,'academic.manage');
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
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const y=await one<any>(db,'SELECT * FROM academic_years WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(y.status==='active')throw fail(409,'Close or activate another academic year before deleting this one');
  const count=await one<any>(db,'SELECT count(*)::int n FROM enrolments WHERE academic_year_id=$1',[id]);
  if(count.n>0)throw fail(409,'This academic year has student enrolments and cannot be deleted');
  await db.query('DELETE FROM academic_years WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'academic_year.deleted','academic_year',id,{name:y.name});
  return reply.code(204).send();
});

app.patch('/api/terms/:id',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(80).optional(),startDate:z.string().date().optional(),endDate:z.string().date().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const start=b.startDate??String(current.start_date).slice(0,10),end=b.endDate??String(current.end_date).slice(0,10);
  if(end<=start)throw fail(400,'Term end date must be after start date');
  const row=await one<any>(db,'UPDATE terms SET name=COALESCE($1,name),start_date=COALESCE($2::date,start_date),end_date=COALESCE($3::date,end_date) WHERE id=$4 AND organisation_id=$5 RETURNING *',[b.name??null,b.startDate??null,b.endDate??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'term.updated','term',id);return row;
});
app.delete('/api/terms/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const t=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(t.status==='active')throw fail(409,'An active term cannot be deleted');
  await db.query('DELETE FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'term.deleted','term',id,{name:t.name});return reply.code(204).send();
});

app.patch('/api/grade-levels/:id',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(80).optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE grade_levels SET name=COALESCE($1,name),is_active=COALESCE($2,is_active) WHERE id=$3 AND organisation_id=$4 RETURNING *',[b.name??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'grade_level.updated','grade_level',id);return row;
});

app.patch('/api/classes/:id',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(120).optional(),stream:z.string().max(40).nullable().optional(),capacity:z.number().int().positive().nullable().optional(),classTeacherOsUserId:z.string().uuid().nullable().optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE classrooms SET name=COALESCE($1,name),stream=CASE WHEN $2 THEN $3 ELSE stream END,capacity=CASE WHEN $4 THEN $5 ELSE capacity END,class_teacher_os_user_id=CASE WHEN $6 THEN $7 ELSE class_teacher_os_user_id END,is_active=COALESCE($8,is_active) WHERE id=$9 AND organisation_id=$10 RETURNING *`,[b.name??null,Object.hasOwn(b,'stream'),b.stream??null,Object.hasOwn(b,'capacity'),b.capacity??null,Object.hasOwn(b,'classTeacherOsUserId'),b.classTeacherOsUserId??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'class.updated','classroom',id);return row;
});
app.delete('/api/classes/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM classrooms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const count=await one<any>(db,'SELECT count(*)::int n FROM enrolments WHERE classroom_id=$1',[id]);
  if(count.n>0)throw fail(409,'Move or remove enrolled students before deleting this class');
  await db.query('DELETE FROM classrooms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'class.deleted','classroom',id,{name:row.name});return reply.code(204).send();
});

app.patch('/api/subjects/:id',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({code:z.string().min(1).max(30).optional(),name:z.string().min(2).max(120).optional(),stage:z.enum(['primary','jhs','both']).optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE subjects SET code=COALESCE($1,code),name=COALESCE($2,name),stage=COALESCE($3,stage),is_active=COALESCE($4,is_active) WHERE id=$5 AND organisation_id=$6 RETURNING *',[b.code?.toUpperCase()??null,b.name??null,b.stage??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'subject.updated','subject',id);return row;
});
app.delete('/api/subjects/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM subjects WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await db.query('DELETE FROM subjects WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'subject.deleted','subject',id,{name:row.name});return reply.code(204).send();
});

app.delete('/api/students/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await tx(db,async c=>{
    const guardians=(await c.query('SELECT guardian_id FROM student_guardians WHERE student_id=$1',[id])).rows.map((x:any)=>x.guardian_id);
    await c.query('DELETE FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    for(const gid of guardians)await c.query('DELETE FROM guardians g WHERE g.id=$1 AND g.organisation_id=$2 AND NOT EXISTS(SELECT 1 FROM student_guardians sg WHERE sg.guardian_id=g.id)',[gid,a.core.organisation_id]);
  });
  await audit(a.core.organisation_id,a.core.id,'student.deleted','student',id,{admissionNo:student.admission_no,name:`${student.first_name} ${student.last_name}`});return reply.code(204).send();
});
app.patch('/api/students/:studentId/guardians/:guardianId',async request=>{
  const a=await authorize(request,db,config,'students.manage');const p=z.object({studentId:z.string().uuid(),guardianId:z.string().uuid()}).parse(request.params);
  const b=z.object({firstName:z.string().min(1).max(100).optional(),lastName:z.string().min(1).max(100).optional(),phone:z.string().min(5).max(60).optional(),email:z.string().email().nullable().optional(),address:z.string().max(2000).nullable().optional(),relationship:z.string().min(2).max(60).optional(),isPrimary:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const linked=await maybeOne<any>(db,'SELECT 1 FROM student_guardians WHERE student_id=$1 AND guardian_id=$2',[p.studentId,p.guardianId]);if(!linked)throw fail(404,'Guardian link not found');
  if(b.isPrimary===true)await db.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[p.studentId]);
  await db.query(`UPDATE guardians SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),phone=COALESCE($3,phone),email=CASE WHEN $4 THEN $5 ELSE email END,address=CASE WHEN $6 THEN $7 ELSE address END,updated_at=now() WHERE id=$8 AND organisation_id=$9`,[b.firstName??null,b.lastName??null,b.phone??null,Object.hasOwn(b,'email'),b.email??null,Object.hasOwn(b,'address'),b.address??null,p.guardianId,a.core.organisation_id]);
  await db.query('UPDATE student_guardians SET relationship=COALESCE($1,relationship),is_primary=COALESCE($2,is_primary) WHERE student_id=$3 AND guardian_id=$4',[b.relationship??null,b.isPrimary??null,p.studentId,p.guardianId]);
  await audit(a.core.organisation_id,a.core.id,'guardian.updated','guardian',p.guardianId,{studentId:p.studentId});
  return one<any>(db,`SELECT g.*,sg.relationship,sg.is_primary FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id WHERE g.id=$1 AND sg.student_id=$2`,[p.guardianId,p.studentId]);
});
app.delete('/api/students/:studentId/guardians/:guardianId',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.manage');const p=z.object({studentId:z.string().uuid(),guardianId:z.string().uuid()}).parse(request.params);
  await db.query('DELETE FROM student_guardians WHERE student_id=$1 AND guardian_id=$2',[p.studentId,p.guardianId]);
  await db.query('DELETE FROM guardians g WHERE g.id=$1 AND g.organisation_id=$2 AND NOT EXISTS(SELECT 1 FROM student_guardians sg WHERE sg.guardian_id=g.id)',[p.guardianId,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'guardian.unlinked','guardian',p.guardianId,{studentId:p.studentId});return reply.code(204).send();
});
app.delete('/api/enrolments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'DELETE FROM enrolments WHERE id=$1 AND organisation_id=$2 RETURNING *',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'enrolment.deleted','enrolment',id,{studentId:row.student_id});return reply.code(204).send();
});

app.delete('/api/attendance',async(request,reply)=>{
  const a=await authorize(request,db,config,'attendance.manage');const q=z.object({classroomId:z.string().uuid(),date:z.string().date()}).parse(request.query);
  const result=await db.query('DELETE FROM attendance_records WHERE organisation_id=$1 AND classroom_id=$2 AND attendance_date=$3',[a.core.organisation_id,q.classroomId,q.date]);
  await audit(a.core.organisation_id,a.core.id,'attendance.cleared','classroom',q.classroomId,{date:q.date,count:result.rowCount??0});return reply.code(200).send({deleted:result.rowCount??0});
});

app.patch('/api/assessments/:id',async request=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(160).optional(),assessmentType:z.enum(['classwork','homework','project','test','exam','other']).optional(),maxScore:z.number().positive().optional(),weight:z.number().positive().max(100).optional(),assessmentDate:z.string().date().nullable().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE assessments SET name=COALESCE($1,name),assessment_type=COALESCE($2,assessment_type),max_score=COALESCE($3,max_score),weight=COALESCE($4,weight),assessment_date=CASE WHEN $5 THEN $6::date ELSE assessment_date END WHERE id=$7 AND organisation_id=$8 RETURNING *`,[b.name??null,b.assessmentType??null,b.maxScore??null,b.weight??null,Object.hasOwn(b,'assessmentDate'),b.assessmentDate??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment.updated','assessment',id);return row;
});
app.delete('/api/assessments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'DELETE FROM assessments WHERE id=$1 AND organisation_id=$2 RETURNING id,name',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment.deleted','assessment',id,{name:row.name});return reply.code(204).send();
});

app.patch('/api/fee-items/:id',async request=>{
  const a=await authorize(request,db,config,'fees.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(2).max(160).optional(),amount:z.number().min(0).optional(),mandatory:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE fee_items SET name=COALESCE($1,name),amount=COALESCE($2,amount),mandatory=COALESCE($3,mandatory) WHERE id=$4 AND organisation_id=$5 RETURNING *',[b.name??null,b.amount??null,b.mandatory??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'fee_item.updated','fee_item',id);return row;
});
app.delete('/api/fee-items/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const a=await authorize(request,db,config,'fees.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({reason:z.string().min(2).max(500)}).parse(request.body);
  const row=await one<any>(db,'UPDATE payments SET voided_at=now(),voided_by_os_user_id=$1,void_reason=$2 WHERE id=$3 AND organisation_id=$4 AND voided_at IS NULL RETURNING *',[a.core.id,b.reason,id,a.core.organisation_id]);
  if(row.student_fee_id){const calc=await one<any>(db,`SELECT sf.id,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid FROM student_fees sf LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.id=$1 GROUP BY sf.id`,[row.student_fee_id]);const status=Number(calc.paid)>=Number(calc.due)?'paid':Number(calc.paid)>0?'part_paid':'unpaid';await db.query('UPDATE student_fees SET status=$1 WHERE id=$2',[status,row.student_fee_id])}
  await audit(a.core.organisation_id,a.core.id,'payment.voided','payment',id,{reason:b.reason});return row;
});

app.patch('/api/timetable/:id',async request=>{
  const a=await authorize(request,db,config,'timetable.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({subjectId:z.string().uuid().optional(),teacherOsUserId:z.string().uuid().nullable().optional(),dayOfWeek:z.number().int().min(1).max(5).optional(),startTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),endTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),room:z.string().max(80).nullable().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE timetable_entries SET subject_id=COALESCE($1,subject_id),teacher_os_user_id=CASE WHEN $2 THEN $3 ELSE teacher_os_user_id END,day_of_week=COALESCE($4,day_of_week),start_time=COALESCE($5::time,start_time),end_time=COALESCE($6::time,end_time),room=CASE WHEN $7 THEN $8 ELSE room END WHERE id=$9 AND organisation_id=$10 RETURNING *`,[b.subjectId??null,Object.hasOwn(b,'teacherOsUserId'),b.teacherOsUserId??null,b.dayOfWeek??null,b.startTime??null,b.endTime??null,Object.hasOwn(b,'room'),b.room??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'timetable.updated','timetable_entry',id);return row;
});
app.delete('/api/timetable/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await one<any>(db,'DELETE FROM timetable_entries WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'timetable.deleted','timetable_entry',id);return reply.code(204).send();
});

app.patch('/api/staff/module-memberships/:id',async request=>{
  const a=await authorize(request,db,config,'school.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({role:z.enum(['school_admin','headteacher','teacher','bursar','registrar']).optional(),status:z.enum(['active','suspended']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,'UPDATE school_memberships SET role=COALESCE($1,role),status=COALESCE($2,status),updated_at=now() WHERE id=$3 AND organisation_id=$4 RETURNING *',[b.role??null,b.status??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'school_staff.updated','school_membership',id,{role:row.role,status:row.status});return row;
});
app.delete('/api/staff/module-memberships/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM school_memberships WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(row.os_user_id===a.core.id)throw fail(409,'You cannot remove your own School access');
  await db.query('DELETE FROM school_memberships WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'school_staff.removed','school_membership',id,{osUserId:row.os_user_id});return reply.code(204).send();
});


app.get('/api/teacher-assignments',async request=>{
  const a=await authorize(request,db,config,'school.manage');
  return (await db.query(`SELECT ta.*,c.name classroom_name,s.name subject_name
    FROM teacher_assignments ta
    JOIN classrooms c ON c.id=ta.classroom_id
    LEFT JOIN subjects s ON s.id=ta.subject_id
    WHERE ta.organisation_id=$1
    ORDER BY c.name,s.name NULLS FIRST,ta.created_at DESC`,[a.core.organisation_id])).rows;
});
app.post('/api/teacher-assignments',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');
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
  const a=await authorize(request,db,config,'school.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({isActive:z.boolean()}).parse(request.body);
  const row=await one<any>(db,'UPDATE teacher_assignments SET is_active=$1 WHERE id=$2 AND organisation_id=$3 RETURNING *',[b.isActive,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.updated','teacher_assignment',id,{isActive:b.isActive});return row;
});
app.delete('/api/teacher-assignments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await one<any>(db,'DELETE FROM teacher_assignments WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.deleted','teacher_assignment',id);return reply.code(204).send();
});

app.get('/api/grading-bands',async request=>{
  const a=await authorize(request,db,config);
  return (await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 ORDER BY sort_order,min_percentage DESC',[a.core.organisation_id])).rows;
});
app.post('/api/grading-bands',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');
  const b=z.object({name:z.string().min(1).max(40),minPercentage:z.number().min(0).max(100),maxPercentage:z.number().min(0).max(100),remark:z.string().max(120).optional(),sortOrder:z.number().int().default(0)}).parse(request.body);
  if(b.maxPercentage<b.minPercentage)throw fail(400,'Maximum percentage must be greater than or equal to minimum percentage');
  const row=await one<any>(db,'INSERT INTO grading_bands(organisation_id,name,min_percentage,max_percentage,remark,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.name,b.minPercentage,b.maxPercentage,b.remark??null,b.sortOrder]);
  await audit(a.core.organisation_id,a.core.id,'grading_band.created','grading_band',row.id);return reply.code(201).send(row);
});
app.patch('/api/grading-bands/:id',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({name:z.string().min(1).max(40).optional(),minPercentage:z.number().min(0).max(100).optional(),maxPercentage:z.number().min(0).max(100).optional(),remark:z.string().max(120).nullable().optional(),sortOrder:z.number().int().optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM grading_bands WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const min=b.minPercentage??Number(current.min_percentage),max=b.maxPercentage??Number(current.max_percentage);if(max<min)throw fail(400,'Maximum percentage must be greater than or equal to minimum percentage');
  const row=await one<any>(db,`UPDATE grading_bands SET name=COALESCE($1,name),min_percentage=COALESCE($2,min_percentage),max_percentage=COALESCE($3,max_percentage),remark=CASE WHEN $4 THEN $5 ELSE remark END,sort_order=COALESCE($6,sort_order),is_active=COALESCE($7,is_active) WHERE id=$8 AND organisation_id=$9 RETURNING *`,[b.name??null,b.minPercentage??null,b.maxPercentage??null,Object.hasOwn(b,'remark'),b.remark??null,b.sortOrder??null,b.isActive??null,id,a.core.organisation_id]);return row;
});
app.delete('/api/grading-bands/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const a=await authorize(request,db,config,'assessment.manage');const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),title:z.string().min(2).max(200),instructions:z.string().min(1).max(10000),dueAt:z.string().datetime().optional(),maxScore:z.number().positive().optional()}).parse(request.body);
  await ensureTeacherScope(a,b.classroomId,b.subjectId);
  const row=await one<any>(db,`INSERT INTO homework_assignments(organisation_id,academic_year_id,term_id,classroom_id,subject_id,title,instructions,due_at,max_score,created_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,b.title,b.instructions,b.dueAt??null,b.maxScore??null,a.core.id]);
  await audit(a.core.organisation_id,a.core.id,'homework.created','homework',row.id);return reply.code(201).send(row);
});
app.patch('/api/homework/:id',async request=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,current.classroom_id,current.subject_id);
  const b=z.object({title:z.string().min(2).max(200).optional(),instructions:z.string().min(1).max(10000).optional(),dueAt:z.string().datetime().nullable().optional(),maxScore:z.number().positive().nullable().optional(),status:z.enum(['draft','published','closed']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE homework_assignments SET title=COALESCE($1,title),instructions=COALESCE($2,instructions),due_at=CASE WHEN $3 THEN $4::timestamptz ELSE due_at END,max_score=CASE WHEN $5 THEN $6 ELSE max_score END,status=COALESCE($7,status),updated_at=now() WHERE id=$8 RETURNING *`,[b.title??null,b.instructions??null,Object.hasOwn(b,'dueAt'),b.dueAt??null,Object.hasOwn(b,'maxScore'),b.maxScore??null,b.status??null,id]);
  return row;
});
app.post('/api/homework/:id/publish',async request=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  return tx(db,async c=>{const row=await one<any>(c,"UPDATE homework_assignments SET status='published',updated_at=now() WHERE id=$1 RETURNING *",[id]);await c.query(`INSERT INTO homework_submissions(homework_id,student_id) SELECT $1,e.student_id FROM enrolments e WHERE e.classroom_id=$2 AND e.status='active' ON CONFLICT(homework_id,student_id) DO NOTHING`,[id,h.classroom_id]);await audit(a.core.organisation_id,a.core.id,'homework.published','homework',id);return row});
});
app.get('/api/homework/:id/submissions',async request=>{
  const a=await authorize(request,db,config);const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  return (await db.query(`SELECT hs.*,s.admission_no,s.first_name,s.last_name FROM homework_submissions hs JOIN students s ON s.id=hs.student_id WHERE hs.homework_id=$1 ORDER BY s.last_name,s.first_name`,[id])).rows;
});
app.post('/api/homework/:id/submissions',async request=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  const b=z.object({records:z.array(z.object({studentId:z.string().uuid(),status:z.enum(['not_submitted','submitted','late','graded']),score:z.number().min(0).nullable().optional(),teacherComment:z.string().max(1000).nullable().optional()})).min(1).max(200)}).parse(request.body);
  for(const r of b.records)if(r.score!=null&&h.max_score!=null&&r.score>Number(h.max_score))throw fail(400,`Homework score cannot exceed ${h.max_score}`);
  await tx(db,async c=>{for(const r of b.records)await c.query(`INSERT INTO homework_submissions(homework_id,student_id,status,submitted_at,score,teacher_comment) VALUES($1,$2,$3,CASE WHEN $3 IN('submitted','late','graded') THEN now() ELSE NULL END,$4,$5) ON CONFLICT(homework_id,student_id) DO UPDATE SET status=EXCLUDED.status,submitted_at=COALESCE(homework_submissions.submitted_at,EXCLUDED.submitted_at),score=EXCLUDED.score,teacher_comment=EXCLUDED.teacher_comment,updated_at=now()`,[id,r.studentId,r.status,r.score??null,r.teacherComment??null])});return{saved:b.records.length};
});
app.delete('/api/homework/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  await db.query('DELETE FROM homework_assignments WHERE id=$1',[id]);await audit(a.core.organisation_id,a.core.id,'homework.deleted','homework',id);return reply.code(204).send();
});

app.get('/api/announcements',async request=>{
  const a=await authorize(request,db,config);return (await db.query(`SELECT a.*,c.name classroom_name FROM school_announcements a LEFT JOIN classrooms c ON c.id=a.classroom_id WHERE a.organisation_id=$1 ORDER BY a.created_at DESC`,[a.core.organisation_id])).rows;
});
app.post('/api/announcements',async(request,reply)=>{
  const a=await authorize(request,db,config,'school.manage');const b=z.object({audience:z.enum(['all','staff','parents','students','class']),classroomId:z.string().uuid().nullable().optional(),title:z.string().min(2).max(200),body:z.string().min(1).max(10000),status:z.enum(['draft','published']).default('draft')}).parse(request.body);
  if(b.audience==='class'&&!b.classroomId)throw fail(400,'A classroom is required for class announcements');
  const row=await one<any>(db,`INSERT INTO school_announcements(organisation_id,audience,classroom_id,title,body,status,published_at,created_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='published' THEN now() ELSE NULL END,$7) RETURNING *`,[a.core.organisation_id,b.audience,b.classroomId??null,b.title,b.body,b.status,a.core.id]);await audit(a.core.organisation_id,a.core.id,'announcement.created','announcement',row.id);return reply.code(201).send(row);
});
app.patch('/api/announcements/:id',async request=>{
  const a=await authorize(request,db,config,'school.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({audience:z.enum(['all','staff','parents','students','class']).optional(),classroomId:z.string().uuid().nullable().optional(),title:z.string().min(2).max(200).optional(),body:z.string().min(1).max(10000).optional(),status:z.enum(['draft','published','archived']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE school_announcements SET audience=COALESCE($1,audience),classroom_id=CASE WHEN $2 THEN $3 ELSE classroom_id END,title=COALESCE($4,title),body=COALESCE($5,body),status=COALESCE($6,status),published_at=CASE WHEN $6='published' AND published_at IS NULL THEN now() WHEN $6 IS NULL THEN published_at ELSE published_at END,updated_at=now() WHERE id=$7 AND organisation_id=$8 RETURNING *`,[b.audience??null,Object.hasOwn(b,'classroomId'),b.classroomId??null,b.title??null,b.body??null,b.status??null,id,a.core.organisation_id]);return row;
});
app.delete('/api/announcements/:id',async(request,reply)=>{const a=await authorize(request,db,config,'school.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);await one<any>(db,'DELETE FROM school_announcements WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);return reply.code(204).send()});

app.get('/api/report-comments/:studentId',async request=>{
  const a=await authorize(request,db,config,'reports.read');const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);const q=z.object({termId:z.string().uuid()}).parse(request.query);
  return (await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,q.termId]))??null;
});
app.put('/api/report-comments/:studentId',async request=>{
  const a=await authorize(request,db,config,'assessment.manage');const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);const b=z.object({termId:z.string().uuid(),classTeacherComment:z.string().max(4000).nullable().optional(),headteacherComment:z.string().max(4000).nullable().optional(),conduct:z.string().max(80).nullable().optional(),interest:z.string().max(1000).nullable().optional(),nextTermBegins:z.string().date().nullable().optional()}).parse(request.body);
  const row=await one<any>(db,`INSERT INTO report_comments(organisation_id,student_id,term_id,class_teacher_comment,headteacher_comment,conduct,interest,next_term_begins,updated_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(student_id,term_id) DO UPDATE SET class_teacher_comment=EXCLUDED.class_teacher_comment,headteacher_comment=EXCLUDED.headteacher_comment,conduct=EXCLUDED.conduct,interest=EXCLUDED.interest,next_term_begins=EXCLUDED.next_term_begins,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now() RETURNING *`,[a.core.organisation_id,studentId,b.termId,b.classTeacherComment??null,b.headteacherComment??null,b.conduct??null,b.interest??null,b.nextTermBegins??null,a.core.id]);return row;
});

app.post('/api/promotions/batch',async request=>{
  const a=await authorize(request,db,config,'academic.manage');const b=z.object({fromAcademicYearId:z.string().uuid(),toAcademicYearId:z.string().uuid(),records:z.array(z.object({studentId:z.string().uuid(),toClassroomId:z.string().uuid().nullable().optional(),outcome:z.enum(['promoted','repeated','completed'])})).min(1).max(300)}).parse(request.body);
  return tx(db,async c=>{
    let processed=0;
    for(const r of b.records){
      const old=await maybeOne<any>(c,'SELECT * FROM enrolments WHERE student_id=$1 AND academic_year_id=$2 AND organisation_id=$3',[r.studentId,b.fromAcademicYearId,a.core.organisation_id]);if(!old)continue;
      if(r.outcome!=='completed'&&!r.toClassroomId)throw fail(400,'A destination class is required for promoted or repeated students');
      if(r.outcome==='completed'){
        await c.query("UPDATE enrolments SET status='completed' WHERE id=$1",[old.id]);await c.query("UPDATE students SET status='graduated',updated_at=now() WHERE id=$1",[r.studentId]);
      }else{
        await c.query("UPDATE enrolments SET status=$1 WHERE id=$2",[r.outcome==='promoted'?'promoted':'repeated',old.id]);
        await c.query(`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status) VALUES($1,$2,$3,$4,'active') ON CONFLICT(student_id,academic_year_id) DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status='active',enrolled_at=now()`,[a.core.organisation_id,r.studentId,b.toAcademicYearId,r.toClassroomId]);
      }
      await c.query(`INSERT INTO student_promotions(organisation_id,student_id,from_academic_year_id,to_academic_year_id,from_classroom_id,to_classroom_id,outcome,processed_by_os_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(student_id,to_academic_year_id) DO UPDATE SET from_classroom_id=EXCLUDED.from_classroom_id,to_classroom_id=EXCLUDED.to_classroom_id,outcome=EXCLUDED.outcome,processed_by_os_user_id=EXCLUDED.processed_by_os_user_id,created_at=now()`,[a.core.organisation_id,r.studentId,b.fromAcademicYearId,b.toAcademicYearId,old.classroom_id,r.toClassroomId??null,r.outcome,a.core.id]);
      processed++;
    }
    await audit(a.core.organisation_id,a.core.id,'students.promoted','academic_year',b.toAcademicYearId,{processed});
    return{processed};
  });
});
app.get('/api/promotions',async request=>{const a=await authorize(request,db,config,'reports.read');return (await db.query(`SELECT p.*,s.admission_no,s.first_name,s.last_name,fc.name from_class,tc.name to_class,fy.name from_year,ty.name to_year FROM student_promotions p JOIN students s ON s.id=p.student_id LEFT JOIN classrooms fc ON fc.id=p.from_classroom_id LEFT JOIN classrooms tc ON tc.id=p.to_classroom_id JOIN academic_years fy ON fy.id=p.from_academic_year_id JOIN academic_years ty ON ty.id=p.to_academic_year_id WHERE p.organisation_id=$1 ORDER BY p.created_at DESC`,[a.core.organisation_id])).rows});

app.post('/api/guardians/:id/portal-reset',async request=>{
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);await ensureGuardianStudent(g.guardian_id,id);
  const term=await maybeOne<any>(db,`SELECT t.* FROM terms t WHERE t.organisation_id=$1 AND t.status IN('active','closed') ORDER BY CASE WHEN t.status='active' THEN 0 ELSE 1 END,t.end_date DESC LIMIT 1`,[g.organisation_id]);if(!term)return{term:null,subjects:[],comments:null};
  const subjects=(await db.query(`SELECT sub.name subject_name,ROUND(AVG((sc.score/a.max_score)*100)::numeric,2) percentage FROM assessments a JOIN subjects sub ON sub.id=a.subject_id JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$1 WHERE a.organisation_id=$2 AND a.term_id=$3 GROUP BY sub.id,sub.name ORDER BY sub.name`,[id,g.organisation_id,term.id])).rows;
  const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[g.organisation_id])).rows;
  const graded=subjects.map((s:any)=>{const pct=Number(s.percentage),band=bands.find((b:any)=>pct>=Number(b.min_percentage)&&pct<=Number(b.max_percentage));return{...s,grade:band?.name??'',remark:band?.remark??''}});
  const comments=await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[g.organisation_id,id,term.id]);
  return{term,subjects:graded,comments};
});

app.get('/api/payments/:id/receipt',async request=>{
  const a=await authorize(request,db,config,'fees.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
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
  const term=await maybeOne<any>(db,`SELECT * FROM terms WHERE organisation_id=$1 AND status IN('active','closed') ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,end_date DESC LIMIT 1`,[s.organisation_id]);if(!term)return{term:null,subjects:[],comments:null};
  const subjects=(await db.query(`SELECT sub.name subject_name,ROUND(AVG((sc.score/a.max_score)*100)::numeric,2) percentage FROM assessments a JOIN subjects sub ON sub.id=a.subject_id JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$1 WHERE a.organisation_id=$2 AND a.term_id=$3 GROUP BY sub.id,sub.name ORDER BY sub.name`,[s.student_id,s.organisation_id,term.id])).rows;
  const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[s.organisation_id])).rows;
  const graded=subjects.map((x:any)=>{const pct=Number(x.percentage),band=bands.find((b:any)=>pct>=Number(b.min_percentage)&&pct<=Number(b.max_percentage));return{...x,grade:band?.name??'',remark:band?.remark??''}});
  const comments=await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[s.organisation_id,s.student_id,term.id]);
  return{term,subjects:graded,comments};
});

app.get('/api/public/school',async()=>{
  const school=await maybeOne<any>(db,'SELECT organisation_id,school_name,short_name,motto,phone,email,address FROM school_profiles ORDER BY created_at LIMIT 1');if(!school)throw fail(404,'School admissions are not configured');
  const grades=(await db.query('SELECT code,name,stage FROM grade_levels WHERE organisation_id=$1 AND is_active=true ORDER BY level_order',[school.organisation_id])).rows;
  return{school,grades};
});
app.post('/api/public/admissions',async(request,reply)=>{
  const school=await maybeOne<any>(db,'SELECT organisation_id FROM school_profiles ORDER BY created_at LIMIT 1');if(!school)throw fail(404,'School admissions are not configured');
  const b=z.object({firstName:z.string().min(1).max(100),middleName:z.string().max(100).optional(),lastName:z.string().min(1).max(100),sex:z.enum(['male','female']).optional(),dateOfBirth:z.string().date().optional(),requestedGradeCode:z.string().min(1).max(20),previousSchool:z.string().max(240).optional(),guardianFirstName:z.string().min(1).max(100),guardianLastName:z.string().min(1).max(100),guardianPhone:z.string().min(5).max(60),guardianEmail:z.string().email().optional(),guardianRelationship:z.string().min(2).max(60),address:z.string().max(2000).optional(),notes:z.string().max(5000).optional()}).parse(request.body);
  const grade=await maybeOne<any>(db,'SELECT 1 FROM grade_levels WHERE organisation_id=$1 AND code=$2 AND is_active=true',[school.organisation_id,b.requestedGradeCode]);if(!grade)throw fail(400,'Requested grade is not available');
  const applicationNo='ADM-'+new Date().getUTCFullYear()+'-'+randomBytes(3).toString('hex').toUpperCase();
  const row=await one<any>(db,`INSERT INTO admission_applications(organisation_id,application_no,first_name,middle_name,last_name,sex,date_of_birth,requested_grade_code,previous_school,guardian_first_name,guardian_last_name,guardian_phone,guardian_email,guardian_relationship,address,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,application_no,status`,[school.organisation_id,applicationNo,b.firstName,b.middleName??null,b.lastName,b.sex??null,b.dateOfBirth??null,b.requestedGradeCode,b.previousSchool??null,b.guardianFirstName,b.guardianLastName,b.guardianPhone,b.guardianEmail??null,b.guardianRelationship,b.address??null,b.notes??null]);
  return reply.code(201).send({id:row.id,applicationNo:row.application_no,status:row.status});
});
app.get('/api/public/admissions/status',async request=>{
  const q=z.object({applicationNo:z.string().min(1).max(40),phone:z.string().min(5).max(60)}).parse(request.query);
  const row=await maybeOne<any>(db,'SELECT application_no,status,review_note,submitted_at,updated_at FROM admission_applications WHERE application_no=$1 AND guardian_phone=$2',[q.applicationNo,q.phone]);if(!row)throw fail(404,'Application not found');
  return{applicationNo:row.application_no,status:row.status,reviewNote:row.review_note,submittedAt:row.submitted_at,updatedAt:row.updated_at};
});
app.get('/api/admissions',async request=>{
  const a=await authorize(request,db,config,'students.manage');const q=z.object({status:z.enum(['submitted','under_review','approved','waitlisted','declined','enrolled']).optional()}).parse(request.query);
  return (await db.query(`SELECT aa.*,gl.name requested_grade_name FROM admission_applications aa LEFT JOIN grade_levels gl ON gl.organisation_id=aa.organisation_id AND gl.code=aa.requested_grade_code WHERE aa.organisation_id=$1 AND ($2::text IS NULL OR aa.status=$2) ORDER BY aa.submitted_at DESC`,[a.core.organisation_id,q.status??null])).rows;
});
app.patch('/api/admissions/:id',async request=>{
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({status:z.enum(['submitted','under_review','approved','waitlisted','declined']),reviewNote:z.string().max(5000).nullable().optional()}).parse(request.body);
  const row=await one<any>(db,`UPDATE admission_applications SET status=$1,review_note=CASE WHEN $2 THEN $3 ELSE review_note END,reviewed_by_os_user_id=$4,reviewed_at=now(),updated_at=now() WHERE id=$5 AND organisation_id=$6 AND status<>'enrolled' RETURNING *`,[b.status,Object.hasOwn(b,'reviewNote'),b.reviewNote??null,a.core.id,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'admission.reviewed','admission_application',id,{status:b.status});return row;
});
app.post('/api/admissions/:id/enrol',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({admissionNo:z.string().min(1).max(60),classroomId:z.string().uuid().optional()}).parse(request.body);
  const result=await tx(db,async c=>{
    const appRow=await one<any>(c,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
    if(appRow.status!=='approved')throw fail(409,'Approve the application before enrolling the student');
    const student=await one<any>(c,`INSERT INTO students(organisation_id,admission_no,first_name,middle_name,last_name,sex,date_of_birth,admission_date,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,current_date,'active',$8) RETURNING *`,[a.core.organisation_id,b.admissionNo,appRow.first_name,appRow.middle_name,appRow.last_name,appRow.sex,appRow.date_of_birth,appRow.notes]);
    const guardian=await one<any>(c,`INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[a.core.organisation_id,appRow.guardian_first_name,appRow.guardian_last_name,appRow.guardian_phone,appRow.guardian_email,appRow.address]);
    await c.query('INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary) VALUES($1,$2,$3,true)',[student.id,guardian.id,appRow.guardian_relationship]);
    if(b.classroomId){
      const classroom=await one<any>(c,'SELECT id,academic_year_id FROM classrooms WHERE id=$1 AND organisation_id=$2',[b.classroomId,a.core.organisation_id]);
      await c.query(`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status) VALUES($1,$2,$3,$4,'active')`,[a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id]);
    }
    await c.query(`UPDATE admission_applications SET status='enrolled',student_id=$1,reviewed_by_os_user_id=$2,reviewed_at=now(),updated_at=now() WHERE id=$3`,[student.id,a.core.id,id]);
    return{student,guardian};
  });
  await audit(a.core.organisation_id,a.core.id,'admission.enrolled','admission_application',id,{studentId:result.student.id});
  return reply.code(201).send(result);
});

app.get('/api/audit',async request=>{const a=await authorize(request,db,config,'reports.read');return (await db.query('SELECT * FROM school_audit_logs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 100',[a.core.organisation_id])).rows});

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
