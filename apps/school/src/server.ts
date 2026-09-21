import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { Script } from 'node:vm';
import { createRequire } from 'node:module';
import { loadSchoolConfig } from './config.js';
import { createSchoolDb, ensureSchoolSchema, migrateSchool, maybeOne, one, tx } from './db.js';
import { authorize, effectiveCapabilities, schoolRoleProfile } from './auth.js';
import { schoolFrontend, schoolAppScript } from './ui.js';
import { parentFrontend } from './parent-ui.js';
import { teacherFrontend } from './teacher-ui.js';
import { studentFrontend } from './student-ui.js';
import { admissionsFrontend } from './admissions-ui.js';
import { loginFrontend } from './login-ui.js';
import { schoolDesignCss, schoolDesignScript } from './school-design.js';
import { initializePaystack, providerStatus, sendMessage, validateBrevoConnection, verifyPaystack, type MessageChannel } from './providers.js';
import { registerFinanceLeaveRoutes } from './finance-leave-routes.js';
import { registerAccountingRoutes } from './accounting-routes.js';
import {
  assertPortalLoginAllowed,
  clearPortalLoginThrottle,
  recordPortalLoginFailure,
  retryCommunicationOutbox,
  throttleFingerprint
} from './reliability.js';

const require=createRequire(import.meta.url);
const PDFDocument:any=require('pdfkit');

const config=loadSchoolConfig();
const db=createSchoolDb(config);
await ensureSchoolSchema(db);
await migrateSchool(db);

// Refuse to start a deployment if the generated browser application contains invalid JavaScript.
// This prevents production from going live with a permanent "Connecting to Core" splash.
new Script(schoolAppScript,{filename:'school-app.js'});

const app=Fastify({logger:config.NODE_ENV!=='test',trustProxy:true});
app.log.info({emailProvider:config.EMAIL_PROVIDER,brevoApiKeyPresent:Boolean(config.BREVO_API_KEY),brevoFromEmailPresent:Boolean(config.BREVO_FROM_EMAIL),brevoFromNamePresent:Boolean(config.BREVO_FROM_NAME)},'Email provider startup status');
if(config.BREVO_API_KEY){void validateBrevoConnection(config).then(result=>app.log.info({provider:'brevo',authenticated:result.authenticated,senderReady:result.senderReady,senderSource:result.senderSource},'Brevo connection verified')).catch(error=>app.log.warn({provider:'brevo',error:String(error?.message||error)},'Brevo connection verification failed'));}
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(cors,{origin:config.CORS_ORIGINS==='*'?true:config.CORS_ORIGINS.split(',').map(x=>x.trim()),credentials:true});

const requestStartedAt=new Map<string,number>();
function requestSessionToken(request:any){
  const auth=String(request.headers?.authorization||'');
  if(/^Bearer\s+rxs_/i.test(auth))return auth.replace(/^Bearer\s+/i,'').trim();
  const cookie=String(request.headers?.cookie||'').split(';').map((x:string)=>x.trim()).find((x:string)=>x.startsWith('rx_school_session='));
  return cookie?decodeURIComponent(cookie.slice('rx_school_session='.length)):'';
}
async function requestActor(request:any){
  const auth=String(request.headers?.authorization||'');
  const bearer=/^Bearer\s+/i.test(auth)?auth.replace(/^Bearer\s+/i,'').trim():'';
  const schoolToken=requestSessionToken(request);

  if(schoolToken&&schoolToken.startsWith('rxs_')){
    const hash=createHash('sha256').update(schoolToken).digest('hex');
    const row=await maybeOne<any>(db,'SELECT organisation_id,os_user_id FROM school_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[hash]);
    if(row)return{organisationId:row.organisation_id,userId:row.os_user_id,actorType:'staff'};
  }

  if(bearer){
    const hash=createHash('sha256').update(bearer).digest('hex');
    const guardian=await maybeOne<any>(db,`SELECT g.organisation_id,g.id guardian_id
      FROM guardian_portal_sessions gps JOIN guardians g ON g.id=gps.guardian_id
      WHERE gps.token_hash=$1 AND gps.revoked_at IS NULL AND gps.expires_at>now() LIMIT 1`,[hash]);
    if(guardian)return{organisationId:guardian.organisation_id,userId:null,actorType:'guardian',portalActorId:guardian.guardian_id};

    const student=await maybeOne<any>(db,`SELECT s.organisation_id,s.id student_id
      FROM student_portal_sessions sps JOIN students s ON s.id=sps.student_id
      WHERE sps.token_hash=$1 AND sps.revoked_at IS NULL AND sps.expires_at>now() LIMIT 1`,[hash]);
    if(student)return{organisationId:student.organisation_id,userId:null,actorType:'student',portalActorId:student.student_id};
  }

  const school=await maybeOne<any>(db,'SELECT organisation_id FROM school_profiles ORDER BY created_at LIMIT 1');
  return{organisationId:school?.organisation_id??null,userId:null,actorType:'public'};
}
app.addHook('onRequest',async request=>{requestStartedAt.set(String(request.id),Date.now())});
app.addHook('onResponse',async(request,reply)=>{
  const started=requestStartedAt.get(String(request.id))??Date.now();requestStartedAt.delete(String(request.id));
  if(!request.url.startsWith('/api/'))return;
  try{
    const actor=await requestActor(request);
    const status=reply.statusCode;
    await db.query(`INSERT INTO system_request_logs(
      organisation_id,actor_os_user_id,request_id,method,path,status_code,duration_ms,outcome
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[
      actor.organisationId,actor.userId,String(request.id),request.method,String(request.url).split('?')[0],
      status,Date.now()-started,status>=500?'server_error':status>=400?'client_error':'success'
    ]);
    if(actor.actorType==='guardian'||actor.actorType==='student'){
      request.log.info({requestId:String(request.id),actorType:actor.actorType,portalActorId:actor.portalActorId,path:String(request.url).split('?')[0]},'Portal request recorded');
    }
  }catch(error){request.log.warn({error},'Could not persist system request log')}
});

const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
async function audit(organisationId:string,userId:string,action:string,resourceType:string,resourceId?:string|null,metadata:any={}){
  await db.query('INSERT INTO school_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[organisationId,userId,action,resourceType,resourceId??null,JSON.stringify(metadata)]);
}
async function changeLog(input:{
  organisationId:string;
  actorOsUserId?:string|null;
  action:string;
  resourceType:string;
  resourceId?:string|null;
  performedOn?:string|null;
  oldValue?:any;
  newValue?:any;
  metadata?:any;
}){
  await db.query(`INSERT INTO school_change_logs(
    organisation_id,actor_os_user_id,action,resource_type,resource_id,performed_on,old_value,new_value,metadata
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[
    input.organisationId,input.actorOsUserId??null,input.action,input.resourceType,input.resourceId??null,input.performedOn??null,
    input.oldValue==null?null:JSON.stringify(input.oldValue),input.newValue==null?null:JSON.stringify(input.newValue),
    JSON.stringify(input.metadata??{})
  ]);
}
async function createSchoolStaffSession(coreContext:any,source:'core_exchange'|'preview'='core_exchange'){
  const localToken='rxs_'+randomBytes(48).toString('base64url');
  const tokenHash=createHash('sha256').update(localToken).digest('hex');
  const expiresAt=new Date(Date.now()+8*60*60*1000);
  await db.query(`INSERT INTO school_sessions(
      token_hash,organisation_id,os_user_id,core_context,source,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6)`,[
      tokenHash,coreContext.organisation_id,coreContext.id,JSON.stringify(coreContext),source,expiresAt.toISOString()
    ]);
  return{localToken,expiresAt};
}

async function activeYear(org:string){
  return maybeOne<any>(db,"SELECT * FROM academic_years WHERE organisation_id=$1 AND status='active' ORDER BY start_date DESC LIMIT 1",[org]);
}
async function activeTerm(org:string){
  return maybeOne<any>(db,"SELECT t.* FROM terms t JOIN academic_years y ON y.id=t.academic_year_id WHERE t.organisation_id=$1 AND y.status='active' AND t.status='active' ORDER BY t.term_no LIMIT 1",[org]);
}

async function ensureTeachingRole(a:any){
  const profile=await schoolRoleProfile(db,a.core.organisation_id,a.role);
  if(!profile||profile.is_active===false||profile.portal_mode!=='teacher')throw fail(403,'Teacher workspace access is not enabled for this school role');
  return profile;
}

function coreServiceHeaders(){
  if(!config.CORE_SERVICE_KEY)throw fail(503,'Core service authentication is not configured');
  return {'x-revolt-service-key':config.CORE_SERVICE_KEY};
}

const coreUsersCache=new Map<string,{value:any[];expiresAt:number}>();
const CORE_USERS_CACHE_MS=300_000;
const CORE_SERVICE_TRANSIENT_STATUSES=new Set([429,502,503,504]);

async function fetchCoreUsers(organisationId:string){
  const cached=coreUsersCache.get(organisationId);
  if(cached&&cached.expiresAt>Date.now())return cached.value;

  const url=config.CORE_OS_URL.replace(/\/$/,'')+'/v1/internal/school/users?organisationId='+encodeURIComponent(organisationId);
  let lastError='Core OS staff directory is temporarily unavailable';

  for(let attempt=0;attempt<3;attempt++){
    try{
      const res=await fetch(url,{headers:coreServiceHeaders(),signal:AbortSignal.timeout(6000)});
      const payload=await res.json().catch(()=>null) as any;
      if(res.ok){
        const value=Array.isArray(payload)?payload:[];
        coreUsersCache.set(organisationId,{value,expiresAt:Date.now()+CORE_USERS_CACHE_MS});
        return value;
      }
      lastError=payload?.error?.message||lastError;
      if(!CORE_SERVICE_TRANSIENT_STATUSES.has(res.status))break;
    }catch(error:any){
      lastError=String(error?.message||lastError);
    }
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,[500,1000][attempt]||1000));
  }

  if(cached)return cached.value;
  return[] as any[];
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
  let row=await one<any>(db,`INSERT INTO communication_outbox(
      organisation_id,channel,recipient_name,recipient_address,subject,body,template_key,related_type,related_id,status,created_by_os_user_id,next_attempt_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12 THEN now() ELSE now()+interval '15 minutes' END) RETURNING *`,[
      input.organisationId,input.channel,input.recipientName??null,input.recipientAddress,input.subject??null,input.body,
      input.templateKey??null,input.relatedType??null,input.relatedId??null,configured?'queued':'pending_configuration',input.actorOsUserId??null,configured
    ]);
  if(!configured)return row;
  try{
    row=await one<any>(db,`UPDATE communication_outbox
      SET status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),next_attempt_at=NULL
      WHERE id=$1 RETURNING *`,[row.id]);
    const sent=await sendMessage(config,{
      channel:input.channel,
      to:input.channel==='email'?input.recipientAddress:normalizePhone(input.recipientAddress),
      subject:input.subject,
      recipientName:input.recipientName,
      body:input.body
    });
    return await one<any>(db,`UPDATE communication_outbox
      SET status='sent',provider=$1,provider_message_id=$2,sent_at=now(),last_error=NULL,next_attempt_at=NULL
      WHERE id=$3 RETURNING *`,[sent.provider,sent.messageId,row.id]);
  }catch(error:any){
    return await one<any>(db,`UPDATE communication_outbox
      SET status='failed',last_error=$1,next_attempt_at=CASE WHEN attempt_count>=max_attempts THEN NULL ELSE now()+interval '1 minute' END
      WHERE id=$2 RETURNING *`,[String(error?.message||error).slice(0,4000),row.id]);
  }
}

async function notifyContact(input:{
  organisationId:string;
  actorOsUserId?:string|null|undefined;
  guardianId?:string|null|undefined;
  eventKey:string;
  name?:string|null|undefined;
  email?:string|null|undefined;
  phone?:string|null|undefined;
  subject:string;
  body:string;
  relatedType?:string|null|undefined;
  relatedId?:string|null|undefined;
}){
  if(input.guardianId){
    await db.query(`
      INSERT INTO guardian_notifications(
        organisation_id,guardian_id,event_key,subject,body,related_type,related_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING
    `,[
      input.organisationId,input.guardianId,input.eventKey,input.subject,input.body,
      input.relatedType??null,input.relatedId??null
    ]);
  }
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

async function financeAccountByCode(client:any,organisationId:string,code:string){
  return one<any>(client,'SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code=$2 AND is_active=true',[organisationId,code]);
}

async function postFinanceJournal(client:any,input:{
  organisationId:string;
  entryDate?:string|null;
  description:string;
  sourceType?:string|null;
  sourceId?:string|null;
  reference?:string|null;
  actorOsUserId?:string|null;
  lines:{accountId:string;debit?:number;credit?:number;description?:string|null}[];
}){
  const debit=input.lines.reduce((s,x)=>s+Number(x.debit||0),0),credit=input.lines.reduce((s,x)=>s+Number(x.credit||0),0);
  if(Math.abs(debit-credit)>0.005||debit<=0)throw fail(400,'Finance journal must balance');
  if(input.sourceType&&input.sourceId){
    const existing=await maybeOne<any>(client,`SELECT * FROM finance_journal_entries
      WHERE organisation_id=$1 AND source_type=$2 AND source_id=$3 AND status<>'voided'`,
      [input.organisationId,input.sourceType,input.sourceId]);
    if(existing)return existing;
  }
  const entryNo='JRN-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+randomBytes(4).toString('hex').toUpperCase();
  const entry=await one<any>(client,`INSERT INTO finance_journal_entries(
      organisation_id,entry_no,entry_date,description,source_type,source_id,status,reference,created_by_os_user_id,posted_at
    ) VALUES($1,$2,COALESCE($3::date,current_date),$4,$5,$6,'posted',$7,$8,now()) RETURNING *`,[
      input.organisationId,entryNo,input.entryDate??null,input.description,input.sourceType??null,input.sourceId??null,input.reference??null,input.actorOsUserId??null
    ]);
  for(const line of input.lines){
    await client.query(`INSERT INTO finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
      VALUES($1,$2,$3,$4,$5)`,[entry.id,line.accountId,line.description??null,Number(line.debit||0),Number(line.credit||0)]);
  }
  return entry;
}

async function reverseFinanceJournal(client:any,organisationId:string,originalId:string,actorOsUserId:string,reason:string,sourceType:string,sourceId:string){
  const original=await one<any>(client,'SELECT * FROM finance_journal_entries WHERE id=$1 AND organisation_id=$2',[originalId,organisationId]);
  if(original.reversal_entry_id)return one<any>(client,'SELECT * FROM finance_journal_entries WHERE id=$1',[original.reversal_entry_id]);
  const lines=(await client.query('SELECT * FROM finance_journal_lines WHERE journal_entry_id=$1 ORDER BY id',[originalId])).rows;
  if(!lines.length)throw fail(409,'The original journal has no lines to reverse');
  const reversal=await postFinanceJournal(client,{
    organisationId,entryDate:new Date().toISOString().slice(0,10),
    description:'REVERSAL: '+original.description+' • '+reason,
    sourceType,sourceId,reference:original.reference??null,actorOsUserId,
    lines:lines.map((x:any)=>({accountId:x.account_id,debit:Number(x.credit),credit:Number(x.debit),description:'Reversal of '+(x.description||original.entry_no)}))
  });
  await client.query('UPDATE finance_journal_entries SET reversed_at=now(),reversed_by_os_user_id=$1,reversal_entry_id=$2 WHERE id=$3',
    [actorOsUserId,reversal.id,originalId]);
  return reversal;
}

async function applyStudentCreditsToFee(client:any,studentFeeId:string,actorOsUserId?:string|null){
  const fee=await one<any>(client,`SELECT sf.*,f.name fee_name,s.admission_no,s.first_name,s.last_name,
      (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
    FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id JOIN students s ON s.id=sf.student_id
    WHERE sf.id=$1 FOR UPDATE`,[studentFeeId]);
  let remaining=Math.max(0,Number(fee.balance||0));
  if(remaining<=0.004)return{applied:0};
  const credits=(await client.query(`SELECT * FROM student_account_credits
    WHERE organisation_id=$1 AND student_id=$2 AND status='open' AND balance>0
    ORDER BY created_at,id FOR UPDATE`,[fee.organisation_id,fee.student_id])).rows;
  if(!credits.length)return{applied:0};
  const deposit=await financeAccountByCode(client,fee.organisation_id,'2200');
  const ar=await financeAccountByCode(client,fee.organisation_id,'1100');
  let applied=0;
  for(const credit of credits){
    if(remaining<=0.004)break;
    const amount=Math.min(remaining,Number(credit.balance));
    if(amount<=0)continue;
    const payment=await one<any>(client,`INSERT INTO payments(
      organisation_id,student_id,student_fee_id,amount,payment_method,reference,paid_at,received_by_os_user_id,note,source
    ) VALUES($1,$2,$3,$4,'other',$5,now(),$6,$7,'credit_applied') RETURNING *`,[
      fee.organisation_id,fee.student_id,fee.id,amount,'CREDIT-'+String(credit.id).slice(0,8).toUpperCase(),actorOsUserId??null,
      'Applied from student advance / overpayment credit'
    ]);
    const application=await one<any>(client,`INSERT INTO student_credit_applications(
      organisation_id,credit_id,student_fee_id,payment_id,amount,created_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[
      fee.organisation_id,credit.id,fee.id,payment.id,amount,actorOsUserId??null
    ]);
    const journal=await postFinanceJournal(client,{
      organisationId:fee.organisation_id,entryDate:new Date().toISOString().slice(0,10),
      description:'Apply student credit - '+fee.first_name+' '+fee.last_name+' ('+fee.admission_no+') - '+fee.fee_name,
      sourceType:'student_credit_application',sourceId:application.id,reference:payment.reference,actorOsUserId:actorOsUserId??null,
      lines:[
        {accountId:deposit.id,debit:amount,description:'Release student deposit / credit'},
        {accountId:ar.id,credit:amount,description:'Settle '+fee.fee_name+' receivable'}
      ]
    });
    await client.query('UPDATE student_credit_applications SET journal_entry_id=$1 WHERE id=$2',[journal.id,application.id]);
    const newBalance=Math.max(0,Number(credit.balance)-amount);
    await client.query("UPDATE student_account_credits SET balance=$1,status=$2,updated_at=now() WHERE id=$3",
      [newBalance,newBalance<=0.004?'used':'open',credit.id]);
    remaining-=amount;applied+=amount;
  }
  await updateStudentFeeStatus(client,studentFeeId);
  return{applied};
}

async function postStudentFeeReceivable(client:any,studentFeeId:string,actorOsUserId?:string|null){
  const sf=await one<any>(client,`SELECT sf.*,s.first_name,s.last_name,s.admission_no,f.name fee_name,f.income_account_id
    FROM student_fees sf JOIN students s ON s.id=sf.student_id JOIN fee_items f ON f.id=sf.fee_item_id
    WHERE sf.id=$1`,[studentFeeId]);
  const amount=Number(sf.amount_due)-Number(sf.discount||0);
  if(amount<=0)return null;
  const ar=await financeAccountByCode(client,sf.organisation_id,'1100');
  const income=sf.income_account_id
    ?await one<any>(client,"SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='income' AND is_active=true",[sf.income_account_id,sf.organisation_id])
    :await financeAccountByCode(client,sf.organisation_id,'4000');
  const journal=await postFinanceJournal(client,{
    organisationId:sf.organisation_id,entryDate:String(sf.created_at||new Date().toISOString()).slice(0,10),
    description:`School fee receivable - ${sf.first_name} ${sf.last_name} (${sf.admission_no}) - ${sf.fee_name}`,
    sourceType:'student_fee',sourceId:sf.id,actorOsUserId:actorOsUserId??null,
    lines:[
      {accountId:ar.id,debit:amount,description:sf.fee_name+' receivable'},
      {accountId:income.id,credit:amount,description:sf.fee_name+' income'}
    ]
  });
  await applyStudentCreditsToFee(client,studentFeeId,actorOsUserId??null);
  return journal;
}

async function postStudentPaymentLedger(client:any,paymentId:string,actorOsUserId?:string|null){
  const p=await one<any>(client,`SELECT p.*,s.first_name,s.last_name,s.admission_no,f.name fee_name,f.income_account_id fee_income_account_id
    FROM payments p JOIN students s ON s.id=p.student_id
    LEFT JOIN student_fees sf ON sf.id=p.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id
    WHERE p.id=$1`,[paymentId]);
  if(p.voided_at)return null;
  const debitCode=p.payment_method==='mobile_money'?'1020':p.payment_method==='card'?'1030':p.payment_method==='bank'?'1010':'1000';
  const debitAccount=await financeAccountByCode(client,p.organisation_id,debitCode);
  const creditAccount=p.student_fee_id
    ?await financeAccountByCode(client,p.organisation_id,'1100')
    :(p.income_account_id
      ?await one<any>(client,"SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='income' AND is_active=true",[p.income_account_id,p.organisation_id])
      :await financeAccountByCode(client,p.organisation_id,'4000'));
  return postFinanceJournal(client,{
    organisationId:p.organisation_id,entryDate:String(p.paid_at||new Date().toISOString()).slice(0,10),
    description:`School fee payment - ${p.first_name} ${p.last_name} (${p.admission_no})`,
    sourceType:'student_payment',sourceId:p.id,reference:p.reference??null,actorOsUserId:actorOsUserId??p.received_by_os_user_id??null,
    lines:[
      {accountId:debitAccount.id,debit:Number(p.amount),description:p.payment_method+' receipt'},
      {accountId:creditAccount.id,credit:Number(p.amount),description:p.student_fee_id?'Accounts receivable settlement':(p.fee_name||'School fees income')}
    ]
  });
}

async function assignMandatoryFees(client:any,organisationId:string,studentId:string,academicYearId:string,classroomId:string){
  const classroom=await one<any>(client,'SELECT id,grade_level_id FROM classrooms WHERE id=$1 AND organisation_id=$2',[classroomId,organisationId]);
  const rows=(await client.query(`SELECT id,amount FROM fee_items
    WHERE organisation_id=$1 AND academic_year_id=$2 AND mandatory=true
      AND (grade_level_id IS NULL OR grade_level_id=$3)`,
    [organisationId,academicYearId,classroom.grade_level_id])).rows;
  let assigned=0;
  for(const fee of rows){
    const inserted=(await client.query(`INSERT INTO student_fees(organisation_id,student_id,fee_item_id,amount_due)
      VALUES($1,$2,$3,$4) ON CONFLICT(student_id,fee_item_id) DO NOTHING RETURNING id`,
      [organisationId,studentId,fee.id,fee.amount])).rows[0];
    if(inserted){await postStudentFeeReceivable(client,inserted.id,null);assigned++}
  }
  return assigned;
}

async function nextSystemPaymentReference(client:any,organisationId:string,method:string,admissionNo:string){
  const label=method==='mobile_money'?'Mobile Money':method==='card'?'Card':method.replace(/_/g,' ');
  const prefix=label.replace(/[^A-Za-z]/g,'').slice(0,2).toUpperCase().padEnd(2,'X');
  const key='student_receipt:'+method;
  const counter=await one<any>(client,`
    INSERT INTO finance_reference_counters(organisation_id,reference_key,next_number)
    VALUES($1,$2,1)
    ON CONFLICT(organisation_id,reference_key)
    DO UPDATE SET next_number=finance_reference_counters.next_number+1,updated_at=now()
    RETURNING next_number
  `,[organisationId,key]);
  const studentCode=String(admissionNo||'STUDENT').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  return prefix+'-'+studentCode+'-'+String(counter.next_number).padStart(4,'0');
}

async function settleOnlinePayment(reference:string){
  const intent=await maybeOne<any>(db,'SELECT * FROM payment_intents WHERE reference=$1',[reference]);
  if(!intent)throw fail(404,'Payment reference not found');
  if(intent.status==='success')return intent;
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
    if(locked.status==='success')return locked;
    const student=await one<any>(client,'SELECT id,admission_no,first_name,last_name FROM students WHERE id=$1 AND organisation_id=$2',
      [locked.student_id,locked.organisation_id]);
    let remaining=Number(locked.amount),firstPayment:any=null;
    const source=locked.initiated_by_type==='guardian'?'parent_online':'school_online';

    // Allocate verified online money to the selected fee first, then other outstanding fees.
    const openFees=(await client.query(`
      SELECT sf.id,f.name fee_name,sf.created_at,
        (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p
          WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
      FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id
      WHERE sf.organisation_id=$1 AND sf.student_id=$2
        AND (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p
          WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0)>0.004
      ORDER BY CASE WHEN sf.id=$3::uuid THEN 0 ELSE 1 END,sf.created_at,sf.id
      FOR UPDATE OF sf
    `,[locked.organisation_id,locked.student_id,locked.student_fee_id??null])).rows;

    for(const fee of openFees){
      if(remaining<=0.004)break;
      const amount=Math.min(remaining,Number(fee.balance));
      if(amount<=0)continue;
      const payment=await one<any>(client,`INSERT INTO payments(
        organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id,note,source,payment_intent_id
      ) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9) RETURNING *`,[
        locked.organisation_id,locked.student_id,fee.id,amount,locked.method,verified.reference,
        'Online payment verified by Paystack',source,firstPayment?null:locked.id
      ]);
      if(!firstPayment)firstPayment=payment;
      await updateStudentFeeStatus(client,fee.id);
      await postStudentPaymentLedger(client,payment.id,null);
      remaining-=amount;
    }

    // If the student paid more than current outstanding fees, carry it forward as a real liability credit.
    if(remaining>0.004){
      const deposit=await financeAccountByCode(client,locked.organisation_id,'2200');
      const debitCode=locked.method==='mobile_money'?'1020':locked.method==='card'?'1030':'1010';
      const settlement=await financeAccountByCode(client,locked.organisation_id,debitCode);
      const credit=await one<any>(client,`INSERT INTO student_account_credits(
        organisation_id,student_id,source_receipt_id,original_amount,balance,created_by_os_user_id
      ) VALUES($1,$2,NULL,$3,$3,NULL) RETURNING *`,[locked.organisation_id,locked.student_id,remaining]);
      await postFinanceJournal(client,{
        organisationId:locked.organisation_id,entryDate:new Date().toISOString().slice(0,10),
        description:'Online student advance - '+student.first_name+' '+student.last_name+' ('+student.admission_no+')',
        sourceType:'online_student_credit',sourceId:credit.id,reference:verified.reference,actorOsUserId:null,
        lines:[
          {accountId:settlement.id,debit:remaining,description:locked.method+' online receipt'},
          {accountId:deposit.id,credit:remaining,description:'Student advance / overpayment credit'}
        ]
      });
    }

    if(locked.payment_request_id)await client.query("UPDATE fee_payment_requests SET status='paid',paid_at=now(),updated_at=now() WHERE id=$1",[locked.payment_request_id]);
    const updated=await one<any>(client,`UPDATE payment_intents SET status='success',settled_payment_id=$1,paid_at=now(),
      provider_payload=$2,failure_reason=NULL,updated_at=now() WHERE id=$3 RETURNING *`,
      [firstPayment?.id??null,JSON.stringify(verified.raw),locked.id]);
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
async function effectiveClassTeacher(organisationId:string,classroomId:string,termId?:string|null){
  const row=await maybeOne<any>(db,`SELECT COALESCE(
      (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
       WHERE ta.organisation_id=$1 AND ta.classroom_id=$2 AND ta.subject_id IS NULL AND ta.is_active=true
         AND ta.term_id IS NOT DISTINCT FROM $3::uuid
       ORDER BY ta.created_at DESC LIMIT 1),
      (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
       WHERE ta.organisation_id=$1 AND ta.classroom_id=$2 AND ta.subject_id IS NULL AND ta.is_active=true AND ta.term_id IS NULL
       ORDER BY ta.created_at DESC LIMIT 1),
      c.class_teacher_os_user_id
    ) teacher_os_user_id
    FROM classrooms c WHERE c.id=$2 AND c.organisation_id=$1`,[organisationId,classroomId,termId??null]);
  return row?.teacher_os_user_id??null;
}

async function ensureTeacherScope(a:any,classroomId:string,subjectId?:string|null,coverageDate?:string|null){
  if(a.role==='school_admin'||a.role==='headteacher')return;
  const roleProfile=await schoolRoleProfile(db,a.core.organisation_id,a.role);
  if(!roleProfile?.can_teach)throw fail(403,'This role does not have teaching scope');
  const term=await activeTerm(a.core.organisation_id);
  const row=subjectId
    ?await maybeOne<any>(db,`SELECT 1 FROM teacher_assignments ta
      WHERE ta.classroom_id=$1 AND ta.organisation_id=$2 AND ta.teacher_os_user_id=$3
        AND ta.subject_id=$4 AND ta.is_active=true
        AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $5::uuid)
      LIMIT 1`,[classroomId,a.core.organisation_id,a.core.id,subjectId,term?.id??null])
    :await maybeOne<any>(db,`SELECT 1 FROM classrooms c
      WHERE c.id=$1 AND c.organisation_id=$2 AND (
        c.class_teacher_os_user_id=$3 OR EXISTS(
          SELECT 1 FROM teacher_assignments ta
          WHERE ta.classroom_id=c.id AND ta.organisation_id=$2 AND ta.teacher_os_user_id=$3
            AND ta.is_active=true AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $4::uuid)
        )
      ) LIMIT 1`,[classroomId,a.core.organisation_id,a.core.id,term?.id??null]);
  if(row)return;
  const date=coverageDate??new Date().toISOString().slice(0,10);
  const relief=await maybeOne<any>(db,`SELECT 1 FROM staff_leave_relief_schedule rs
    JOIN staff_leave_requests lr ON lr.id=rs.leave_request_id
    WHERE lr.organisation_id=$1 AND lr.status='approved' AND rs.status='planned'
      AND rs.reliever_os_user_id=$2 AND rs.classroom_id=$3 AND rs.coverage_date=$4::date
      AND ($5::uuid IS NULL OR rs.subject_id=$5) LIMIT 1`,
    [a.core.organisation_id,a.core.id,classroomId,date,subjectId??null]);
  if(relief)return;
  throw fail(403,subjectId?'You are not assigned to teach or relieve this subject in this class':'You are not assigned to this class on this date');
}


async function calculateStudentTermResults(orgId:string,studentId:string,termId:string){
  const rows=(await db.query(`
    WITH current_class AS (
      SELECT e.classroom_id
      FROM enrolments e
      JOIN terms t ON t.academic_year_id=e.academic_year_id
      WHERE e.organisation_id=$1 AND e.student_id=$2 AND t.id=$3
      ORDER BY e.enrolled_at DESC LIMIT 1
    ),
    subject_list AS (
      SELECT cs.subject_id,sub.name subject_name
      FROM class_subjects cs
      JOIN subjects sub ON sub.id=cs.subject_id
      JOIN current_class cc ON cc.classroom_id=cs.classroom_id
      JOIN terms t ON t.id=$3 AND t.academic_year_id=cs.academic_year_id
      WHERE cs.organisation_id=$1 AND cs.is_active=true
    ),
    category_scores AS (
      SELECT
        sl.subject_id,sl.subject_name,
        COALESCE(ac.id,a.id) category_id,
        COALESCE(ac.code,upper(a.assessment_type)) category_code,
        COALESCE(ac.name,initcap(a.assessment_type)) category_name,
        COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,
        ROUND(AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END)::numeric,2) category_average,
        COUNT(a.id)::int assessment_count,
        COUNT(sc.score)::int scored_count
      FROM subject_list sl
      LEFT JOIN current_class cc ON true
      LEFT JOIN assessments a ON a.subject_id=sl.subject_id AND a.term_id=$3 AND a.classroom_id=cc.classroom_id
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$2
      GROUP BY sl.subject_id,sl.subject_name,COALESCE(ac.id,a.id),COALESCE(ac.code,upper(a.assessment_type)),
               COALESCE(ac.name,initcap(a.assessment_type)),COALESCE(ac.weight_percent,a.weight,0)
    ),
    subject_scores AS (
      SELECT subject_id,subject_name,
        COALESCE(SUM(assessment_count),0)::int assessment_count,
        COALESCE(SUM(scored_count),0)::int scored_assessment_count,
        COALESCE(SUM(assessment_count) FILTER(WHERE category_code<>'EXAM'),0)::int class_assessment_count,
        COALESCE(SUM(scored_count) FILTER(WHERE category_code<>'EXAM'),0)::int class_scored_count,
        COALESCE(SUM(assessment_count) FILTER(WHERE category_code='EXAM'),0)::int exam_count,
        COALESCE(SUM(scored_count) FILTER(WHERE category_code='EXAM'),0)::int exam_scored_count,
        CASE WHEN SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)>0
          THEN SUM(category_average*weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)
               / SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)
          ELSE NULL END class_assessment_raw,
        CASE WHEN SUM(weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)>0
          THEN SUM(category_average*weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)
               / SUM(weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)
          ELSE NULL END exam_raw,
        COALESCE(jsonb_agg(jsonb_build_object(
          'categoryId',category_id,'code',category_code,'name',category_name,
          'weightPercent',weight_percent,'average',category_average,'exerciseCount',assessment_count,
          'scoredCount',scored_count
        ) ORDER BY category_name) FILTER(WHERE category_id IS NOT NULL),'[]'::jsonb) components
      FROM category_scores
      GROUP BY subject_id,subject_name
    )
    SELECT *,
      ROUND(class_assessment_raw::numeric,2) class_assessment_raw,
      ROUND(exam_raw::numeric,2) exam_raw,
      ROUND((class_assessment_raw*0.30)::numeric,2) class_assessment_score,
      ROUND((exam_raw*0.70)::numeric,2) exam_score,
      ROUND(CASE WHEN class_assessment_raw IS NOT NULL AND exam_raw IS NOT NULL
        THEN class_assessment_raw*0.30+exam_raw*0.70 ELSE NULL END::numeric,2) total
    FROM subject_scores
    ORDER BY subject_name
  `,[orgId,studentId,termId])).rows;

  const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[orgId])).rows;
  return rows.map((row:any)=>{
    const total=row.total==null?null:Number(row.total);
    const band=total==null?null:bands.find((b:any)=>total>=Number(b.min_percentage)&&total<=Number(b.max_percentage));
    return{
      ...row,
      class_assessment_raw:row.class_assessment_raw==null?null:Number(row.class_assessment_raw),
      class_assessment_score:row.class_assessment_score==null?null:Number(row.class_assessment_score),
      exam_raw:row.exam_raw==null?null:Number(row.exam_raw),
      exam_score:row.exam_score==null?null:Number(row.exam_score),
      total,
      percentage:total,
      weighted_points:total,
      grade:band?.name??'',
      remark:band?.remark??''
    };
  });
}

async function reportAssessmentReadiness(orgId:string,studentId:string,termId:string,classroomId?:string|null){
  let classId=classroomId??null;
  if(!classId){
    const current=await maybeOne<any>(db,`
      SELECT e.classroom_id FROM enrolments e JOIN terms t ON t.academic_year_id=e.academic_year_id
      WHERE e.organisation_id=$1 AND e.student_id=$2 AND t.id=$3
      ORDER BY e.enrolled_at DESC LIMIT 1
    `,[orgId,studentId,termId]);
    classId=current?.classroom_id??null;
  }
  if(!classId)return{complete:false,classroomId:null,totalSubjects:0,completeSubjects:0,missing:[{subjectName:'Student enrolment',missing:['No class enrolment found for this term']}]};

  const rows=(await db.query(`
    SELECT cs.subject_id,s.name subject_name,
      COUNT(a.id)::int assessment_count,
      COUNT(a.id) FILTER(WHERE COALESCE(ac.code,upper(a.assessment_type))<>'EXAM')::int class_assessment_count,
      COUNT(a.id) FILTER(WHERE COALESCE(ac.code,upper(a.assessment_type))='EXAM')::int exam_count,
      COUNT(a.id) FILTER(WHERE sc.score IS NULL)::int missing_score_count,
      COALESCE(jsonb_agg(jsonb_build_object(
        'assessmentId',a.id,'name',a.name,'component',CASE WHEN COALESCE(ac.code,upper(a.assessment_type))='EXAM' THEN 'Exam' ELSE 'Class Assessment' END
      ) ORDER BY a.name) FILTER(WHERE a.id IS NOT NULL AND sc.score IS NULL),'[]'::jsonb) missing_scores
    FROM class_subjects cs
    JOIN subjects s ON s.id=cs.subject_id
    JOIN terms t ON t.id=$3 AND t.academic_year_id=cs.academic_year_id
    LEFT JOIN assessments a ON a.organisation_id=cs.organisation_id AND a.classroom_id=cs.classroom_id
      AND a.subject_id=cs.subject_id AND a.term_id=$3
    LEFT JOIN assessment_categories ac ON ac.id=a.category_id
    LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$2
    WHERE cs.organisation_id=$1 AND cs.classroom_id=$4 AND cs.is_active=true
    GROUP BY cs.subject_id,s.name
    ORDER BY s.name
  `,[orgId,studentId,termId,classId])).rows;

  const missing:any[]=[];
  for(const row of rows){
    const reasons:string[]=[];
    if(Number(row.class_assessment_count||0)===0)reasons.push('Class Assessment (30%) is not configured');
    if(Number(row.exam_count||0)===0)reasons.push('Exam (70%) is not configured');
    if(Number(row.missing_score_count||0)>0){
      const names=(Array.isArray(row.missing_scores)?row.missing_scores:[]).map((x:any)=>x.name).filter(Boolean);
      reasons.push('Missing score'+(names.length?': '+names.join(', '):''));
    }
    if(reasons.length)missing.push({subjectId:row.subject_id,subjectName:row.subject_name,missing:reasons,missingScores:row.missing_scores||[]});
  }
  return{complete:rows.length>0&&missing.length===0,classroomId:classId,totalSubjects:rows.length,completeSubjects:rows.length-missing.length,missing};
}

async function reportPromotionInfo(orgId:string,studentId:string,termId:string,classroomId?:string|null,results?:any[]){
  let current:any=null;
  if(classroomId){
    current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.grade_level_id,g.level_order,g.code grade_code,g.name grade_name
      FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
      WHERE c.id=$1 AND c.organisation_id=$2`,[classroomId,orgId]);
  }else{
    current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.grade_level_id,g.level_order,g.code grade_code,g.name grade_name
      FROM enrolments e JOIN terms t ON t.academic_year_id=e.academic_year_id
      JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id
      WHERE e.organisation_id=$1 AND e.student_id=$2 AND t.id=$3
      ORDER BY e.enrolled_at DESC LIMIT 1`,[orgId,studentId,termId]);
  }
  const school=await one<any>(db,'SELECT promotion_threshold_percent FROM school_profiles WHERE organisation_id=$1',[orgId]);
  const threshold=Number(school.promotion_threshold_percent??50);
  const nextGrade=current?await maybeOne<any>(db,`SELECT id,code,name,level_order FROM grade_levels
    WHERE organisation_id=$1 AND is_active=true AND level_order>$2 ORDER BY level_order LIMIT 1`,[orgId,current.level_order]):null;
  const subjectResults=results??await calculateStudentTermResults(orgId,studentId,termId);
  const complete=subjectResults.filter((x:any)=>x.total!=null);
  const overallAverage=subjectResults.length&&complete.length===subjectResults.length
    ?Math.round((complete.reduce((sum:number,x:any)=>sum+Number(x.total),0)/complete.length)*100)/100
    :null;
  const suggestedDecision=overallAverage==null?null:(!nextGrade?'completed':overallAverage>=threshold?'promoted':'repeated');
  return{threshold,overallAverage,suggestedDecision,hasNextGrade:Boolean(nextGrade),nextGrade:nextGrade??null,currentGrade:current};
}

async function calculateClassRank(orgId:string,classroomId:string,termId:string,studentId:string){
  return maybeOne<any>(db,`
    WITH enrolled AS (
      SELECT e.student_id FROM enrolments e
      WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.status IN('active','promoted','repeated','completed')
    ),
    class_subjects_active AS (
      SELECT cs.subject_id FROM class_subjects cs
      JOIN terms t ON t.id=$3 AND t.academic_year_id=cs.academic_year_id
      WHERE cs.organisation_id=$1 AND cs.classroom_id=$2 AND cs.is_active=true
    ),
    category_scores AS (
      SELECT en.student_id,cs.subject_id,COALESCE(ac.id,a.id) category_id,
        COALESCE(ac.code,upper(a.assessment_type)) category_code,
        COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,
        AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END) category_average
      FROM enrolled en
      CROSS JOIN class_subjects_active cs
      LEFT JOIN assessments a ON a.classroom_id=$2 AND a.term_id=$3 AND a.subject_id=cs.subject_id
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=en.student_id
      GROUP BY en.student_id,cs.subject_id,COALESCE(ac.id,a.id),COALESCE(ac.code,upper(a.assessment_type)),
        COALESCE(ac.weight_percent,a.weight,0)
    ),
    subject_scores AS (
      SELECT student_id,subject_id,
        CASE WHEN SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)>0
          THEN SUM(category_average*weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)
               /SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL) ELSE NULL END ca_raw,
        CASE WHEN SUM(weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)>0
          THEN SUM(category_average*weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)
               /SUM(weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL) ELSE NULL END exam_raw
      FROM category_scores GROUP BY student_id,subject_id
    ),
    subject_totals AS (
      SELECT student_id,subject_id,
        CASE WHEN ca_raw IS NOT NULL AND exam_raw IS NOT NULL THEN ca_raw*0.30+exam_raw*0.70 ELSE NULL END subject_total
      FROM subject_scores
    ),
    student_scores AS (
      SELECT student_id,AVG(subject_total) overall_average
      FROM subject_totals
      GROUP BY student_id
      HAVING COUNT(*) FILTER(WHERE subject_total IS NOT NULL)=(SELECT COUNT(*) FROM class_subjects_active)
        AND (SELECT COUNT(*) FROM class_subjects_active)>0
    ),
    ranked AS (
      SELECT student_id,ROUND(overall_average::numeric,2) average,
        RANK() OVER(ORDER BY overall_average DESC)::int position,
        COUNT(*) OVER()::int class_size
      FROM student_scores
    )
    SELECT * FROM ranked WHERE student_id=$4
  `,[orgId,classroomId,termId,studentId]);
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

app.get('/',async(request,p)=>{
  // Do not depend on browser JavaScript to discover that a School session is missing
  // or expired. Route unauthenticated users straight to sign-in on the server.
  const token=requestSessionToken(request);
  let active=false;
  if(token&&token.startsWith('rxs_')){
    const hash=createHash('sha256').update(token).digest('hex');
    const session=await maybeOne<any>(db,
      'SELECT 1 FROM school_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
      [hash]
    );
    active=Boolean(session);
  }
  if(!active){
    const secure=config.NODE_ENV==='production'?'; Secure':'';
    p.header('set-cookie','rx_school_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+secure);
    return p.redirect('/login?next=%2F');
  }
  return p.header('cache-control','no-store, max-age=0').type('text/html; charset=utf-8').send(schoolFrontend);
});
app.get('/students/:id',async(request,p)=>{
  const token=requestSessionToken(request);
  let active=false;
  if(token&&token.startsWith('rxs_')){
    const hash=createHash('sha256').update(token).digest('hex');
    const session=await maybeOne<any>(db,
      'SELECT 1 FROM school_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
      [hash]
    );
    active=Boolean(session);
  }
  if(!active){
    const secure=config.NODE_ENV==='production'?'; Secure':'';
    p.header('set-cookie','rx_school_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+secure);
    return p.redirect('/login?next='+encodeURIComponent(request.url));
  }
  return p.header('cache-control','no-store, max-age=0').type('text/html; charset=utf-8').send(schoolFrontend);
});
app.get('/school-app.js',async(_r,p)=>p.header('cache-control','no-store, max-age=0').type('application/javascript; charset=utf-8').send(schoolAppScript));
// Versioned presentation assets are shared by every School portal.
app.get('/school-design.css',async(_r,p)=>p.header('cache-control','public, max-age=3600').type('text/css; charset=utf-8').send(schoolDesignCss));
app.get('/school-design.js',async(_r,p)=>p.header('cache-control','public, max-age=3600').type('application/javascript; charset=utf-8').send(schoolDesignScript));
app.get('/login',async(_r,p)=>p.type('text/html; charset=utf-8').send(loginFrontend));
app.get('/parent',async(_r,p)=>p.type('text/html; charset=utf-8').send(parentFrontend));
app.get('/teacher',async(_r,p)=>p.type('text/html; charset=utf-8').send(teacherFrontend));
app.get('/headteacher',async(_r,p)=>p.type('text/html; charset=utf-8').send(teacherFrontend));
app.get('/bursar',async(_r,p)=>p.type('text/html; charset=utf-8').send(schoolFrontend));
app.get('/registrar',async(_r,p)=>p.type('text/html; charset=utf-8').send(schoolFrontend));
app.get('/student',async(_r,p)=>p.type('text/html; charset=utf-8').send(studentFrontend));
app.get('/admissions',async(_r,p)=>p.type('text/html; charset=utf-8').send(admissionsFrontend));
app.get('/health/live',async()=>({status:'ok',service:'revolt-x-school'}));
app.get('/health/ready',async(_r,p)=>{try{await db.query('SELECT 1');return{status:'ready'}}catch{return p.code(503).send({status:'unavailable'})}});

let coreWakeInFlight:Promise<any>|null=null;
async function probeCoreOS(){
  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const started=Date.now();
  try{
    const res=await fetch(base+'/',{method:'GET',signal:AbortSignal.timeout(15000)});
    return{reachable:res.ok,status:res.status,responseMs:Date.now()-started,url:base};
  }catch(error:any){
    return{reachable:false,status:0,responseMs:Date.now()-started,url:base,error:String(error?.message||error)};
  }
}
async function wakeCoreOS(){
  if(coreWakeInFlight)return coreWakeInFlight;
  coreWakeInFlight=(async()=>{
    let last:any=null;
    for(let attempt=0;attempt<8;attempt++){
      last=await probeCoreOS();
      if(last.reachable)return{...last,attempts:attempt+1};
      if(attempt<7)await new Promise(resolve=>setTimeout(resolve,[1000,1500,2200,3200,4500,6000,8000][attempt]||8000));
    }
    return{...(last||{}),attempts:8};
  })();
  try{return await coreWakeInFlight}finally{coreWakeInFlight=null}
}

app.get('/api/system/core-status',async()=>{
  const core=await probeCoreOS();
  let database='ready';
  try{await db.query('SELECT 1')}catch{database='unavailable'}
  return{school:'ready',database,core,checkedAt:new Date().toISOString()};
});
app.post('/api/system/core-wake',async(_request,reply)=>{
  const core=await wakeCoreOS();
  return reply.code(core.reachable?200:503).send({
    core,
    message:core.reachable?'Core Revolt-X OS is awake and responding.':'Core Revolt-X OS is still unavailable. Retry in a few seconds.'
  });
});


// Safe service recovery endpoint. This deliberately reconnects dependencies instead of
// killing the Node process; the hosting platform remains responsible for process restarts.
app.post('/api/system/recover-services',async request=>{
  const a=await authorize(request,db,config,'system.errors.manage');
  const started=Date.now();
  coreUsersCache.clear();

  let database:any={ok:false};
  try{
    const t=Date.now();
    await db.query('SELECT 1');
    database={ok:true,responseMs:Date.now()-t};
  }catch(error:any){database={ok:false,error:String(error?.message||error)}}

  const core=await wakeCoreOS();
  let serviceBridge:any={ok:false,status:0};
  if(core.reachable&&config.CORE_SERVICE_KEY){
    try{
      const t=Date.now();
      const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/internal/school/users?organisationId='+encodeURIComponent(a.core.organisation_id),{
        headers:coreServiceHeaders(),signal:AbortSignal.timeout(15000)
      });
      serviceBridge={ok:res.ok,status:res.status,responseMs:Date.now()-t};
    }catch(error:any){serviceBridge={ok:false,status:0,error:String(error?.message||error)}}
  }else if(!config.CORE_SERVICE_KEY){
    serviceBridge={ok:false,status:0,error:'Core service authentication is not configured'};
  }

  const recovered=Boolean(database.ok&&core.reachable&&serviceBridge.ok);
  await audit(a.core.organisation_id,a.core.id,'system.services.recovery','system',null,{database,core,serviceBridge,recovered});
  return {
    recovered,database,core,serviceBridge,durationMs:Date.now()-started,checkedAt:new Date().toISOString(),
    message:recovered
      ?'School database, Core OS and the secure service bridge are responding.'
      :'Recovery completed, but one or more dependencies still need attention.'
  };
});

async function handleSchoolStaffLogin(request:any,reply:any){
  const b=z.object({
    email:z.string().trim().toLowerCase().email(),
    password:z.string().min(1).max(200)
  }).parse(request.body);

  const school=await one<any>(db,'SELECT organisation_id FROM school_profiles ORDER BY created_at LIMIT 1');
  const wake=await wakeCoreOS();
  if(!wake.reachable)throw fail(503,'Core Revolt-X OS is still starting. Please retry in a moment.');

  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const loginRes=await fetch(base+'/v1/auth/login',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({email:b.email,password:b.password,organisationId:school.organisation_id}),
    signal:AbortSignal.timeout(20000)
  }).catch(()=>null);

  if(!loginRes)throw fail(503,'Core Revolt-X OS could not be reached');
  const loginPayload=await loginRes.json().catch(()=>null) as any;
  if(!loginRes.ok)throw fail(loginRes.status,loginPayload?.error?.message||'Invalid email or password');

  const ctxRes=await fetch(base+'/v1/auth/context',{
    headers:{authorization:'Bearer '+loginPayload.accessToken},
    signal:AbortSignal.timeout(20000)
  }).catch(()=>null);

  if(!ctxRes)throw fail(503,'Core OS user context could not be reached');
  const coreContext=await ctxRes.json().catch(()=>null) as any;
  if(!ctxRes.ok||!coreContext)throw fail(ctxRes.status||503,coreContext?.error?.message||'Core OS authentication failed');

  let membership=await maybeOne<any>(db,`SELECT * FROM school_memberships
    WHERE organisation_id=$1 AND os_user_id=$2 AND status='active'`,
    [coreContext.organisation_id,coreContext.id]);

  if(!membership&&Array.isArray(coreContext.permissions)&&coreContext.permissions.includes('organisation.manage')){
    membership=await one<any>(db,`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
      VALUES($1,$2,'school_admin','active')
      ON CONFLICT(organisation_id,os_user_id)
      DO UPDATE SET role='school_admin',status='active',updated_at=now()
      RETURNING *`,[coreContext.organisation_id,coreContext.id]);
  }

  if(!membership)throw fail(403,'This account does not have active Revolt-X School access');

  const session=await createSchoolStaffSession(coreContext,'core_exchange');
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  reply.header('set-cookie','rx_school_session='+encodeURIComponent(session.localToken)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(8*60*60)+secure);

  const roleProfile=await schoolRoleProfile(db,coreContext.organisation_id,membership.role);
  if(!roleProfile||roleProfile.is_active===false)throw fail(403,'This School role is inactive');
  const redirectTo=roleProfile.portal_mode==='teacher'?'/teacher':'/';
  await audit(coreContext.organisation_id,coreContext.id,'school.authenticated','school_session',null,{role:membership.role,portalMode:roleProfile.portal_mode});

  return reply.send({
    accessToken:session.localToken,
    expiresIn:8*60*60,
    schoolRole:membership.role,
    roleProfile,
    user:{
      id:coreContext.id,
      email:coreContext.email,
      firstName:coreContext.first_name,
      lastName:coreContext.last_name
    },
    redirectTo
  });
}

app.post('/api/auth/login',handleSchoolStaffLogin);
app.post('/api/auth/teacher-login',handleSchoolStaffLogin);

async function handleSchoolPasswordSetup(request:any,reply:any){
  const b=z.object({
    token:z.string().min(32).max(300),
    password:z.string().min(12).max(200)
      .regex(/[A-Z]/,'Password must contain an uppercase letter')
      .regex(/[a-z]/,'Password must contain a lowercase letter')
      .regex(/[0-9]/,'Password must contain a number')
  }).parse(request.body);
  await wakeCoreOS();
  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const res=await fetch(base+'/v1/auth/password-reset/confirm',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({token:b.token,password:b.password}),
    signal:AbortSignal.timeout(20000)
  }).catch(()=>null);
  if(!res)throw fail(503,'Core OS could not be reached');
  const payload=await res.json().catch(()=>null) as any;
  if(!res.ok)throw fail(res.status,payload?.error?.message||'Password setup failed');
  return reply.send({reset:true});
}
app.post('/api/auth/set-password',handleSchoolPasswordSetup);
app.post('/api/auth/teacher-set-password',handleSchoolPasswordSetup);

app.post('/api/auth/logout',async(request,reply)=>{
  const token=requestSessionToken(request);
  if(token&&token.startsWith('rxs_')){
    const hash=createHash('sha256').update(token).digest('hex');
    await db.query('UPDATE school_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',[hash]);
  }
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  reply.header('set-cookie','rx_school_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+secure);
  return reply.send({signedOut:true});
});

app.post('/api/auth/preview',async(_r,p)=>{
  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const transient=new Set([429,502,503,504]);

  const wake=await wakeCoreOS();
  if(!wake.reachable){
    return p.code(503).send({error:{message:'Core Revolt-X OS could not be started. Use Reconnect & Repair and retry.'}});
  }

  let coreContext:any=null;
  let lastStatus=503;
  let lastMessage='Core Revolt-X OS is starting. Please retry in a moment.';

  // Preferred path: trusted service-to-service bootstrap. This avoids browser auth
  // fan-out and remains independent of the public Core rate-limit bucket.
  if(config.CORE_SERVICE_KEY){
    try{
      const serviceRes=await fetch(base+'/v1/internal/school/preview-context',{
        headers:coreServiceHeaders(),
        signal:AbortSignal.timeout(15000)
      });
      if(serviceRes.ok){
        coreContext=await serviceRes.json().catch(()=>null);
      }else{
        lastStatus=serviceRes.status;
        const body=await serviceRes.json().catch(()=>null) as any;
        lastMessage=body?.error?.message||lastMessage;
      }
    }catch(error:any){
      lastMessage=String(error?.message||lastMessage);
    }
  }

  // Fallback path: normal Core preview JWT exchange.
  if(!coreContext){
    const previewUrl=base+'/v1/auth/preview-session';
    let coreToken:string|null=null;

    for(let attempt=0;attempt<6;attempt++){
      const res=await fetch(previewUrl,{method:'POST',signal:AbortSignal.timeout(15000)}).catch(()=>null);
      if(res?.ok){
        const body=await res.json().catch(()=>({})) as any;
        coreToken=body?.accessToken??null;
        if(coreToken)break;
        lastMessage='Core OS preview session did not return an access token';
      }else if(res){
        lastStatus=res.status;
        const body=await res.json().catch(()=>null) as any;
        lastMessage=body?.error?.message||(transient.has(res.status)?'Core Revolt-X OS is starting. Please retry in a moment.':'Core OS preview request failed');
        if(!transient.has(res.status)&&res.status!==401)break;
      }
      if(attempt<5)await new Promise(resolve=>setTimeout(resolve,[1200,2000,3200,4800,6500][attempt]||6500));
    }

    if(coreToken){
      for(let attempt=0;attempt<6;attempt++){
        const res=await fetch(base+'/v1/auth/context',{
          headers:{authorization:'Bearer '+coreToken},
          signal:AbortSignal.timeout(15000)
        }).catch(()=>null);

        if(res?.ok){
          coreContext=await res.json().catch(()=>null);
          if(coreContext)break;
        }else if(res){
          lastStatus=res.status;
          const body=await res.json().catch(()=>null) as any;
          lastMessage=body?.error?.message||(transient.has(res.status)?'Core Revolt-X OS is still starting. Please retry in a moment.':'Core OS authentication failed');
          if(!transient.has(res.status))break;
        }
        if(attempt<5)await new Promise(resolve=>setTimeout(resolve,[800,1500,2500,4000,6000][attempt]||6000));
      }
    }
  }

  if(!coreContext)return p.code(lastStatus).send({error:{message:lastMessage}});

  const localSession=await createSchoolStaffSession(coreContext,'preview');
  const localToken=localSession.localToken;

  await db.query(`DELETE FROM school_sessions
    WHERE expires_at<now()-interval '1 day' OR revoked_at IS NOT NULL`).catch(()=>null);

  const secure=config.NODE_ENV==='production'?'; Secure':'';
  p.header('set-cookie','rx_school_session='+encodeURIComponent(localToken)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(8*60*60)+secure);

  return p.send({
    accessToken:localToken,
    expiresIn:8*60*60,
    tokenType:'Bearer',
    localSession:true,
    coreWake:wake,
    bootstrap:config.CORE_SERVICE_KEY?'service_bridge':'jwt_exchange'
  });
});

app.get('/api/context',async request=>{
  const a=await authorize(request,db,config);
  const profile=await maybeOne<any>(db,'SELECT * FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  const capabilities=await effectiveCapabilities(db,a.core.organisation_id,a.role);
  const roleProfile=await schoolRoleProfile(db,a.core.organisation_id,a.role);
  return {core:a.core,schoolRole:a.role,roleProfile,profile,capabilities};
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
  const b=z.object({schoolName:z.string().min(2).max(240).optional(),shortName:z.string().max(80).nullable().optional(),motto:z.string().max(240).nullable().optional(),phone:z.string().max(60).nullable().optional(),email:z.string().email().nullable().optional(),address:z.string().max(2000).nullable().optional(),logoImageData:z.string().max(1500000).nullable().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  if(b.logoImageData&& !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(b.logoImageData))throw fail(400,'School logo must be a PNG, JPG or WebP image');
  const row=await one<any>(db,`UPDATE school_profiles SET school_name=COALESCE($1,school_name),short_name=CASE WHEN $2 THEN $3 ELSE short_name END,motto=CASE WHEN $4 THEN $5 ELSE motto END,phone=CASE WHEN $6 THEN $7 ELSE phone END,email=CASE WHEN $8 THEN $9 ELSE email END,address=CASE WHEN $10 THEN $11 ELSE address END,logo_image_data=CASE WHEN $12 THEN $13 ELSE logo_image_data END,updated_at=now() WHERE organisation_id=$14 RETURNING *`,[b.schoolName??null,Object.hasOwn(b,'shortName'),b.shortName??null,Object.hasOwn(b,'motto'),b.motto??null,Object.hasOwn(b,'phone'),b.phone??null,Object.hasOwn(b,'email'),b.email??null,Object.hasOwn(b,'address'),b.address??null,Object.hasOwn(b,'logoImageData'),b.logoImageData??null,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'school.profile.updated','school_profile',a.core.organisation_id);
  return row;
});

app.get('/api/me/profile',async request=>{
  const a=await authorize(request,db,config);
  const local=await maybeOne<any>(db,'SELECT profile_photo_data FROM school_memberships WHERE organisation_id=$1 AND os_user_id=$2',[a.core.organisation_id,a.core.id]);
  return{
    id:a.core.id,membershipId:a.core.membership_id,firstName:a.core.first_name,lastName:a.core.last_name,email:a.core.email,
    profilePhotoData:local?.profile_photo_data??null,role:a.role,organisationName:a.core.organisation_name
  };
});
app.patch('/api/me/profile',async request=>{
  const a=await authorize(request,db,config,'profile.edit');
  const b=z.object({
    firstName:z.string().trim().min(1).max(100).optional(),
    lastName:z.string().trim().min(1).max(100).optional(),
    email:z.string().trim().toLowerCase().email().optional(),
    profilePhotoData:z.string().max(1500000).nullable().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  if(b.profilePhotoData && !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(b.profilePhotoData))throw fail(400,'Profile picture must be a PNG, JPG or WebP image');
  if(b.firstName!==undefined||b.lastName!==undefined||b.email!==undefined){
    const base=config.CORE_OS_URL.replace(/\/$/,'');
    const res=await fetch(base+'/v1/internal/school/users/'+encodeURIComponent(a.core.membership_id),{
      method:'PATCH',headers:coreServiceHeaders(),signal:AbortSignal.timeout(10000),
      body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id,firstName:b.firstName,lastName:b.lastName,email:b.email})
    });
    if(!res.ok){
      const body=await res.json().catch(()=>null) as any;
      throw fail(res.status,body?.error?.message||'Could not update Core OS profile');
    }
    coreUsersCache.delete(a.core.organisation_id);
  }
  if(Object.hasOwn(b,'profilePhotoData')){
    await db.query('UPDATE school_memberships SET profile_photo_data=$1,updated_at=now() WHERE organisation_id=$2 AND os_user_id=$3',
      [b.profilePhotoData??null,a.core.organisation_id,a.core.id]);
  }
  await audit(a.core.organisation_id,a.core.id,'profile.self_updated','school_membership',a.core.id,{photoChanged:Object.hasOwn(b,'profilePhotoData')});
  return{ok:true};
});

app.patch('/api/school/promotion-settings',async request=>{
  const a=await authorize(request,db,config,'school.manage');
  const b=z.object({thresholdPercent:z.number().min(0).max(100)}).parse(request.body);
  const row=await one<any>(db,`UPDATE school_profiles SET promotion_threshold_percent=$1,updated_at=now()
    WHERE organisation_id=$2 RETURNING promotion_threshold_percent`,[b.thresholdPercent,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'school.promotion_threshold.updated','school_profile',a.core.organisation_id,{thresholdPercent:b.thresholdPercent});
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

app.get('/api/academic-years',async request=>{const a=await authorize(request,db,config,'academic.view');return (await db.query('SELECT * FROM academic_years WHERE organisation_id=$1 ORDER BY start_date DESC',[a.core.organisation_id])).rows});
app.post('/api/academic-years',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');
  const b=z.object({name:z.string().min(4).max(40),startDate:z.string().date(),endDate:z.string().date()}).parse(request.body);
  if(b.endDate<=b.startDate)throw fail(400,'Academic year end date must be after start date');
  const row=await one<any>(db,'INSERT INTO academic_years(organisation_id,name,start_date,end_date) VALUES($1,$2,$3,$4) RETURNING *',[a.core.organisation_id,b.name,b.startDate,b.endDate]);
  await audit(a.core.organisation_id,a.core.id,'academic_year.created','academic_year',row.id);
  return reply.code(201).send(row);
});
async function academicYearPromotionEvidence(queryDb:any,organisationId:string,academicYearId:string,classroomId?:string|null){
  const terms=(await queryDb.query(`SELECT id,term_no,name,start_date,end_date
    FROM terms WHERE organisation_id=$1 AND academic_year_id=$2
    ORDER BY term_no,start_date`,[organisationId,academicYearId])).rows;
  const thresholdRow=await one<any>(queryDb,'SELECT COALESCE(promotion_threshold_percent,50)::numeric threshold FROM school_profiles WHERE organisation_id=$1',[organisationId]);
  const threshold=Number(thresholdRow.threshold||50);
  if(!terms.length)return{terms,threshold,byStudent:new Map<string,any>()};

  const rows=(await queryDb.query(`
    WITH year_terms AS (
      SELECT id term_id,term_no,name term_name
      FROM terms
      WHERE organisation_id=$1 AND academic_year_id=$2
    ),
    source_students AS (
      SELECT e.student_id,e.classroom_id
      FROM enrolments e
      JOIN students s ON s.id=e.student_id
      WHERE e.organisation_id=$1 AND e.academic_year_id=$2
        AND e.status='active' AND s.status='active'
        AND ($3::uuid IS NULL OR e.classroom_id=$3)
    ),
    category_scores AS (
      SELECT ss.student_id,yt.term_id,yt.term_no,yt.term_name,cs.subject_id,
        COALESCE(ac.id,a.id) category_id,
        COALESCE(ac.code,upper(a.assessment_type)) category_code,
        COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,
        ROUND(AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END)::numeric,2) category_average,
        COUNT(a.id)::int assessment_count,
        COUNT(sc.score)::int scored_count
      FROM source_students ss
      CROSS JOIN year_terms yt
      JOIN class_subjects cs ON cs.organisation_id=$1
        AND cs.classroom_id=ss.classroom_id
        AND cs.academic_year_id=$2
        AND cs.is_active=true
      LEFT JOIN assessments a ON a.organisation_id=$1
        AND a.classroom_id=ss.classroom_id
        AND a.subject_id=cs.subject_id
        AND a.term_id=yt.term_id
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=ss.student_id
      GROUP BY ss.student_id,yt.term_id,yt.term_no,yt.term_name,cs.subject_id,
        COALESCE(ac.id,a.id),COALESCE(ac.code,upper(a.assessment_type)),
        COALESCE(ac.weight_percent,a.weight,0)
    ),
    subject_scores AS (
      SELECT student_id,term_id,term_no,term_name,subject_id,
        COALESCE(SUM(assessment_count) FILTER(WHERE category_code<>'EXAM'),0)::int class_assessment_count,
        COALESCE(SUM(scored_count) FILTER(WHERE category_code<>'EXAM'),0)::int class_scored_count,
        COALESCE(SUM(assessment_count) FILTER(WHERE category_code='EXAM'),0)::int exam_count,
        COALESCE(SUM(scored_count) FILTER(WHERE category_code='EXAM'),0)::int exam_scored_count,
        CASE WHEN SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)>0
          THEN SUM(category_average*weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)
            / SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)
          ELSE NULL END class_assessment_raw,
        CASE WHEN SUM(weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)>0
          THEN SUM(category_average*weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)
            / SUM(weight_percent) FILTER(WHERE category_code='EXAM' AND category_average IS NOT NULL)
          ELSE NULL END exam_raw
      FROM category_scores
      GROUP BY student_id,term_id,term_no,term_name,subject_id
    ),
    subject_totals AS (
      SELECT *,
        (class_assessment_count>0 AND exam_count>0
          AND class_scored_count=class_assessment_count
          AND exam_scored_count=exam_count
          AND class_assessment_raw IS NOT NULL
          AND exam_raw IS NOT NULL) subject_complete,
        ROUND((class_assessment_raw*0.30+exam_raw*0.70)::numeric,2) total
      FROM subject_scores
    ),
    term_summary AS (
      SELECT student_id,term_id,term_no,term_name,
        COUNT(*)::int subject_count,
        COUNT(*) FILTER(WHERE subject_complete)::int complete_subjects,
        ROUND(AVG(total) FILTER(WHERE subject_complete)::numeric,2) term_average
      FROM subject_totals
      GROUP BY student_id,term_id,term_no,term_name
    ),
    term_evidence AS (
      SELECT ts.*,
        (ts.subject_count>0 AND ts.complete_subjects=ts.subject_count) academic_complete,
        (rc.workflow_status='approved' AND rc.released_at IS NOT NULL) report_released
      FROM term_summary ts
      LEFT JOIN report_comments rc ON rc.organisation_id=$1
        AND rc.student_id=ts.student_id AND rc.term_id=ts.term_id
    )
    SELECT student_id,
      COUNT(*)::int configured_terms,
      COUNT(*) FILTER(WHERE academic_complete)::int complete_terms,
      COUNT(*) FILTER(WHERE academic_complete AND report_released)::int ready_terms,
      ROUND(AVG(term_average) FILTER(WHERE academic_complete)::numeric,2) academic_average,
      jsonb_agg(jsonb_build_object(
        'termId',term_id,'termNo',term_no,'termName',term_name,
        'average',term_average,'academicComplete',academic_complete,
        'reportReleased',report_released,'subjectCount',subject_count,
        'completeSubjects',complete_subjects
      ) ORDER BY term_no) term_averages
    FROM term_evidence
    GROUP BY student_id
  `,[organisationId,academicYearId,classroomId??null])).rows;

  const byStudent=new Map<string,any>();
  for(const row of rows){
    const configuredTerms=Number(row.configured_terms||0);
    const completeTerms=Number(row.complete_terms||0);
    const readyTerms=Number(row.ready_terms||0);
    const annualAverage=row.academic_average==null?null:Number(row.academic_average);
    const ready=configuredTerms===3&&completeTerms===3&&readyTerms===3&&annualAverage!=null;
    let reason:string|null=null;
    if(configuredTerms<3)reason='All three terms must be configured before promotion';
    else if(completeTerms<3)reason='All three terms must have complete assessment results';
    else if(readyTerms<3)reason='All three term reports must be approved and released';
    byStudent.set(row.student_id,{
      configuredTerms,completeTerms,readyTerms,annualAverage,
      termAverages:row.term_averages||[],ready,reason,threshold
    });
  }
  return{terms,threshold,byStudent};
}

async function autoRolloverReleasedReports(client:any,organisationId:string,fromYearId:string,toYearId:string,actorOsUserId:string){
  const evidence=await academicYearPromotionEvidence(client,organisationId,fromYearId,null);
  if(evidence.terms.length<3)return{processed:0,promoted:0,repeated:0,completed:0,unresolved:[{reason:'All three terms must be configured before academic-year rollover'}]};

  const rows=(await client.query(`SELECT e.id enrolment_id,e.student_id,e.classroom_id,c.grade_level_id,c.stream,
      g.level_order,g.code grade_code,g.name grade_name,s.admission_no,s.first_name,s.last_name
    FROM enrolments e
    JOIN students s ON s.id=e.student_id
    JOIN classrooms c ON c.id=e.classroom_id
    JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE e.organisation_id=$1 AND e.academic_year_id=$2 AND e.status='active' AND s.status='active'
    ORDER BY g.level_order,c.name,s.last_name,s.first_name`,[organisationId,fromYearId])).rows;

  let processed=0,promoted=0,repeated=0,completed=0;
  const unresolved:any[]=[];
  for(const row of rows){
    const already=await maybeOne<any>(client,'SELECT id FROM student_promotions WHERE organisation_id=$1 AND student_id=$2 AND to_academic_year_id=$3',
      [organisationId,row.student_id,toYearId]);
    if(already){processed++;continue}
    const ev=evidence.byStudent.get(row.student_id);
    if(!ev?.ready){
      unresolved.push({studentId:row.student_id,admissionNo:row.admission_no,name:row.first_name+' '+row.last_name,reason:ev?.reason||'Academic-year promotion evidence is incomplete'});
      continue;
    }

    const passed=Number(ev.annualAverage)>=evidence.threshold;
    let outcome=passed?'promoted':'repeated';
    let targetClassId:string|null=null;
    let targetGradeId:string|null=null;

    if(outcome==='promoted'){
      const nextGrade=await maybeOne<any>(client,`SELECT id FROM grade_levels
        WHERE organisation_id=$1 AND is_active=true AND level_order>$2 ORDER BY level_order LIMIT 1`,[organisationId,row.level_order]);
      if(!nextGrade)outcome='completed';
      else targetGradeId=nextGrade.id;
    }else{
      targetGradeId=row.grade_level_id;
    }

    if(outcome!=='completed'){
      const candidates=(await client.query(`SELECT id,name,stream FROM classrooms
        WHERE organisation_id=$1 AND academic_year_id=$2 AND grade_level_id=$3 AND is_active=true
        ORDER BY name`,[organisationId,toYearId,targetGradeId])).rows;
      const streamMatch=row.stream?candidates.filter((x:any)=>String(x.stream||'').toLowerCase()===String(row.stream||'').toLowerCase()):[];
      if(streamMatch.length===1)targetClassId=streamMatch[0].id;
      else if(candidates.length===1)targetClassId=candidates[0].id;
      else{
        unresolved.push({studentId:row.student_id,admissionNo:row.admission_no,name:row.first_name+' '+row.last_name,
          reason:candidates.length?'Multiple destination classes exist; assign the destination in Promotion & Rollover':'Destination class has not been created'});
        continue;
      }
    }

    if(outcome==='completed'){
      await client.query("UPDATE enrolments SET status='completed' WHERE id=$1",[row.enrolment_id]);
      await client.query("UPDATE students SET status='graduated',updated_at=now() WHERE id=$1",[row.student_id]);
      completed++;
    }else{
      await client.query("UPDATE enrolments SET status=$1 WHERE id=$2",[outcome==='promoted'?'promoted':'repeated',row.enrolment_id]);
      await client.query(`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status)
        VALUES($1,$2,$3,$4,'active')
        ON CONFLICT(student_id,academic_year_id)
        DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status='active',enrolled_at=now()`,
        [organisationId,row.student_id,toYearId,targetClassId]);
      await assignMandatoryFees(client,organisationId,row.student_id,toYearId,targetClassId!);
      await client.query("UPDATE students SET status='active',updated_at=now() WHERE id=$1",[row.student_id]);
      if(outcome==='promoted')promoted++;else repeated++;
    }

    await client.query(`INSERT INTO student_promotions(
      organisation_id,student_id,from_academic_year_id,to_academic_year_id,from_classroom_id,to_classroom_id,
      outcome,processed_by_os_user_id,academic_average,terms_count,promotion_basis
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'academic_year_average')
    ON CONFLICT(student_id,to_academic_year_id)
    DO UPDATE SET from_classroom_id=EXCLUDED.from_classroom_id,to_classroom_id=EXCLUDED.to_classroom_id,
      outcome=EXCLUDED.outcome,processed_by_os_user_id=EXCLUDED.processed_by_os_user_id,
      academic_average=EXCLUDED.academic_average,terms_count=EXCLUDED.terms_count,
      promotion_basis=EXCLUDED.promotion_basis,created_at=now()`,[
      organisationId,row.student_id,fromYearId,toYearId,row.classroom_id,targetClassId,outcome,actorOsUserId,
      ev.annualAverage,ev.completeTerms
    ]);
    processed++;
  }
  return{processed,promoted,repeated,completed,unresolved,totalCandidates:rows.length,threshold:evidence.threshold};
}

app.post('/api/academic-years/:id/activate',async request=>{
  const a=await authorize(request,db,config,'academic.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const result=await tx(db,async c=>{
    const target=await one<any>(c,'SELECT * FROM academic_years WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const source=await maybeOne<any>(c,"SELECT * FROM academic_years WHERE organisation_id=$1 AND status='active' AND id<>$2 ORDER BY start_date DESC LIMIT 1",[a.core.organisation_id,id]);
    let rollover:any={processed:0,promoted:0,repeated:0,completed:0,unresolved:[]};
    if(source&&new Date(target.start_date)>new Date(source.start_date)){
      rollover=await autoRolloverReleasedReports(c,a.core.organisation_id,source.id,target.id,a.core.id);
    }
    await c.query("UPDATE academic_years SET status='closed' WHERE organisation_id=$1 AND status='active' AND id<>$2",[a.core.organisation_id,id]);
    const row=await one<any>(c,"UPDATE academic_years SET status='active' WHERE id=$1 AND organisation_id=$2 RETURNING *",[id,a.core.organisation_id]);
    return{...row,rollover};
  });
  await audit(a.core.organisation_id,a.core.id,'academic_year.activated','academic_year',id,{rollover:result.rollover});
  return result;
});

app.get('/api/terms',async request=>{const a=await authorize(request,db,config,'academic.view');const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query('SELECT * FROM terms WHERE organisation_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) ORDER BY start_date',[a.core.organisation_id,q.academicYearId??null])).rows});
app.post('/api/terms',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');
  const b=z.object({
    academicYearId:z.string().uuid(),termNo:z.number().int().min(1).max(3),name:z.string().min(2).max(80),
    startDate:z.string().date(),endDate:z.string().date(),nextTermBegins:z.string().date().nullable().optional()
  }).parse(request.body);
  if(b.endDate<=b.startDate)throw fail(400,'Term end date must be after start date');
  if(b.nextTermBegins&&b.nextTermBegins<=b.endDate)throw fail(400,'Next term begins must be after the current term ends');
  const row=await one<any>(db,'INSERT INTO terms(organisation_id,academic_year_id,term_no,name,start_date,end_date,next_term_begins) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[a.core.organisation_id,b.academicYearId,b.termNo,b.name,b.startDate,b.endDate,b.nextTermBegins??null]);
  await audit(a.core.organisation_id,a.core.id,'term.created','term',row.id);return reply.code(201).send(row);
});
app.post('/api/terms/:id/activate',async request=>{
  const a=await authorize(request,db,config,'academic.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  return tx(db,async c=>{const target=await one<any>(c,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await c.query("UPDATE terms SET status='closed' WHERE organisation_id=$1 AND academic_year_id=$2 AND status='active' AND id<>$3",[a.core.organisation_id,target.academic_year_id,id]);return one(c,"UPDATE terms SET status='active' WHERE id=$1 RETURNING *",[id])});
});

app.get('/api/grade-levels',async request=>{const a=await authorize(request,db,config,'academic.view');return (await db.query('SELECT * FROM grade_levels WHERE organisation_id=$1 ORDER BY level_order',[a.core.organisation_id])).rows});
app.get('/api/classes',async request=>{const a=await authorize(request,db,config,'academic.view');const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query(`SELECT c.*,g.code grade_code,g.name grade_name,
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
app.get('/api/subjects',async request=>{const a=await authorize(request,db,config,'academic.view');return (await db.query('SELECT * FROM subjects WHERE organisation_id=$1 ORDER BY name',[a.core.organisation_id])).rows});
app.post('/api/subjects',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');const b=z.object({code:z.string().min(1).max(30),name:z.string().min(2).max(120),stage:z.enum(['primary','jhs','both']).default('both')}).parse(request.body);
  const row=await one<any>(db,'INSERT INTO subjects(organisation_id,code,name,stage) VALUES($1,$2,$3,$4) RETURNING *',[a.core.organisation_id,b.code.toUpperCase(),b.name,b.stage]);await audit(a.core.organisation_id,a.core.id,'subject.created','subject',row.id);return reply.code(201).send(row);
});

app.get('/api/class-subjects',async request=>{
  const a=await authorize(request,db,config,'academic.view');
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
app.post('/api/class-subjects/bulk',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.edit');
  const b=z.object({
    academicYearId:z.string().uuid(),
    classroomId:z.string().uuid(),
    subjectIds:z.array(z.string().uuid()).min(1).max(30)
  }).parse(request.body);

  const cls=await one<any>(db,`SELECT c.id,c.name,g.stage
    FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.id=$1 AND c.organisation_id=$2 AND c.academic_year_id=$3`,
    [b.classroomId,a.core.organisation_id,b.academicYearId]);

  const uniqueIds=[...new Set(b.subjectIds)];
  const subjects=(await db.query(`SELECT id,name,stage FROM subjects
    WHERE organisation_id=$1 AND is_active=true AND id=ANY($2::uuid[])`,
    [a.core.organisation_id,uniqueIds])).rows;
  if(subjects.length!==uniqueIds.length)throw fail(400,'One or more selected subjects are unavailable');
  const invalid=subjects.filter((s:any)=>s.stage!=='both'&&s.stage!==cls.stage);
  if(invalid.length)throw fail(400,`These subjects are not configured for this class stage: ${invalid.map((s:any)=>s.name).join(', ')}`);

  const rows=await tx(db,async client=>{
    const added:any[]=[];
    for(const subjectId of uniqueIds){
      const row=await one<any>(client,`INSERT INTO class_subjects(
          organisation_id,academic_year_id,classroom_id,subject_id,is_active
        ) VALUES($1,$2,$3,$4,true)
        ON CONFLICT(academic_year_id,classroom_id,subject_id)
        DO UPDATE SET is_active=true,updated_at=now()
        RETURNING *`,
        [a.core.organisation_id,b.academicYearId,b.classroomId,subjectId]);
      added.push(row);
    }
    return added;
  });

  await audit(a.core.organisation_id,a.core.id,'class_subject.bulk_assigned','classroom',b.classroomId,{
    academicYearId:b.academicYearId,subjectIds:uniqueIds,count:rows.length
  });
  return reply.code(201).send({classroomId:b.classroomId,added:rows.length,subjects:rows});
});


app.put('/api/academic-manager/classes/:classroomId/setup',async request=>{
  const a=await authorize(request,db,config,'teaching_assignments.manage');
  const {classroomId}=z.object({classroomId:z.string().uuid()}).parse(request.params);
  const b=z.object({
    academicYearId:z.string().uuid(),
    termId:z.string().uuid().nullable().optional(),
    classTeacherOsUserId:z.string().uuid().nullable().optional(),
    subjects:z.array(z.object({
      subjectId:z.string().uuid(),
      weeklyPeriods:z.number().int().min(1).max(20),
      creditHours:z.number().min(0.25).max(20),
      teacherOsUserId:z.string().uuid().nullable().optional()
    })).max(40)
  }).parse(request.body);

  const classroom=await one<any>(db,`SELECT c.*,g.stage,g.name grade_name
    FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.id=$1 AND c.organisation_id=$2 AND c.academic_year_id=$3 AND c.is_active=true`,
    [classroomId,a.core.organisation_id,b.academicYearId]);
  if(b.termId)await one<any>(db,'SELECT id FROM terms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3',
    [b.termId,a.core.organisation_id,b.academicYearId]);

  const subjectIds=[...new Set(b.subjects.map(x=>x.subjectId))];
  if(subjectIds.length!==b.subjects.length)throw fail(400,'Each subject can appear only once in a class setup');
  if(subjectIds.length){
    const subjectRows=(await db.query(`SELECT id,name,stage FROM subjects
      WHERE organisation_id=$1 AND is_active=true AND id=ANY($2::uuid[])`,
      [a.core.organisation_id,subjectIds])).rows;
    if(subjectRows.length!==subjectIds.length)throw fail(400,'One or more selected subjects are unavailable');
    const invalid=subjectRows.filter((s:any)=>s.stage!=='both'&&s.stage!==classroom.stage);
    if(invalid.length)throw fail(400,`These subjects are not configured for ${classroom.grade_name}: ${invalid.map((x:any)=>x.name).join(', ')}`);
  }

  const teacherIds=[...new Set([
    ...(b.classTeacherOsUserId?[b.classTeacherOsUserId]:[]),
    ...b.subjects.map(x=>x.teacherOsUserId).filter(Boolean)
  ] as string[])];
  if(teacherIds.length){
    const valid=(await db.query(`SELECT sm.os_user_id FROM school_memberships sm
      JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
      WHERE sm.organisation_id=$1 AND sm.status='active' AND sr.is_active=true AND sr.can_teach=true
        AND sm.os_user_id=ANY($2::uuid[])`,[a.core.organisation_id,teacherIds])).rows.map((x:any)=>x.os_user_id);
    const missing=teacherIds.filter(id=>!valid.includes(id));
    if(missing.length)throw fail(409,'One or more selected teachers do not have active teaching access');
  }
  if(b.classTeacherOsUserId){
    const other=await maybeOne<any>(db,`SELECT c.name classroom_name FROM teacher_assignments ta
      JOIN classrooms c ON c.id=ta.classroom_id
      WHERE ta.organisation_id=$1 AND ta.academic_year_id=$2 AND ta.teacher_os_user_id=$3
        AND ta.subject_id IS NULL AND ta.is_active=true AND ta.classroom_id<>$4
        AND (
          ($5::uuid IS NULL AND ta.term_id IS NULL)
          OR
          ($5::uuid IS NOT NULL AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $5::uuid))
        )
      ORDER BY (ta.term_id IS NOT NULL) DESC,ta.created_at DESC LIMIT 1`,
      [a.core.organisation_id,b.academicYearId,b.classTeacherOsUserId,classroomId,b.termId??null]);
    if(other)throw fail(409,`This teacher is already Class Teacher for ${other.classroom_name}. Choose a different Class Teacher.`);
  }

  const result=await tx(db,async client=>{
    const current=(await client.query(`SELECT * FROM class_subjects
      WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND is_active=true`,
      [a.core.organisation_id,b.academicYearId,classroomId])).rows;
    const removed=current.filter((x:any)=>!subjectIds.includes(x.subject_id));

    let archivedTimetableEntries=0;
    for(const row of removed){
      await client.query(`UPDATE teacher_assignments SET is_active=false
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id=$4 AND is_active=true`,
        [a.core.organisation_id,b.academicYearId,classroomId,row.subject_id]);
      const deleted=await client.query(`DELETE FROM timetable_entries
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id=$4`,
        [a.core.organisation_id,b.academicYearId,classroomId,row.subject_id]);
      archivedTimetableEntries+=deleted.rowCount||0;
      await client.query('UPDATE class_subjects SET is_active=false,updated_at=now() WHERE id=$1',[row.id]);
    }

    for(const item of b.subjects){
      await client.query(`INSERT INTO class_subjects(
          organisation_id,academic_year_id,classroom_id,subject_id,weekly_periods,credit_hours,is_active
        ) VALUES($1,$2,$3,$4,$5,$6,true)
        ON CONFLICT(academic_year_id,classroom_id,subject_id)
        DO UPDATE SET weekly_periods=EXCLUDED.weekly_periods,credit_hours=EXCLUDED.credit_hours,is_active=true,updated_at=now()`,
        [a.core.organisation_id,b.academicYearId,classroomId,item.subjectId,item.weeklyPeriods,item.creditHours]);

      await client.query(`UPDATE teacher_assignments SET is_active=false
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id=$4
          AND term_id IS NOT DISTINCT FROM $5::uuid AND is_active=true`,
        [a.core.organisation_id,b.academicYearId,classroomId,item.subjectId,b.termId??null]);

      if(item.teacherOsUserId){
        const existing=(await client.query(`SELECT id FROM teacher_assignments
          WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id=$4
            AND term_id IS NOT DISTINCT FROM $5::uuid AND teacher_os_user_id=$6
          ORDER BY created_at DESC LIMIT 1`,
          [a.core.organisation_id,b.academicYearId,classroomId,item.subjectId,b.termId??null,item.teacherOsUserId])).rows[0];
        if(existing)await client.query('UPDATE teacher_assignments SET is_active=true WHERE id=$1',[existing.id]);
        else await client.query(`INSERT INTO teacher_assignments(
          organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,is_active
        ) VALUES($1,$2,$3,$4,$5,$6,true)`,
          [a.core.organisation_id,b.academicYearId,b.termId??null,classroomId,item.subjectId,item.teacherOsUserId]);
      }
    }

    await client.query(`UPDATE teacher_assignments SET is_active=false
      WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id IS NULL
        AND term_id IS NOT DISTINCT FROM $4::uuid AND is_active=true`,
      [a.core.organisation_id,b.academicYearId,classroomId,b.termId??null]);

    if(b.classTeacherOsUserId){
      const existing=(await client.query(`SELECT id FROM teacher_assignments
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id IS NULL
          AND term_id IS NOT DISTINCT FROM $4::uuid AND teacher_os_user_id=$5
        ORDER BY created_at DESC LIMIT 1`,
        [a.core.organisation_id,b.academicYearId,classroomId,b.termId??null,b.classTeacherOsUserId])).rows[0];
      if(existing)await client.query('UPDATE teacher_assignments SET is_active=true WHERE id=$1',[existing.id]);
      else await client.query(`INSERT INTO teacher_assignments(
        organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,is_active
      ) VALUES($1,$2,$3,$4,NULL,$5,true)`,
        [a.core.organisation_id,b.academicYearId,b.termId??null,classroomId,b.classTeacherOsUserId]);
    }

    if(!b.termId){
      await client.query('UPDATE classrooms SET class_teacher_os_user_id=$1 WHERE id=$2 AND organisation_id=$3',
        [b.classTeacherOsUserId??null,classroomId,a.core.organisation_id]);
    }

    return{
      classroomId,
      academicYearId:b.academicYearId,
      termId:b.termId??null,
      classTeacherOsUserId:b.classTeacherOsUserId??null,
      subjectCount:b.subjects.length,
      removedSubjects:removed.length,
      removedTimetablePeriods:archivedTimetableEntries
    };
  });

  await audit(a.core.organisation_id,a.core.id,'academic_manager.class_setup_saved','classroom',classroomId,result);
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'academic_manager.class_setup_saved',
    resourceType:'classroom',resourceId:classroomId,performedOn:classroom.name,
    oldValue:null,newValue:{termId:b.termId??null,classTeacherOsUserId:b.classTeacherOsUserId??null,subjects:b.subjects}
  });
  return result;
});

app.post('/api/teacher-assignments/bulk',async request=>{
  const a=await authorize(request,db,config,'teaching_assignments.manage');
  const b=z.object({
    academicYearId:z.string().uuid(),
    termId:z.string().uuid().nullable().optional(),
    teacherOsUserId:z.string().uuid(),
    mode:z.enum(['class_teacher','all_subjects','subject_across_classes']),
    classroomIds:z.array(z.string().uuid()).min(1).max(60),
    subjectId:z.string().uuid().nullable().optional()
  }).parse(request.body);

  await one<any>(db,`SELECT sm.os_user_id FROM school_memberships sm
    JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 AND sm.os_user_id=$2 AND sm.status='active' AND sr.is_active=true AND sr.can_teach=true`,
    [a.core.organisation_id,b.teacherOsUserId]);
  if(b.termId)await one<any>(db,'SELECT id FROM terms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3',
    [b.termId,a.core.organisation_id,b.academicYearId]);

  const uniqueClasses=[...new Set(b.classroomIds)];
  const classRows=(await db.query(`SELECT id,name FROM classrooms
    WHERE organisation_id=$1 AND academic_year_id=$2 AND is_active=true AND id=ANY($3::uuid[])`,
    [a.core.organisation_id,b.academicYearId,uniqueClasses])).rows;
  if(classRows.length!==uniqueClasses.length)throw fail(400,'One or more selected classes are unavailable');

  let pairs:{classroomId:string;subjectId:string|null}[]=[];
  if(b.mode==='class_teacher'){
    if(uniqueClasses.length!==1)throw fail(409,'A teacher can be Class Teacher for only one class. Select one class only.');
    const targetClass=uniqueClasses[0]!;
    const other=await maybeOne<any>(db,`SELECT c.name classroom_name FROM teacher_assignments ta
      JOIN classrooms c ON c.id=ta.classroom_id
      WHERE ta.organisation_id=$1 AND ta.academic_year_id=$2 AND ta.teacher_os_user_id=$3
        AND ta.subject_id IS NULL AND ta.is_active=true AND ta.classroom_id<>$4
        AND (
          ($5::uuid IS NULL AND ta.term_id IS NULL)
          OR
          ($5::uuid IS NOT NULL AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $5::uuid))
        )
      LIMIT 1`,
      [a.core.organisation_id,b.academicYearId,b.teacherOsUserId,targetClass,b.termId??null]);
    if(other)throw fail(409,`This teacher is already Class Teacher for ${other.classroom_name}.`);
    pairs=[{classroomId:targetClass,subjectId:null}];
  }else if(b.mode==='all_subjects'){
    pairs=(await db.query(`SELECT classroom_id,subject_id FROM class_subjects
      WHERE organisation_id=$1 AND academic_year_id=$2 AND is_active=true AND classroom_id=ANY($3::uuid[])
      ORDER BY classroom_id,subject_id`,[a.core.organisation_id,b.academicYearId,uniqueClasses])).rows.map((x:any)=>({classroomId:x.classroom_id,subjectId:x.subject_id}));
    if(!pairs.length)throw fail(409,'The selected classes do not have any subjects configured');
  }else{
    if(!b.subjectId)throw fail(400,'Choose the subject to assign across classes');
    pairs=(await db.query(`SELECT classroom_id,subject_id FROM class_subjects
      WHERE organisation_id=$1 AND academic_year_id=$2 AND is_active=true AND classroom_id=ANY($3::uuid[]) AND subject_id=$4`,
      [a.core.organisation_id,b.academicYearId,uniqueClasses,b.subjectId])).rows.map((x:any)=>({classroomId:x.classroom_id,subjectId:x.subject_id}));
    if(!pairs.length)throw fail(409,'That subject has not been added to any of the selected classes');
  }

  const result=await tx(db,async client=>{
    let saved=0;
    for(const pair of pairs){
      await client.query(`UPDATE teacher_assignments SET is_active=false
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3
          AND subject_id IS NOT DISTINCT FROM $4::uuid AND term_id IS NOT DISTINCT FROM $5::uuid AND is_active=true`,
        [a.core.organisation_id,b.academicYearId,pair.classroomId,pair.subjectId,b.termId??null]);
      const existing=(await client.query(`SELECT id FROM teacher_assignments
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3
          AND subject_id IS NOT DISTINCT FROM $4::uuid AND term_id IS NOT DISTINCT FROM $5::uuid AND teacher_os_user_id=$6
        ORDER BY created_at DESC LIMIT 1`,
        [a.core.organisation_id,b.academicYearId,pair.classroomId,pair.subjectId,b.termId??null,b.teacherOsUserId])).rows[0];
      if(existing)await client.query('UPDATE teacher_assignments SET is_active=true WHERE id=$1',[existing.id]);
      else await client.query(`INSERT INTO teacher_assignments(
        organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,is_active
      ) VALUES($1,$2,$3,$4,$5,$6,true)`,
        [a.core.organisation_id,b.academicYearId,b.termId??null,pair.classroomId,pair.subjectId,b.teacherOsUserId]);
      if(pair.subjectId===null&&!b.termId){
        await client.query('UPDATE classrooms SET class_teacher_os_user_id=$1 WHERE id=$2 AND organisation_id=$3',
          [b.teacherOsUserId,pair.classroomId,a.core.organisation_id]);
      }
      saved++;
    }
    return{saved,eligiblePairs:pairs.length,selectedClasses:uniqueClasses.length};
  });
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.bulk_saved','teacher_assignment',null,{
    teacherOsUserId:b.teacherOsUserId,mode:b.mode,termId:b.termId??null,...result
  });
  return result;
});

app.patch('/api/class-subjects/:id',async request=>{
  const a=await authorize(request,db,config,'teaching_assignments.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    weeklyPeriods:z.number().int().min(1).max(20).optional(),
    creditHours:z.number().min(0.25).max(20).optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const before=await one<any>(db,`SELECT cs.*,c.name classroom_name,s.name subject_name FROM class_subjects cs
    JOIN classrooms c ON c.id=cs.classroom_id JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.id=$1 AND cs.organisation_id=$2`,[id,a.core.organisation_id]);
  const row=await one<any>(db,`UPDATE class_subjects SET
    weekly_periods=COALESCE($1,weekly_periods),
    credit_hours=COALESCE($2,credit_hours),
    updated_at=now()
    WHERE id=$3 AND organisation_id=$4 RETURNING *`,[b.weeklyPeriods??null,b.creditHours??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'class_subject.schedule_requirement_updated','class_subject',id,{weeklyPeriods:row.weekly_periods,creditHours:row.credit_hours});
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'class_subject.schedule_requirement_updated',
    resourceType:'class_subject',resourceId:id,performedOn:before.classroom_name+' • '+before.subject_name,
    oldValue:{weeklyPeriods:before.weekly_periods,creditHours:before.credit_hours},
    newValue:{weeklyPeriods:row.weekly_periods,creditHours:row.credit_hours}
  });
  return row;
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
  const a=await authorize(request,db,config,'students.view');const q=z.object({q:z.string().max(100).optional(),classroomId:z.string().uuid().optional(),status:z.enum(['active','inactive','suspended','graduated','transferred','withdrawn']).optional()}).parse(request.query);const s=q.q?('%'+q.q+'%'):null;
  return (await db.query(`SELECT DISTINCT s.*,c.id classroom_id,c.name classroom_name,g.name grade_name,e.academic_year_id FROM students s LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active' LEFT JOIN classrooms c ON c.id=e.classroom_id LEFT JOIN grade_levels g ON g.id=c.grade_level_id WHERE s.organisation_id=$1 AND ($2::text IS NULL OR (s.first_name||' '||s.last_name||' '||s.admission_no) ILIKE $2) AND ($3::uuid IS NULL OR c.id=$3) AND ($4::text IS NULL OR s.status=$4) ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,s,q.classroomId??null,q.status??null])).rows;
});
app.post('/api/students',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.create');
  const b=z.object({
    admissionNo:z.string().min(1).max(60),firstName:z.string().min(1).max(100),middleName:z.string().max(100).optional(),
    lastName:z.string().min(1).max(100),sex:z.enum(['male','female']).optional(),dateOfBirth:z.string().date().optional(),
    admissionDate:z.string().date().optional(),notes:z.string().max(5000).optional(),
    guardianFirstName:z.string().min(1).max(100),guardianLastName:z.string().min(1).max(100),
    guardianPhone:z.string().min(5).max(60),guardianEmail:z.string().email().optional(),
    guardianRelationship:z.string().min(2).max(60)
  }).parse(request.body);
  const result=await tx(db,async client=>{
    const student=await one<any>(client,`INSERT INTO students(
      organisation_id,admission_no,first_name,middle_name,last_name,sex,date_of_birth,admission_date,notes
    ) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date,current_date),$9) RETURNING *`,[
      a.core.organisation_id,b.admissionNo,b.firstName,b.middleName??null,b.lastName,b.sex??null,
      b.dateOfBirth??null,b.admissionDate??null,b.notes??null
    ]);
    let guardian=await maybeOne<any>(client,'SELECT * FROM guardians WHERE organisation_id=$1 AND phone=$2 ORDER BY created_at LIMIT 1',
      [a.core.organisation_id,b.guardianPhone]);
    if(!guardian){
      guardian=await one<any>(client,`INSERT INTO guardians(organisation_id,first_name,last_name,phone,email)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[
        a.core.organisation_id,b.guardianFirstName,b.guardianLastName,b.guardianPhone,b.guardianEmail??null
      ]);
    }else{
      guardian=await one<any>(client,`UPDATE guardians SET first_name=$1,last_name=$2,email=$3
        WHERE id=$4 RETURNING *`,[b.guardianFirstName,b.guardianLastName,b.guardianEmail??guardian.email??null,guardian.id]);
    }
    await client.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[student.id]);
    await client.query(`INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary)
      VALUES($1,$2,$3,true)
      ON CONFLICT(student_id,guardian_id) DO UPDATE SET relationship=EXCLUDED.relationship,is_primary=true`,
      [student.id,guardian.id,b.guardianRelationship]);
    await client.query(`INSERT INTO student_status_history(organisation_id,student_id,old_status,new_status,reason,changed_by_os_user_id)
      VALUES($1,$2,NULL,'active','Student onboarded',$3)`,[a.core.organisation_id,student.id,a.core.id]);
    return{student,guardian};
  });
  await audit(a.core.organisation_id,a.core.id,'student.created','student',result.student.id,{
    guardianId:result.guardian.id,guardianEmail:result.guardian.email
  });
  return reply.code(201).send(result);
});
app.get('/api/students/:id',async request=>{const a=await authorize(request,db,config,'students.view');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const student=await maybeOne<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!student)throw fail(404,'Student not found');const guardians=(await db.query(`SELECT g.*,sg.relationship,sg.is_primary FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC,g.last_name`,[id])).rows;const enrolments=(await db.query(`SELECT e.*,c.name classroom_name,g.name grade_name,y.name academic_year FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id JOIN academic_years y ON y.id=e.academic_year_id WHERE e.student_id=$1 ORDER BY y.start_date DESC`,[id])).rows;return{...student,guardians,enrolments}});

app.get('/api/students/:id/360',async request=>{
  const a=await authorize(request,db,config,'students.view');
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
  if(student.classroom_id){
    student.class_teacher_os_user_id=await effectiveClassTeacher(a.core.organisation_id,student.classroom_id,term?.id??null);
  }
  const guardians=(await db.query(`SELECT g.id,g.first_name,g.last_name,g.phone,g.email,g.address,sg.relationship,sg.is_primary
    FROM guardians g
    JOIN student_guardians sg ON sg.guardian_id=g.id
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
  const feeItems=(await db.query(`SELECT sf.id,f.name fee_name,sf.amount_due,sf.discount,sf.status,
      y.name academic_year,t.name term_name,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) paid,
      GREATEST(0,(sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0)) balance
    FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id
    JOIN academic_years y ON y.id=f.academic_year_id
    LEFT JOIN terms t ON t.id=f.term_id
    WHERE sf.organisation_id=$1 AND sf.student_id=$2
    ORDER BY y.start_date DESC,t.term_no NULLS LAST,f.name`,[a.core.organisation_id,id])).rows;
  const accountCredits=(await db.query(`SELECT id,original_amount,balance,created_at FROM student_account_credits
    WHERE organisation_id=$1 AND student_id=$2 ORDER BY created_at DESC`,[a.core.organisation_id,id])).rows;
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
  const reportHistory=(await db.query(`SELECT rc.id,rc.workflow_status,rc.submitted_at,rc.reviewed_at,rc.released_at,
      rc.promotion_decision,rc.class_teacher_comment,rc.headteacher_comment,t.name term_name,y.name academic_year
    FROM report_comments rc JOIN terms t ON t.id=rc.term_id JOIN academic_years y ON y.id=t.academic_year_id
    WHERE rc.organisation_id=$1 AND rc.student_id=$2
    ORDER BY y.start_date DESC,t.term_no DESC`,[a.core.organisation_id,id])).rows;
  const statementRequests=(await db.query(`SELECT id,purpose,status,statement_reference,requested_by_type,requested_at,reviewed_at,issued_at
    FROM academic_statement_requests WHERE organisation_id=$1 AND student_id=$2 ORDER BY requested_at DESC`,
    [a.core.organisation_id,id])).rows;
  const admissionApplication=await maybeOne<any>(db,`SELECT id,application_no,source,requested_grade_code,status,submitted_at,reviewed_at,review_note
    FROM admission_applications WHERE organisation_id=$1 AND student_id=$2 ORDER BY submitted_at DESC LIMIT 1`,
    [a.core.organisation_id,id]);
  const comments=term?await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,id,term.id]):null;
  const portal=await maybeOne<any>(db,`SELECT spa.is_active,spa.last_login_at,
      (SELECT count(*)::int FROM student_portal_sessions sps WHERE sps.student_id=spa.student_id AND sps.revoked_at IS NULL AND sps.expires_at>now()) active_sessions
    FROM student_portal_access spa WHERE spa.student_id=$1`,[id]);
  const activity=(await db.query(`SELECT action,resource_type,resource_id,metadata,created_at FROM school_audit_logs
    WHERE organisation_id=$1 AND (resource_id=$2 OR metadata->>'studentId'=$2)
    ORDER BY created_at DESC LIMIT 20`,[a.core.organisation_id,id])).rows;
  const statusHistory=(await db.query(`SELECT * FROM student_status_history
    WHERE organisation_id=$1 AND student_id=$2 ORDER BY changed_at DESC`,[a.core.organisation_id,id])).rows;
  return{student,term,guardians,enrolments,attendance,recentAttendance,fees:fee,feeItems,payments,accountCredits,subjects,performance,homework,promotions,reportHistory,statementRequests,admissionApplication,comments,portal,activity,statusHistory};
});
app.patch('/api/students/:id',async request=>{
  const a=await authorize(request,db,config,'students.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    firstName:z.string().min(1).max(100).optional(),middleName:z.string().max(100).nullable().optional(),
    lastName:z.string().min(1).max(100).optional(),sex:z.enum(['male','female']).nullable().optional(),
    dateOfBirth:z.string().date().nullable().optional(),admissionDate:z.string().date().optional(),
    notes:z.string().max(5000).nullable().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const row=await one<any>(db,`UPDATE students SET
    first_name=COALESCE($1,first_name),
    middle_name=CASE WHEN $2 THEN $3 ELSE middle_name END,
    last_name=COALESCE($4,last_name),
    sex=CASE WHEN $5 THEN $6 ELSE sex END,
    date_of_birth=CASE WHEN $7 THEN $8::date ELSE date_of_birth END,
    admission_date=COALESCE($9::date,admission_date),
    notes=CASE WHEN $10 THEN $11 ELSE notes END,updated_at=now()
    WHERE id=$12 AND organisation_id=$13 RETURNING *`,[
      b.firstName??null,Object.hasOwn(b,'middleName'),b.middleName??null,b.lastName??null,
      Object.hasOwn(b,'sex'),b.sex??null,Object.hasOwn(b,'dateOfBirth'),b.dateOfBirth??null,
      b.admissionDate??null,Object.hasOwn(b,'notes'),b.notes??null,id,a.core.organisation_id
    ]);
  await audit(a.core.organisation_id,a.core.id,'student.updated','student',id);
  return row;
});

app.post('/api/students/:id/status',async request=>{
  const a=await authorize(request,db,config,'students.status');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    status:z.enum(['active','inactive','suspended','graduated','transferred','withdrawn']),
    reason:z.string().trim().max(2000).optional(),
    classroomId:z.string().uuid().optional()
  }).superRefine((v,ctx)=>{
    if(v.status!=='active'&&(!v.reason||v.reason.trim().length<3)){
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['reason'],message:'Give a reason for changing the student from active status'});
    }
  }).parse(request.body);

  const result=await tx(db,async client=>{
    const student=await one<any>(client,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
    if(student.status===b.status)return{student,unchanged:true,enrolment:null};

    let enrolment=await maybeOne<any>(client,`SELECT e.*,c.name classroom_name FROM enrolments e
      JOIN classrooms c ON c.id=e.classroom_id
      WHERE e.organisation_id=$1 AND e.student_id=$2 AND e.status='active'
      ORDER BY e.enrolled_at DESC LIMIT 1 FOR UPDATE OF e`,[a.core.organisation_id,id]);

    if(b.status==='active'){
      if(!enrolment){
        const year=await maybeOne<any>(client,"SELECT * FROM academic_years WHERE organisation_id=$1 AND status='active' ORDER BY start_date DESC LIMIT 1",[a.core.organisation_id]);
        if(!year)throw fail(409,'Activate an academic year before reactivating this student');
        let targetClassId=b.classroomId??null;
        if(!targetClassId){
          const previous=await maybeOne<any>(client,`SELECT classroom_id FROM enrolments
            WHERE organisation_id=$1 AND student_id=$2 AND academic_year_id=$3
            ORDER BY enrolled_at DESC LIMIT 1`,[a.core.organisation_id,id,year.id]);
          targetClassId=previous?.classroom_id??null;
        }
        if(!targetClassId)throw fail(409,'Choose the class the student should return to');
        const cls=await one<any>(client,'SELECT * FROM classrooms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND is_active=true',
          [targetClassId,a.core.organisation_id,year.id]);
        enrolment=await one<any>(client,`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status)
          VALUES($1,$2,$3,$4,'active')
          ON CONFLICT(student_id,academic_year_id)
          DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status='active',enrolled_at=now()
          RETURNING *`,[a.core.organisation_id,id,year.id,cls.id]);
        await assignMandatoryFees(client,a.core.organisation_id,id,year.id,cls.id);
      }
      await client.query('UPDATE student_portal_access SET is_active=true,updated_at=now() WHERE student_id=$1',[id]);
    }else{
      const enrolmentStatus=b.status==='graduated'?'completed':b.status;
      if(enrolment){
        await client.query('UPDATE enrolments SET status=$1 WHERE id=$2',[enrolmentStatus,enrolment.id]);
      }
      await client.query('UPDATE student_portal_access SET is_active=false,updated_at=now() WHERE student_id=$1',[id]);
      await client.query('UPDATE student_portal_sessions SET revoked_at=now() WHERE student_id=$1 AND revoked_at IS NULL',[id]);
    }

    const updated=await one<any>(client,'UPDATE students SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[b.status,id]);
    await client.query(`INSERT INTO student_status_history(
      organisation_id,student_id,old_status,new_status,reason,enrolment_id,classroom_id,changed_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[
      a.core.organisation_id,id,student.status,b.status,b.reason??null,enrolment?.id??null,enrolment?.classroom_id??b.classroomId??null,a.core.id
    ]);
    return{student:updated,unchanged:false,enrolment};
  });
  await audit(a.core.organisation_id,a.core.id,'student.status_changed','student',id,{
    status:b.status,reason:b.reason??null,classroomId:b.classroomId??null
  });
  return result;
});
app.post('/api/students/:id/guardians',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({firstName:z.string().min(1).max(100),lastName:z.string().min(1).max(100),phone:z.string().min(5).max(60),email:z.string().email().optional(),address:z.string().max(2000).optional(),relationship:z.string().min(2).max(60),isPrimary:z.boolean().default(false)}).parse(request.body);
  const row=await tx(db,async c=>{const g=await one<any>(c,'INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.firstName,b.lastName,b.phone,b.email??null,b.address??null]);if(b.isPrimary)await c.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[id]);await c.query('INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary) VALUES($1,$2,$3,$4)',[id,g.id,b.relationship,b.isPrimary]);return g});await audit(a.core.organisation_id,a.core.id,'guardian.linked','student',id,{guardianId:row.id});return reply.code(201).send(row);
});
app.post('/api/enrolments',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.edit');
  const b=z.object({studentId:z.string().uuid(),academicYearId:z.string().uuid(),classroomId:z.string().uuid()}).parse(request.body);
  const result=await tx(db,async client=>{
    const row=await one<any>(client,`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(student_id,academic_year_id)
      DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status='active',enrolled_at=now()
      RETURNING *`,[a.core.organisation_id,b.studentId,b.academicYearId,b.classroomId]);
    const feesAssigned=await assignMandatoryFees(client,a.core.organisation_id,b.studentId,b.academicYearId,b.classroomId);
    return{row,feesAssigned};
  });
  await audit(a.core.organisation_id,a.core.id,'student.enrolled','enrolment',result.row.id,{feesAssigned:result.feesAssigned});
  return reply.code(201).send({...result.row,feesAssigned:result.feesAssigned});
});

app.get('/api/attendance',async request=>{
  const a=await authorize(request,db,config,'attendance.view');const q=z.object({classroomId:z.string().uuid(),date:z.string().date()}).parse(request.query);await ensureTeacherScope(a,q.classroomId,null,q.date);
  return (await db.query(`SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,COALESCE(ar.status,'unmarked') attendance_status,ar.note FROM enrolments e JOIN students s ON s.id=e.student_id LEFT JOIN attendance_records ar ON ar.student_id=s.id AND ar.classroom_id=e.classroom_id AND ar.attendance_date=$3 WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.status='active' ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,q.classroomId,q.date])).rows;
});
app.post('/api/attendance/mark',async request=>{
  const a=await authorize(request,db,config,'attendance.mark');const b=z.object({classroomId:z.string().uuid(),date:z.string().date(),records:z.array(z.object({studentId:z.string().uuid(),status:z.enum(['present','absent','late','excused']),note:z.string().max(500).optional()})).min(1).max(200)}).parse(request.body);await ensureTeacherScope(a,b.classroomId,null,b.date);
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
  const q=z.object({
    termId:z.string().uuid().optional(),classroomId:z.string().uuid().optional(),subjectId:z.string().uuid().optional(),
    categoryId:z.string().uuid().optional(),teacherOsUserId:z.string().uuid().optional()
  }).parse(request.query);
  let rows=(await db.query(`SELECT a.*,s.name subject_name,c.name classroom_name,t.name term_name,
      ac.name category_name,ac.code category_code,ac.weight_percent category_weight,ac.default_max_score,
      (SELECT count(*)::int FROM assessment_scores sc WHERE sc.assessment_id=a.id) scored_students,
      (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=a.classroom_id AND e.status='active') student_count
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
      AND ($6::uuid IS NULL OR a.teacher_os_user_id=$6)
    ORDER BY ac.sort_order NULLS LAST,a.assessment_date DESC NULLS LAST,a.created_at DESC`,
    [a.core.organisation_id,q.termId??null,q.classroomId??null,q.subjectId??null,q.categoryId??null,q.teacherOsUserId??null])).rows;
  if(a.role==='teacher'){
    rows=rows.filter((r:any)=>r.teacher_os_user_id===a.core.id);
  }
  return rows.map((r:any)=>{
    const total=Number(r.student_count||0),done=Number(r.scored_students||0);
    const progressPercent=total?Math.min(100,Math.round((done/total)*100)):0;
    const progressStatus=done===0?'pending':done<total?'in_progress':'complete';
    return{...r,progress_percent:progressPercent,progress_status:progressStatus,pending:progressStatus!=='complete'};
  });
});
app.post('/api/assessments',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.create');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),
    categoryId:z.string().uuid().optional(),assessmentType:z.enum(['classwork','homework','project','test','exam','other']).optional(),
    name:z.string().min(2).max(160),maxScore:z.number().positive().optional(),assessmentDate:z.string().date().optional(),
    teacherOsUserId:z.string().uuid().optional()
  }).parse(request.body);
  const teacherId=a.role==='teacher'?a.core.id:(b.teacherOsUserId??a.core.id);
  if(a.role==='teacher')await ensureTeacherScope(a,b.classroomId,b.subjectId);
  else await validateTeachingAssignment({
    organisationId:a.core.organisation_id,academicYearId:b.academicYearId,termId:b.termId,
    classroomId:b.classroomId,subjectId:b.subjectId,teacherOsUserId:teacherId
  });
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
  const cleanName=b.name.trim();
  const duplicate=await maybeOne<any>(db,`SELECT id FROM assessments
    WHERE organisation_id=$1 AND term_id=$2 AND classroom_id=$3 AND subject_id=$4 AND teacher_os_user_id=$5
      AND lower(trim(name))=lower($6) AND assessment_date IS NOT DISTINCT FROM $7::date LIMIT 1`,
    [a.core.organisation_id,b.termId,b.classroomId,b.subjectId,teacherId,cleanName,b.assessmentDate??null]);
  if(duplicate)throw fail(409,'This teacher already has an assessment with the same name and date for this class and subject');
  const row=await one<any>(db,`INSERT INTO assessments(
      organisation_id,academic_year_id,term_id,classroom_id,subject_id,category_id,name,assessment_type,max_score,weight,
      assessment_date,created_by_os_user_id,teacher_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,category.id,cleanName,type,maxScore,
      category.weight_percent,b.assessmentDate??null,a.core.id,teacherId]);
  await audit(a.core.organisation_id,a.core.id,'assessment.created','assessment',row.id,{categoryId:category.id,teacherOsUserId:teacherId});
  return reply.code(201).send(row);
});
app.get('/api/assessments/:id/scores',async request=>{
  const a=await authorize(request,db,config,'assessment.view');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const ass=await maybeOne<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);if(!ass)throw fail(404,'Assessment not found');await ensureTeacherScope(a,ass.classroom_id,ass.subject_id);if(a.role==='teacher'&&ass.teacher_os_user_id!==a.core.id)throw fail(403,'This assessment is assigned to another teacher');const rows=(await db.query(`SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,sc.score,sc.comment FROM enrolments e JOIN students s ON s.id=e.student_id LEFT JOIN assessment_scores sc ON sc.student_id=s.id AND sc.assessment_id=$1 WHERE e.classroom_id=$2 AND e.status='active' ORDER BY s.last_name,s.first_name`,[id,ass.classroom_id])).rows;return{assessment:ass,students:rows};
});
app.post('/api/assessments/:id/scores',async request=>{
  const a=await authorize(request,db,config,'assessment.score');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({scores:z.array(z.object({studentId:z.string().uuid(),score:z.number().min(0),comment:z.string().max(500).optional()})).min(1).max(200)}).parse(request.body);const ass=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await ensureTeacherScope(a,ass.classroom_id,ass.subject_id);if(a.role==='teacher'&&ass.teacher_os_user_id!==a.core.id)throw fail(403,'This assessment is assigned to another teacher');for(const s of b.scores)if(Number(s.score)>Number(ass.max_score))throw fail(400,`Score cannot exceed ${ass.max_score}`);await tx(db,async c=>{for(const s of b.scores)await c.query(`INSERT INTO assessment_scores(assessment_id,student_id,score,comment) VALUES($1,$2,$3,$4) ON CONFLICT(assessment_id,student_id) DO UPDATE SET score=EXCLUDED.score,comment=EXCLUDED.comment,updated_at=now()`,[id,s.studentId,s.score,s.comment??null])});await audit(a.core.organisation_id,a.core.id,'assessment.scores_saved','assessment',id,{count:b.scores.length});return{saved:b.scores.length};
});

async function buildAcademicStatement(organisationId:string,studentId:string){
  const school=await one<any>(db,'SELECT school_name,short_name,motto,phone,email,address FROM school_profiles WHERE organisation_id=$1',[organisationId]);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[studentId,organisationId]);
  const periods=(await db.query(`SELECT DISTINCT t.id term_id,t.name term_name,t.term_no,t.start_date,t.end_date,
      y.id academic_year_id,y.name academic_year,y.start_date academic_year_start,
      c.name classroom_name,g.name grade_name,g.code grade_code
    FROM enrolments e
    JOIN academic_years y ON y.id=e.academic_year_id
    JOIN terms t ON t.academic_year_id=y.id
    JOIN classrooms c ON c.id=e.classroom_id
    JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE e.organisation_id=$1 AND e.student_id=$2
    ORDER BY y.start_date,t.term_no`,[organisationId,studentId])).rows;
  const terms:any[]=[];
  for(const p of periods){
    const subjects=await calculateStudentTermResults(organisationId,studentId,p.term_id);
    const attendanceRows=(await db.query(`SELECT status,count(*)::int count FROM attendance_records
      WHERE organisation_id=$1 AND student_id=$2 AND attendance_date BETWEEN $3::date AND $4::date GROUP BY status`,
      [organisationId,studentId,p.start_date,p.end_date])).rows;
    const attendance:any={present:0,absent:0,late:0,excused:0,total:0};
    for(const r of attendanceRows){attendance[r.status]=Number(r.count);attendance.total+=Number(r.count)}
    const graded=subjects.filter((s:any)=>s.percentage!=null);
    const overallAverage=graded.length?Math.round((graded.reduce((sum:number,s:any)=>sum+Number(s.percentage),0)/graded.length)*100)/100:null;
    if(subjects.length||attendance.total){
      terms.push({...p,subjects,overallAverage,attendance});
    }
  }
  return{
    school,student,terms,
    summary:{
      academicYears:[...new Set(terms.map((x:any)=>x.academic_year))].length,
      terms:terms.length,
      latestClass:terms.length?terms[terms.length-1].classroom_name:null,
      latestGrade:terms.length?terms[terms.length-1].grade_name:null
    },
    generatedAt:new Date().toISOString()
  };
}

app.get('/api/academic-statements/:studentId',async request=>{
  const a=await authorize(request,db,config,'academic_statement.view');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  return buildAcademicStatement(a.core.organisation_id,studentId);
});
app.get('/api/academic-statement-requests',async request=>{
  const a=await authorize(request,db,config,'academic_statement.view');
  const q=z.object({status:z.enum(['requested','processing','approved','declined']).optional(),q:z.string().max(120).optional()}).parse(request.query);
  const like=q.q?'%'+q.q+'%':null;
  return (await db.query(`SELECT ar.*,s.admission_no,s.first_name,s.last_name,g.first_name guardian_first_name,g.last_name guardian_last_name
    FROM academic_statement_requests ar JOIN students s ON s.id=ar.student_id
    LEFT JOIN guardians g ON g.id=ar.guardian_id
    WHERE ar.organisation_id=$1 AND ($2::text IS NULL OR ar.status=$2)
      AND ($3::text IS NULL OR s.admission_no ILIKE $3 OR s.first_name ILIKE $3 OR s.last_name ILIKE $3 OR COALESCE(ar.statement_reference,'') ILIKE $3)
    ORDER BY ar.requested_at DESC`,[a.core.organisation_id,q.status??null,like])).rows;
});
app.post('/api/academic-statement-requests',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic_statement.issue');
  const b=z.object({studentId:z.string().uuid(),purpose:z.enum(['continuation','transfer','scholarship','personal','other']).default('continuation'),note:z.string().max(2000).optional()}).parse(request.body);
  await one<any>(db,'SELECT id FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
  const row=await one<any>(db,`INSERT INTO academic_statement_requests(
    organisation_id,student_id,requested_by_type,purpose,note,status
  ) VALUES($1,$2,'staff',$3,$4,'processing') RETURNING *`,[a.core.organisation_id,b.studentId,b.purpose,b.note??null]);
  await audit(a.core.organisation_id,a.core.id,'academic_statement.requested','academic_statement_request',row.id,{studentId:b.studentId,purpose:b.purpose});
  return reply.code(201).send(row);
});
app.patch('/api/academic-statement-requests/:id',async request=>{
  const a=await authorize(request,db,config,'academic_statement.issue');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({status:z.enum(['processing','approved','declined']),schoolNote:z.string().max(2000).nullable().optional()}).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM academic_statement_requests WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const reference=b.status==='approved'?(current.statement_reference||('RXAS-'+new Date().getUTCFullYear()+'-'+randomBytes(4).toString('hex').toUpperCase())):current.statement_reference;
  const row=await one<any>(db,`UPDATE academic_statement_requests SET status=$1,school_note=$2,
    statement_reference=$3,reviewed_by_os_user_id=$4,reviewed_at=now(),
    issued_at=CASE WHEN $1='approved' THEN COALESCE(issued_at,now()) ELSE issued_at END
    WHERE id=$5 RETURNING *`,[b.status,b.schoolNote??null,reference,a.core.id,id]);
  const student=await one<any>(db,'SELECT first_name,last_name FROM students WHERE id=$1',[row.student_id]);
  if(row.guardian_id){
    const guardian=await maybeOne<any>(db,'SELECT * FROM guardians WHERE id=$1',[row.guardian_id]);
    if(guardian){
      await notifyContact({
        organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:guardian.id,eventKey:'reports.approved',
        name:guardian.first_name+' '+guardian.last_name,email:guardian.email,phone:guardian.phone,
        subject:b.status==='approved'?'Cumulative academic statement ready':'Academic statement request updated',
        body:b.status==='approved'
          ?`The cumulative academic statement for ${student.first_name} ${student.last_name} is ready. Reference: ${reference}. Open the Parent Portal to view it.`
          :`The academic statement request for ${student.first_name} ${student.last_name} is now ${b.status}.`,
        relatedType:'academic_statement_request',relatedId:id
      });
    }
  }
  await audit(a.core.organisation_id,a.core.id,'academic_statement.'+b.status,'academic_statement_request',id,{reference});
  return row;
});

app.get('/api/parent/students/:id/academic-statement-requests',async request=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await ensureGuardianStudent(g.guardian_id,id);
  return (await db.query(`SELECT * FROM academic_statement_requests WHERE organisation_id=$1 AND student_id=$2 AND guardian_id=$3
    ORDER BY requested_at DESC`,[g.organisation_id,id,g.guardian_id])).rows;
});
app.post('/api/parent/students/:id/academic-statement-requests',async(request,reply)=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await ensureGuardianStudent(g.guardian_id,id);
  const b=z.object({purpose:z.enum(['continuation','transfer','scholarship','personal','other']).default('continuation'),note:z.string().max(2000).optional()}).parse(request.body);
  const existing=await maybeOne<any>(db,`SELECT id FROM academic_statement_requests WHERE organisation_id=$1 AND student_id=$2 AND guardian_id=$3 AND status IN('requested','processing')`,
    [g.organisation_id,id,g.guardian_id]);
  if(existing)throw fail(409,'There is already an academic statement request being processed for this student');
  const row=await one<any>(db,`INSERT INTO academic_statement_requests(
    organisation_id,student_id,guardian_id,requested_by_type,purpose,note
  ) VALUES($1,$2,$3,'guardian',$4,$5) RETURNING *`,[g.organisation_id,id,g.guardian_id,b.purpose,b.note??null]);
  return reply.code(201).send(row);
});
app.get('/api/parent/academic-statements/:requestId',async request=>{
  const g=await guardianAuth(request);const {requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,`SELECT * FROM academic_statement_requests WHERE id=$1 AND organisation_id=$2 AND guardian_id=$3 AND status='approved'`,
    [requestId,g.organisation_id,g.guardian_id]);
  const statement=await buildAcademicStatement(g.organisation_id,row.student_id);
  return{request:row,statement};
});
app.get('/api/student/academic-statement-requests',async request=>{
  const s=await studentAuth(request);
  return (await db.query('SELECT * FROM academic_statement_requests WHERE organisation_id=$1 AND student_id=$2 ORDER BY requested_at DESC',[s.organisation_id,s.student_id])).rows;
});
app.post('/api/student/academic-statement-requests',async(request,reply)=>{
  const s=await studentAuth(request);
  const b=z.object({purpose:z.enum(['continuation','transfer','scholarship','personal','other']).default('continuation'),note:z.string().max(2000).optional()}).parse(request.body);
  const existing=await maybeOne<any>(db,`SELECT id FROM academic_statement_requests WHERE organisation_id=$1 AND student_id=$2 AND requested_by_type='student' AND status IN('requested','processing')`,[s.organisation_id,s.student_id]);
  if(existing)throw fail(409,'There is already an academic statement request being processed');
  const row=await one<any>(db,`INSERT INTO academic_statement_requests(organisation_id,student_id,requested_by_type,purpose,note)
    VALUES($1,$2,'student',$3,$4) RETURNING *`,[s.organisation_id,s.student_id,b.purpose,b.note??null]);
  return reply.code(201).send(row);
});
app.get('/api/student/academic-statements/:requestId',async request=>{
  const s=await studentAuth(request);const {requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,`SELECT * FROM academic_statement_requests WHERE id=$1 AND organisation_id=$2 AND student_id=$3 AND status='approved'`,
    [requestId,s.organisation_id,s.student_id]);
  const statement=await buildAcademicStatement(s.organisation_id,s.student_id);
  return{request:row,statement};
});

app.get('/api/report-cards/:studentId',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const q=z.object({termId:z.string().uuid()}).parse(request.query);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[studentId,a.core.organisation_id]);
  const term=await one<any>(db,`SELECT t.*,y.name academic_year,y.start_date academic_year_start,y.end_date academic_year_end
    FROM terms t JOIN academic_years y ON y.id=t.academic_year_id
    WHERE t.id=$1 AND t.organisation_id=$2`,[q.termId,a.core.organisation_id]);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.name classroom_name,c.class_teacher_os_user_id,c.grade_level_id,
      g.name grade_name,g.code grade_code,g.level_order,e.academic_year_id,y.name academic_year
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id
    JOIN academic_years y ON y.id=e.academic_year_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2
    ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id]);
  const comments=await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,q.termId]);

  if(current?.classroom_id){
    const returnedToMe=comments?.workflow_status==='returned'&&comments?.submitted_by_os_user_id===a.core.id;
    if(!returnedToMe)await ensureTeacherScope(a,current.classroom_id,null);
    current.class_teacher_os_user_id=await effectiveClassTeacher(a.core.organisation_id,current.classroom_id,q.termId);
  }

  const subjects=await calculateStudentTermResults(a.core.organisation_id,studentId,q.termId);
  const readiness=await reportAssessmentReadiness(a.core.organisation_id,studentId,q.termId,current?.classroom_id??null);
  const promotion=await reportPromotionInfo(a.core.organisation_id,studentId,q.termId,current?.classroom_id??null,subjects);
  const coreUsers=await fetchCoreUsers(a.core.organisation_id);
  const userLabel=(id:string|null|undefined)=>{
    const u=id?coreUsers.find((x:any)=>x.id===id):null;
    return u?(u.first_name+' '+u.last_name).trim():'Not assigned';
  };
  const classTeacherName=userLabel(current?.class_teacher_os_user_id);

  let overallAverage=promotion.overallAverage;
  let classPosition:number|null=null,classSize:number|null=null;
  if(current?.classroom_id&&readiness.complete){
    const rank=await calculateClassRank(a.core.organisation_id,current.classroom_id,q.termId,studentId);
    if(rank){overallAverage=Number(rank.average);classPosition=rank.position;classSize=rank.class_size}
  }

  const attendanceRows=(await db.query(`SELECT status,count(*)::int count FROM attendance_records ar
    WHERE ar.organisation_id=$1 AND ar.student_id=$2 AND ar.attendance_date BETWEEN $3::date AND $4::date
    GROUP BY status`,[a.core.organisation_id,studentId,term.start_date,term.end_date])).rows;
  const attendance:any={present:0,absent:0,late:0,excused:0,total:0,rate:0};
  for(const row of attendanceRows){attendance[row.status]=Number(row.count);attendance.total+=Number(row.count)}
  attendance.rate=attendance.total?Math.round(((attendance.present+attendance.late)/attendance.total)*1000)/10:0;

  const school=await one<any>(db,`SELECT school_name,short_name,motto,phone,email,address,currency,logo_url,logo_image_data,
      promotion_threshold_percent FROM school_profiles WHERE organisation_id=$1`,[a.core.organisation_id]);
  const chosenDecision=comments?.promotion_decision??promotion.suggestedDecision??null;
  return{
    school,
    student:{...student,...(current||{})},
    term,
    termId:q.termId,
    subjects,
    performance:{overallAverage,classPosition,classSize},
    assessmentReadiness:readiness,
    promotion:{
      ...promotion,
      decision:chosenDecision,
      basis:comments?.promotion_basis??(chosenDecision?'threshold':null),
      releasedAt:comments?.released_at??null
    },
    attendance,
    comments,
    reportResponsibility:{
      classTeacherOsUserId:current?.class_teacher_os_user_id??null,
      classTeacherName,
      rule:'Subject teachers submit scores. The Class Teacher is alerted to missing scores, completes the report and submits it for approval. An approved report is released to families only from the Class Teacher report pool.'
    },
    generatedAt:new Date().toISOString()
  };
});

app.get('/api/fee-items',async request=>{const a=await authorize(request,db,config,'fees.view');const q=z.object({academicYearId:z.string().uuid().optional()}).parse(request.query);return (await db.query(`SELECT f.*,g.name grade_name,t.name term_name FROM fee_items f LEFT JOIN grade_levels g ON g.id=f.grade_level_id LEFT JOIN terms t ON t.id=f.term_id WHERE f.organisation_id=$1 AND ($2::uuid IS NULL OR f.academic_year_id=$2) ORDER BY f.created_at DESC`,[a.core.organisation_id,q.academicYearId??null])).rows});
app.post('/api/fee-items',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.create');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid().optional(),gradeLevelId:z.string().uuid().optional(),
    name:z.string().min(2).max(160),amount:z.number().min(0),mandatory:z.boolean().default(true),
    incomeAccountId:z.string().uuid().optional()
  }).parse(request.body);
  let incomeAccountId=b.incomeAccountId??null;
  if(incomeAccountId){
    await one<any>(db,"SELECT id FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='income' AND is_active=true",
      [incomeAccountId,a.core.organisation_id]);
  }else{
    const income=await maybeOne<any>(db,"SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code='4000' AND account_type='income' AND is_active=true",
      [a.core.organisation_id]);
    incomeAccountId=income?.id??null;
  }
  const row=await one<any>(db,`INSERT INTO fee_items(organisation_id,academic_year_id,term_id,grade_level_id,name,amount,mandatory,income_account_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [a.core.organisation_id,b.academicYearId,b.termId??null,b.gradeLevelId??null,b.name,b.amount,b.mandatory,incomeAccountId]);
  await audit(a.core.organisation_id,a.core.id,'fee_item.created','fee_item',row.id,{incomeAccountId});
  return reply.code(201).send(row);
});
app.post('/api/fees/assign',async request=>{
  const a=await authorize(request,db,config,'fees.create');
  const b=z.object({feeItemId:z.string().uuid(),studentId:z.string().uuid().optional(),classroomId:z.string().uuid().optional()})
    .refine(v=>v.studentId||v.classroomId,{message:'studentId or classroomId is required'}).parse(request.body);
  const result=await tx(db,async client=>{
    const fee=await one<any>(client,'SELECT * FROM fee_items WHERE id=$1 AND organisation_id=$2',[b.feeItemId,a.core.organisation_id]);
    let students:string[]=[];
    if(b.studentId)students=[b.studentId];
    else students=(await client.query("SELECT student_id FROM enrolments WHERE organisation_id=$1 AND classroom_id=$2 AND status='active'",
      [a.core.organisation_id,b.classroomId])).rows.map((x:any)=>x.student_id);
    let assigned=0;
    for(const sid of students){
      const inserted=(await client.query(`INSERT INTO student_fees(organisation_id,student_id,fee_item_id,amount_due)
        VALUES($1,$2,$3,$4) ON CONFLICT(student_id,fee_item_id) DO NOTHING RETURNING id`,
        [a.core.organisation_id,sid,fee.id,fee.amount])).rows[0];
      if(inserted){await postStudentFeeReceivable(client,inserted.id,a.core.id);assigned++}
    }
    return{assigned,feeId:fee.id};
  });
  await audit(a.core.organisation_id,a.core.id,'fees.assigned','fee_item',result.feeId,{count:result.assigned});
  return{assigned:result.assigned};
});
app.get('/api/fees/student/:studentId',async request=>{
  const a=await authorize(request,db,config,'fees.view');const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);const items=(await db.query(`SELECT sf.*,f.name fee_name,f.amount original_amount,COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) paid FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id WHERE sf.organisation_id=$1 AND sf.student_id=$2 ORDER BY sf.created_at DESC`,[a.core.organisation_id,studentId])).rows;const payments=(await db.query('SELECT * FROM payments WHERE organisation_id=$1 AND student_id=$2 ORDER BY paid_at DESC',[a.core.organisation_id,studentId])).rows;return{items,payments};
});
app.post('/api/payments',async(request,reply)=>{
  const a=await authorize(request,db,config,'fees.record');
  const b=z.object({
    studentId:z.string().uuid(),
    studentFeeId:z.string().uuid().optional(),
    amount:z.number().positive(),
    paymentMethod:z.enum(['cash','mobile_money','bank','card','other']),
    reference:z.string().max(120).optional(),
    note:z.string().max(500).optional(),
    incomeAccountId:z.string().uuid().optional()
  }).parse(request.body);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
  const row=await tx(db,async client=>{
    if(b.studentFeeId){
      const fee=await one<any>(client,`SELECT (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
        FROM student_fees sf WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3`,[b.studentFeeId,b.studentId,a.core.organisation_id]);
      if(b.amount>Number(fee.balance)+0.001)throw fail(400,'Payment cannot exceed the outstanding fee balance');
    }
    let incomeAccountId=b.incomeAccountId??null;
    if(!b.studentFeeId){
      if(incomeAccountId){
        await one<any>(client,"SELECT id FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='income' AND is_active=true",
          [incomeAccountId,a.core.organisation_id]);
      }else{
        const income=await one<any>(client,"SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code='4000' AND account_type='income' AND is_active=true",
          [a.core.organisation_id]);
        incomeAccountId=income.id;
      }
    }
    const p=await one<any>(client,`INSERT INTO payments(
      organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id,note,source,income_account_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'school_manual',$9) RETURNING *`,[
      a.core.organisation_id,b.studentId,b.studentFeeId??null,b.amount,b.paymentMethod,b.reference??null,a.core.id,b.note??null,incomeAccountId
    ]);
    if(b.studentFeeId)await updateStudentFeeStatus(client,b.studentFeeId);
    await postStudentPaymentLedger(client,p.id,a.core.id);
    return p;
  });
  const guardian=await maybeOne<any>(db,`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id
    WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC LIMIT 1`,[b.studentId]);
  if(guardian){
    const school=await one<any>(db,'SELECT school_name,currency FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
    await notifyContact({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:guardian.id,eventKey:'fees.payment_received',
      name:guardian.first_name+' '+guardian.last_name,email:guardian.email,phone:guardian.phone,
      subject:'School fee payment received',
      body:`${school.school_name} has recorded a payment of ${school.currency||'GHS'} ${Number(b.amount).toFixed(2)} for ${student.first_name} ${student.last_name}. Method: ${b.paymentMethod.replace('_',' ')}.${b.reference?' Reference: '+b.reference+'.':''}`,
      relatedType:'payment',relatedId:row.id
    });
  }
  await audit(a.core.organisation_id,a.core.id,'payment.recorded','payment',row.id,{amount:b.amount,method:b.paymentMethod});
  return reply.code(201).send(row);
});

function timeMinutes(value:any){
  const parts=String(value||'00:00').slice(0,5).split(':').map(Number);
  return (parts[0]||0)*60+(parts[1]||0);
}
function minuteTime(value:number){
  const h=Math.floor(value/60),m=value%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
function overlapsTime(aStart:number,aEnd:number,bStart:number,bEnd:number){
  return aStart<bEnd&&aEnd>bStart;
}
async function buildAutoTimetablePlan(organisationId:string,academicYearId:string,termId:string|null){
  const settings=await maybeOne<any>(db,`SELECT * FROM timetable_settings
    WHERE organisation_id=$1 AND academic_year_id=$2 AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)
    ORDER BY term_id NULLS LAST LIMIT 1`,[organisationId,academicYearId,termId]);
  const dayStart=timeMinutes(settings?.school_day_start||'07:30');
  const dayEnd=timeMinutes(settings?.school_day_end||'15:30');
  const period=Math.max(15,Number(settings?.default_period_minutes||40));
  const maxTeacherPeriods=Math.max(1,Number(settings?.max_teacher_periods_per_day||8));
  const breaks=(await db.query(`SELECT * FROM timetable_breaks
    WHERE organisation_id=$1 AND academic_year_id=$2 AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)`,
    [organisationId,academicYearId,termId])).rows;

  const requirements=(await db.query(`SELECT cs.id class_subject_id,cs.classroom_id,cs.subject_id,cs.weekly_periods,
      c.name classroom_name,c.class_teacher_os_user_id,s.name subject_name,
      COALESCE((
        SELECT ta.teacher_os_user_id FROM teacher_assignments ta
        WHERE ta.organisation_id=cs.organisation_id AND ta.academic_year_id=cs.academic_year_id
          AND ta.classroom_id=cs.classroom_id AND ta.subject_id=cs.subject_id AND ta.is_active=true
          AND (ta.term_id IS NOT DISTINCT FROM $3::uuid OR ta.term_id IS NULL)
        ORDER BY CASE WHEN ta.term_id IS NOT NULL THEN 0 ELSE 1 END,ta.created_at DESC LIMIT 1
      ),c.class_teacher_os_user_id) teacher_os_user_id,
      (SELECT count(*)::int FROM timetable_entries tt
        WHERE tt.organisation_id=cs.organisation_id AND tt.academic_year_id=cs.academic_year_id
          AND tt.classroom_id=cs.classroom_id AND tt.subject_id=cs.subject_id
          AND ($3::uuid IS NULL OR tt.term_id=$3 OR tt.term_id IS NULL)) existing_periods
    FROM class_subjects cs JOIN classrooms c ON c.id=cs.classroom_id JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.organisation_id=$1 AND cs.academic_year_id=$2 AND cs.is_active=true AND c.is_active=true
    ORDER BY c.name,s.name`,[organisationId,academicYearId,termId])).rows;

  const existing=(await db.query(`SELECT id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time
    FROM timetable_entries WHERE organisation_id=$1 AND academic_year_id=$2
      AND ($3::uuid IS NULL OR term_id=$3 OR term_id IS NULL)`,[organisationId,academicYearId,termId])).rows.map((r:any)=>({
        ...r,startMin:timeMinutes(r.start_time),endMin:timeMinutes(r.end_time)
      }));
  const proposed:any[]=[];
  const unscheduled:any[]=[];
  const dailyTeacherCount=new Map<string,number>();
  for(const r of existing){
    if(r.teacher_os_user_id){
      const key=r.teacher_os_user_id+'|'+r.day_of_week;
      dailyTeacherCount.set(key,(dailyTeacherCount.get(key)||0)+1);
    }
  }
  function slotBlocked(day:number,start:number,end:number,classroomId:string,teacherId:string|null){
    if(breaks.some((b:any)=>(b.day_of_week==null||Number(b.day_of_week)===day)&&overlapsTime(start,end,timeMinutes(b.start_time),timeMinutes(b.end_time))))return true;
    const all=[...existing,...proposed];
    return all.some((r:any)=>Number(r.day_of_week)===day&&overlapsTime(start,end,Number(r.startMin??timeMinutes(r.start_time)),Number(r.endMin??timeMinutes(r.end_time)))&&(r.classroom_id===classroomId||(teacherId&&r.teacher_os_user_id===teacherId)));
  }
  for(const req of requirements){
    const target=Math.max(1,Number(req.weekly_periods||3));
    let remaining=Math.max(0,target-Number(req.existing_periods||0));
    if(!remaining)continue;
    if(!req.teacher_os_user_id){
      unscheduled.push({classroomId:req.classroom_id,subjectId:req.subject_id,classroomName:req.classroom_name,subjectName:req.subject_name,remaining,reason:'No subject teacher or class teacher is assigned'});
      continue;
    }
    let cursor=(requirements.indexOf(req)%5)+1;
    while(remaining>0){
      let placed=false;
      for(let offset=0;offset<5&&!placed;offset++){
        const day=((cursor-1+offset)%5)+1;
        const loadKey=req.teacher_os_user_id+'|'+day;
        if((dailyTeacherCount.get(loadKey)||0)>=maxTeacherPeriods)continue;
        for(let start=dayStart;start+period<=dayEnd;start+=period){
          const end=start+period;
          if(slotBlocked(day,start,end,req.classroom_id,req.teacher_os_user_id))continue;
          proposed.push({
            classroom_id:req.classroom_id,subject_id:req.subject_id,teacher_os_user_id:req.teacher_os_user_id,
            day_of_week:day,start_time:minuteTime(start),end_time:minuteTime(end),startMin:start,endMin:end,
            classroom_name:req.classroom_name,subject_name:req.subject_name
          });
          dailyTeacherCount.set(loadKey,(dailyTeacherCount.get(loadKey)||0)+1);
          remaining--;cursor=day%5+1;placed=true;break;
        }
      }
      if(!placed){
        unscheduled.push({classroomId:req.classroom_id,subjectId:req.subject_id,classroomName:req.classroom_name,subjectName:req.subject_name,remaining,reason:'No conflict-free slot is available within the scheduling rules'});
        break;
      }
    }
  }
  return{settings:{schoolDayStart:minuteTime(dayStart),schoolDayEnd:minuteTime(dayEnd),periodMinutes:period,maxTeacherPeriodsPerDay:maxTeacherPeriods},suggestions:proposed,unscheduled};
}
app.post('/api/timetable/auto-schedule/preview',async request=>{
  const a=await authorize(request,db,config,'timetable.manage');
  const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().nullable().optional()}).parse(request.body);
  return buildAutoTimetablePlan(a.core.organisation_id,b.academicYearId,b.termId??null);
});
app.post('/api/timetable/auto-schedule/apply',async request=>{
  const a=await authorize(request,db,config,'timetable.manage');
  const b=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().nullable().optional()}).parse(request.body);
  const plan=await buildAutoTimetablePlan(a.core.organisation_id,b.academicYearId,b.termId??null);
  if(!plan.suggestions.length)return{created:0,unscheduled:plan.unscheduled};
  await tx(db,async client=>{
    for(const s of plan.suggestions){
      await client.query(`INSERT INTO timetable_entries(
        organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,room
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)`,[
        a.core.organisation_id,b.academicYearId,b.termId??null,s.classroom_id,s.subject_id,s.teacher_os_user_id,s.day_of_week,s.start_time,s.end_time
      ]);
    }
  });
  await audit(a.core.organisation_id,a.core.id,'timetable.auto_scheduled','timetable',null,{created:plan.suggestions.length,unscheduled:plan.unscheduled.length});
  return{created:plan.suggestions.length,unscheduled:plan.unscheduled};
});

app.get('/api/timetable',async request=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional(),academicYearId:z.string().uuid().optional(),teacherOsUserId:z.string().uuid().optional()}).parse(request.query);
  const rows=(await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name,t.name term_name,y.name academic_year
    FROM timetable_entries tt JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    JOIN academic_years y ON y.id=tt.academic_year_id LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1 AND ($2::uuid IS NULL OR tt.classroom_id=$2)
      AND ($3::uuid IS NULL OR tt.term_id=$3) AND ($4::uuid IS NULL OR tt.academic_year_id=$4)
      AND ($5::uuid IS NULL OR tt.teacher_os_user_id=$5)
    ORDER BY tt.day_of_week,tt.start_time,c.name`,[a.core.organisation_id,q.classroomId??null,q.termId??null,q.academicYearId??null,q.teacherOsUserId??null])).rows;
  const users=await fetchCoreUsers(a.core.organisation_id);
  const names=new Map(users.map((u:any)=>[u.id,(u.first_name+' '+u.last_name).trim()]));
  return rows.map((r:any)=>({...r,teacher_name:names.get(r.teacher_os_user_id)||'Unassigned'}));
});
app.get('/api/timetable/export.csv',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional(),academicYearId:z.string().uuid().optional(),teacherOsUserId:z.string().uuid().optional()}).parse(request.query);
  const rows=(await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name,t.name term_name,y.name academic_year
    FROM timetable_entries tt JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    JOIN academic_years y ON y.id=tt.academic_year_id LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1 AND ($2::uuid IS NULL OR tt.classroom_id=$2)
      AND ($3::uuid IS NULL OR tt.term_id=$3) AND ($4::uuid IS NULL OR tt.academic_year_id=$4)
      AND ($5::uuid IS NULL OR tt.teacher_os_user_id=$5)
    ORDER BY c.name,tt.day_of_week,tt.start_time`,[a.core.organisation_id,q.classroomId??null,q.termId??null,q.academicYearId??null,q.teacherOsUserId??null])).rows;
  const users=await fetchCoreUsers(a.core.organisation_id);
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
  const rules=await maybeOne<any>(db,`SELECT * FROM timetable_settings WHERE organisation_id=$1 AND academic_year_id=$2
    AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL) ORDER BY term_id NULLS LAST LIMIT 1`,
    [a.core.organisation_id,b.academicYearId,b.termId??null]);
  if(rules){
    const dayStart=String(rules.school_day_start).slice(0,5),dayEnd=String(rules.school_day_end).slice(0,5);
    if(b.startTime<dayStart||b.endTime>dayEnd)throw fail(400,`Period must fall within the configured school day (${dayStart} - ${dayEnd})`);
  }
  const scheduledBreak=await maybeOne<any>(db,`SELECT label,start_time,end_time FROM timetable_breaks
    WHERE organisation_id=$1 AND academic_year_id=$2 AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)
      AND (day_of_week IS NULL OR day_of_week=$4) AND start_time<$6::time AND end_time>$5::time LIMIT 1`,
    [a.core.organisation_id,b.academicYearId,b.termId??null,b.dayOfWeek,b.startTime,b.endTime]);
  if(scheduledBreak)throw fail(409,`This period overlaps the scheduled ${scheduledBreak.label}`);
  if(b.teacherOsUserId){
    const unavailable=await maybeOne<any>(db,`SELECT reason FROM timetable_teacher_unavailability
      WHERE organisation_id=$1 AND academic_year_id=$2 AND teacher_os_user_id=$3
        AND (term_id IS NOT DISTINCT FROM $4::uuid OR term_id IS NULL) AND day_of_week=$5
        AND start_time<$7::time AND end_time>$6::time LIMIT 1`,
      [a.core.organisation_id,b.academicYearId,b.teacherOsUserId,b.termId??null,b.dayOfWeek,b.startTime,b.endTime]);
    if(unavailable)throw fail(409,'The selected teacher is unavailable during this period'+(unavailable.reason?': '+unavailable.reason:''));
  }
  const conflict=await maybeOne<any>(db,`SELECT tt.id,c.name classroom_name,s.name subject_name FROM timetable_entries tt
    JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    WHERE tt.organisation_id=$1 AND tt.academic_year_id=$2 AND tt.day_of_week=$3
      AND tt.start_time<$5::time AND tt.end_time>$4::time
      AND (
        tt.classroom_id=$6 OR
        ($7::uuid IS NOT NULL AND tt.teacher_os_user_id=$7) OR
        ($9::text IS NOT NULL AND NULLIF(trim($9),'') IS NOT NULL AND lower(trim(tt.room))=lower(trim($9)))
      )
      AND (tt.term_id IS NOT DISTINCT FROM $8::uuid OR tt.term_id IS NULL OR $8::uuid IS NULL)
    LIMIT 1`,[a.core.organisation_id,b.academicYearId,b.dayOfWeek,b.startTime,b.endTime,b.classroomId,b.teacherOsUserId??null,b.termId??null,b.room??null]);
  if(conflict)throw fail(409,`Timetable conflict with ${conflict.classroom_name} - ${conflict.subject_name}`);
  const row=await one<any>(db,`INSERT INTO timetable_entries(
    organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,room
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[
    a.core.organisation_id,b.academicYearId,b.termId??null,b.classroomId,b.subjectId,b.teacherOsUserId??null,b.dayOfWeek,b.startTime,b.endTime,b.room??null
  ]);
  await audit(a.core.organisation_id,a.core.id,'timetable.created','timetable_entry',row.id);
  return reply.code(201).send(row);
});

app.post('/api/timetable/auto-schedule',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.auto_schedule');
  const b=z.object({
    academicYearId:z.string().uuid(),
    termId:z.string().uuid().nullable().optional(),
    teacherOsUserId:z.string().uuid().nullable().optional(),
    classroomId:z.string().uuid().nullable().optional(),
    regenerateAuto:z.boolean().default(true),
    dryRun:z.boolean().default(false)
  }).parse(request.body);

  const settings=(await maybeOne<any>(db,`SELECT * FROM timetable_settings
    WHERE organisation_id=$1 AND academic_year_id=$2
      AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)
    ORDER BY term_id NULLS LAST LIMIT 1`,
    [a.core.organisation_id,b.academicYearId,b.termId??null]))??{
      school_day_start:'07:30:00',school_day_end:'15:30:00',default_period_minutes:40,max_teacher_periods_per_day:8
    };

  const periodMinutes=Number(settings.default_period_minutes||40);
  const maxTeacherPeriods=Number(settings.max_teacher_periods_per_day||8);
  const toMinutes=(v:any)=>{const [hours=0,minutes=0]=String(v).slice(0,5).split(':').map(Number);return hours*60+minutes};
  const toTime=(m:number)=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  const schoolStart=toMinutes(settings.school_day_start),schoolEnd=toMinutes(settings.school_day_end);

  const breaks=(await db.query(`SELECT * FROM timetable_breaks
    WHERE organisation_id=$1 AND academic_year_id=$2
      AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)
    ORDER BY start_time`,[a.core.organisation_id,b.academicYearId,b.termId??null])).rows;
  const teacherUnavailability=(await db.query(`SELECT * FROM timetable_teacher_unavailability
    WHERE organisation_id=$1 AND academic_year_id=$2
      AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)`,
    [a.core.organisation_id,b.academicYearId,b.termId??null])).rows;

  const requirements=(await db.query(`
    SELECT cs.id class_subject_id,cs.classroom_id,c.name classroom_name,cs.subject_id,s.name subject_name,
           cs.weekly_periods,cs.credit_hours,ta.teacher_os_user_id
    FROM class_subjects cs
    JOIN classrooms c ON c.id=cs.classroom_id AND c.is_active=true
    JOIN subjects s ON s.id=cs.subject_id AND s.is_active=true
    LEFT JOIN LATERAL (
      SELECT x.teacher_os_user_id
      FROM teacher_assignments x
      WHERE x.organisation_id=cs.organisation_id
        AND x.academic_year_id=cs.academic_year_id
        AND x.classroom_id=cs.classroom_id
        AND x.subject_id=cs.subject_id
        AND x.is_active=true
        AND (x.term_id IS NOT DISTINCT FROM $3::uuid OR x.term_id IS NULL)
      ORDER BY CASE WHEN x.term_id IS NOT DISTINCT FROM $3::uuid THEN 0 ELSE 1 END,x.created_at DESC
      LIMIT 1
    ) ta ON true
    WHERE cs.organisation_id=$1 AND cs.academic_year_id=$2 AND cs.is_active=true
      AND ($4::uuid IS NULL OR ta.teacher_os_user_id=$4)
      AND ($5::uuid IS NULL OR cs.classroom_id=$5)
    ORDER BY c.name,s.name`,[a.core.organisation_id,b.academicYearId,b.termId??null,b.teacherOsUserId??null,b.classroomId??null])).rows;

  if(b.regenerateAuto&&!b.dryRun){
    await db.query(`DELETE FROM timetable_entries
      WHERE organisation_id=$1 AND academic_year_id=$2
        AND ($3::uuid IS NULL OR term_id IS NOT DISTINCT FROM $3::uuid)
        AND schedule_source='auto' AND is_locked=false
        AND ($4::uuid IS NULL OR teacher_os_user_id=$4)
        AND ($5::uuid IS NULL OR classroom_id=$5)`,
      [a.core.organisation_id,b.academicYearId,b.termId??null,b.teacherOsUserId??null,b.classroomId??null]);
  }

  const existing=(await db.query(`SELECT * FROM timetable_entries
    WHERE organisation_id=$1 AND academic_year_id=$2
      AND ($3::uuid IS NULL OR term_id IS NOT DISTINCT FROM $3::uuid)
    ORDER BY day_of_week,start_time`,
    [a.core.organisation_id,b.academicYearId,b.termId??null])).rows;

  const slots:any[]=[];
  for(let day=1;day<=5;day++){
    let start=schoolStart;
    while(start+periodMinutes<=schoolEnd){
      const end=start+periodMinutes;
      const blocked=breaks
        .filter((br:any)=>br.day_of_week==null||Number(br.day_of_week)===day)
        .map((br:any)=>({start:toMinutes(br.start_time),end:toMinutes(br.end_time)}))
        .find((br:any)=>start<br.end&&end>br.start);
      if(blocked){
        start=Math.max(start+1,blocked.end);
        continue;
      }
      slots.push({day,start,end});
      start=end;
    }
  }

  const occupancy=existing.map((x:any)=>({
    classroomId:x.classroom_id,teacherId:x.teacher_os_user_id,subjectId:x.subject_id,
    day:Number(x.day_of_week),start:toMinutes(x.start_time),end:toMinutes(x.end_time)
  }));
  const overlaps=(x:any,y:any)=>x.day===y.day&&x.start<y.end&&x.end>y.start;
  const teacherLoad=new Map<string,number>();
  const subjectDayCount=new Map<string,number>();
  const classDayLoad=new Map<string,number>();

  for(const x of occupancy){
    if(x.teacherId)teacherLoad.set(x.teacherId+'|'+x.day,(teacherLoad.get(x.teacherId+'|'+x.day)||0)+1);
    subjectDayCount.set(x.classroomId+'|'+x.subjectId+'|'+x.day,(subjectDayCount.get(x.classroomId+'|'+x.subjectId+'|'+x.day)||0)+1);
    classDayLoad.set(x.classroomId+'|'+x.day,(classDayLoad.get(x.classroomId+'|'+x.day)||0)+1);
  }

  const created:any[]=[];
  const unscheduled:any[]=[];
  for(const req of requirements){
    if(!req.teacher_os_user_id){
      unscheduled.push({classroomId:req.classroom_id,classroomName:req.classroom_name,subjectId:req.subject_id,subjectName:req.subject_name,reason:'No subject teacher assigned'});
      continue;
    }

    const required=Math.max(Number(req.weekly_periods||1),Math.ceil((Number(req.credit_hours||0)*60)/periodMinutes));
    const already=existing.filter((x:any)=>x.classroom_id===req.classroom_id&&x.subject_id===req.subject_id&&x.teacher_os_user_id===req.teacher_os_user_id).length;
    let remaining=Math.max(0,required-already);

    while(remaining>0){
      const candidates=slots.filter(slot=>{
        const probe={...slot,classroomId:req.classroom_id,teacherId:req.teacher_os_user_id,subjectId:req.subject_id};
        if((teacherLoad.get(req.teacher_os_user_id+'|'+slot.day)||0)>=maxTeacherPeriods)return false;
        const unavailable=teacherUnavailability.some((u:any)=>u.teacher_os_user_id===req.teacher_os_user_id&&Number(u.day_of_week)===slot.day&&slot.start<toMinutes(u.end_time)&&slot.end>toMinutes(u.start_time));
        if(unavailable)return false;
        return !occupancy.some((o:any)=>overlaps(probe,o)&&(o.classroomId===req.classroom_id||o.teacherId===req.teacher_os_user_id));
      }).sort((x,y)=>{
        const sx=(subjectDayCount.get(req.classroom_id+'|'+req.subject_id+'|'+x.day)||0)*100+
          (teacherLoad.get(req.teacher_os_user_id+'|'+x.day)||0)*10+
          (classDayLoad.get(req.classroom_id+'|'+x.day)||0);
        const sy=(subjectDayCount.get(req.classroom_id+'|'+req.subject_id+'|'+y.day)||0)*100+
          (teacherLoad.get(req.teacher_os_user_id+'|'+y.day)||0)*10+
          (classDayLoad.get(req.classroom_id+'|'+y.day)||0);
        return sx-sy||x.day-y.day||x.start-y.start;
      });

      const chosen=candidates[0];
      if(!chosen){
        unscheduled.push({
          classroomId:req.classroom_id,classroomName:req.classroom_name,subjectId:req.subject_id,subjectName:req.subject_name,
          teacherOsUserId:req.teacher_os_user_id,remainingPeriods:remaining,
          reason:'No conflict-free period remains within the configured school day and teacher workload'
        });
        break;
      }

      const proposal={
        organisation_id:a.core.organisation_id,academic_year_id:b.academicYearId,term_id:b.termId??null,
        classroom_id:req.classroom_id,classroom_name:req.classroom_name,subject_id:req.subject_id,subject_name:req.subject_name,
        teacher_os_user_id:req.teacher_os_user_id,day_of_week:chosen.day,start_time:toTime(chosen.start),end_time:toTime(chosen.end),
        room:null,schedule_source:'auto',is_locked:false
      };
      const row=b.dryRun?proposal:await one<any>(db,`INSERT INTO timetable_entries(
        organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,room,schedule_source,is_locked
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,'auto',false) RETURNING *`,[
        a.core.organisation_id,b.academicYearId,b.termId??null,req.classroom_id,req.subject_id,req.teacher_os_user_id,
        chosen.day,toTime(chosen.start),toTime(chosen.end)
      ]);
      created.push({...proposal,...row});
      const occ={classroomId:req.classroom_id,teacherId:req.teacher_os_user_id,subjectId:req.subject_id,day:chosen.day,start:chosen.start,end:chosen.end};
      occupancy.push(occ);
      teacherLoad.set(req.teacher_os_user_id+'|'+chosen.day,(teacherLoad.get(req.teacher_os_user_id+'|'+chosen.day)||0)+1);
      subjectDayCount.set(req.classroom_id+'|'+req.subject_id+'|'+chosen.day,(subjectDayCount.get(req.classroom_id+'|'+req.subject_id+'|'+chosen.day)||0)+1);
      classDayLoad.set(req.classroom_id+'|'+chosen.day,(classDayLoad.get(req.classroom_id+'|'+chosen.day)||0)+1);
      remaining--;
    }
  }

  if(!b.dryRun){
    await audit(a.core.organisation_id,a.core.id,'timetable.auto_scheduled','timetable',null,{
      academicYearId:b.academicYearId,termId:b.termId??null,teacherOsUserId:b.teacherOsUserId??null,classroomId:b.classroomId??null,created:created.length,unscheduled:unscheduled.length
    });
    await changeLog({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'timetable.auto_scheduled',
      resourceType:'timetable',performedOn:'Academic year '+b.academicYearId,
      oldValue:{existingPeriods:existing.length},newValue:{createdPeriods:created.length,unscheduled},
      metadata:{termId:b.termId??null,teacherOsUserId:b.teacherOsUserId??null,classroomId:b.classroomId??null,periodMinutes}
    });
  }
  return reply.code(b.dryRun?200:201).send({
    created:created.length,suggestions:created,unscheduled,periodMinutes,schoolDayStart:toTime(schoolStart),schoolDayEnd:toTime(schoolEnd),
    preservedManual:existing.filter((x:any)=>x.schedule_source!=='auto'||x.is_locked).length,dryRun:b.dryRun
  });
});

app.get('/api/staff/core-users',async request=>{
  const a=await authorize(request,db,config,'staff.view');
  if(!config.CORE_SERVICE_KEY)throw fail(503,'Core service authentication is not configured');
  return fetchCoreUsers(a.core.organisation_id);
});

app.post('/api/staff/users',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.create');
  if(!config.CORE_SERVICE_KEY)throw fail(503,'Core service authentication is not configured');
  const b=z.object({
    firstName:z.string().trim().min(1).max(100),
    lastName:z.string().trim().min(1).max(100),
    email:z.string().trim().toLowerCase().email().optional(),
    jobTitle:z.string().trim().max(160).optional(),
    schoolRole:z.string().min(1).max(40)
  }).parse(request.body);

  const role=await one<any>(db,'SELECT * FROM school_roles WHERE organisation_id=$1 AND key=$2 AND is_active=true',
    [a.core.organisation_id,b.schoolRole]);

  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const created=await fetch(base+'/v1/internal/school/users',{
    method:'POST',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({
      organisationId:a.core.organisation_id,
      actorUserId:a.core.id,
      firstName:b.firstName,
      lastName:b.lastName,
      ...(b.email?{email:b.email}:{}),
      jobTitle:b.jobTitle||role.name,
      roleKey:'member'
    }),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!created)throw fail(503,'Core OS could not be reached');
  const payload=await created.json().catch(()=>null) as any;
  if(!created.ok)throw fail(created.status,payload?.error?.message||'Could not create user in Core OS');

  const activated=await fetch(base+'/v1/internal/school/users/'+payload.id+'/status',{
    method:'PATCH',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id,status:'active'}),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!activated?.ok)throw fail(activated?.status||503,'User was created but Core membership could not be activated');

  const schoolMembership=await one<any>(db,`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
    VALUES($1,$2,$3,'active')
    ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role=EXCLUDED.role,status='active',updated_at=now()
    RETURNING *`,[a.core.organisation_id,payload.user_id,b.schoolRole]);

  let invitation:any={status:b.email?'not_started':'email_not_set'};
  if(b.email){
    const setupRes=await fetch(base+'/v1/internal/school/users/'+payload.id+'/password-setup',{
      method:'POST',
      headers:{...coreServiceHeaders(),'content-type':'application/json'},
      body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id}),
      signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    if(setupRes?.ok){
      const setup=await setupRes.json().catch(()=>null) as any;
      const publicBase=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
      const next=role.portal_mode==='teacher'?'/teacher':'/';
      const setupUrl=publicBase+'/login?next='+encodeURIComponent(next)+'&setup='+encodeURIComponent(setup.setupToken);
      const delivered=await deliverCommunication({
        organisationId:a.core.organisation_id,actorOsUserId:a.core.id,channel:'email',
        recipientName:b.firstName+' '+b.lastName,recipientAddress:b.email,
        subject:'Set up your Revolt-X School account',
        body:`Hello ${b.firstName},

Your Revolt-X School account has been created with the role ${role.name}.

Use this secure link to create your password:
${setupUrl}

The link expires in 24 hours.`,
        templateKey:'staff.invitation',relatedType:'school_membership',relatedId:schoolMembership.id
      });
      invitation={status:delivered.status,expiresInHours:setup.expiresInHours,error:delivered.last_error??null};
    }else{
      const x=await setupRes?.json().catch(()=>null) as any;
      invitation={status:'failed',error:x?.error?.message||'Could not create password setup invitation'};
    }
  }

  coreUsersCache.delete(a.core.organisation_id);
  await audit(a.core.organisation_id,a.core.id,'school_user.created','school_membership',schoolMembership.id,{
    osUserId:payload.user_id,schoolRole:b.schoolRole,emailConfigured:Boolean(b.email)
  });
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'school_user.created',
    resourceType:'school_user',resourceId:payload.user_id,performedOn:b.firstName+' '+b.lastName,
    oldValue:null,newValue:{schoolRole:b.schoolRole,roleName:role.name,jobTitle:b.jobTitle||role.name,employeeNumber:payload.employee_number??null,emailConfigured:Boolean(b.email),status:'active'}
  });
  return reply.code(201).send({
    osUserId:payload.user_id,membershipId:schoolMembership.id,firstName:b.firstName,lastName:b.lastName,
    email:b.email??null,jobTitle:b.jobTitle||role.name,schoolRole:b.schoolRole,roleName:role.name,invitation
  });
});

app.post('/api/staff/teachers',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.create');
  if(!config.CORE_SERVICE_KEY)throw fail(503,'Core service authentication is not configured');
  const b=z.object({
    email:z.string().email(),
    firstName:z.string().min(1).max(100),
    lastName:z.string().min(1).max(100),
    jobTitle:z.string().min(2).max(160).default('Teacher'),
    employeeNumber:z.string().max(80).optional()
  }).parse(request.body);
  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const created=await fetch(base+'/v1/internal/school/users',{
    method:'POST',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({
      organisationId:a.core.organisation_id,
      actorUserId:a.core.id,
      ...b,
      roleKey:'member'
    }),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!created)throw fail(503,'Core OS could not be reached');
  const payload=await created.json().catch(()=>null) as any;
  if(!created.ok)throw fail(created.status,payload?.error?.message||'Could not create teacher in Core OS');

  const activated=await fetch(base+'/v1/internal/school/users/'+payload.id+'/status',{
    method:'PATCH',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id,status:'active'}),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!activated?.ok)throw fail(activated?.status||503,'Teacher was created but Core membership could not be activated');

  const schoolMembership=await one<any>(db,`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
    VALUES($1,$2,'teacher','active')
    ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role='teacher',status='active',updated_at=now()
    RETURNING *`,[a.core.organisation_id,payload.user_id]);

  let invitation:any={status:'not_created'};
  const setupRes=await fetch(base+'/v1/internal/school/users/'+payload.id+'/password-setup',{
    method:'POST',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id}),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(setupRes?.ok){
    const setup=await setupRes.json().catch(()=>null) as any;
    const publicBase=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
    const setupUrl=publicBase+'/login?next='+encodeURIComponent('/teacher')+'&setup='+encodeURIComponent(setup.setupToken);
    const delivered=await deliverCommunication({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,channel:'email',
      recipientName:b.firstName+' '+b.lastName,recipientAddress:b.email,
      subject:'Set up your Revolt-X Teacher account',
      body:`Hello ${b.firstName},

Your teacher account has been created in Revolt-X School.

Use this secure link to create your password:
${setupUrl}

The link expires in 24 hours. After setting your password, sign in through Revolt-X School using ${b.email}.

If you did not expect this invitation, contact your school administrator.`,
      templateKey:'teacher.invitation',relatedType:'school_membership',relatedId:schoolMembership.id
    });
    invitation={
      status:delivered.status,
      expiresInHours:setup.expiresInHours,
      error:delivered.last_error??null
    };
  }else{
    const x=await setupRes?.json().catch(()=>null) as any;
    invitation={status:'failed',error:x?.error?.message||'Could not create password setup invitation'};
  }

  coreUsersCache.delete(a.core.organisation_id);
  await audit(a.core.organisation_id,a.core.id,'teacher.created','school_membership',schoolMembership.id,{email:b.email,osUserId:payload.user_id,invitationStatus:invitation.status});
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'teacher.created',
    resourceType:'teacher',resourceId:payload.user_id,performedOn:b.firstName+' '+b.lastName,
    oldValue:null,newValue:{email:b.email,jobTitle:b.jobTitle,employeeNumber:b.employeeNumber??null,schoolRole:'teacher',status:'active'},
    metadata:{invitationStatus:invitation.status}
  });
  return reply.code(201).send({
    osUserId:payload.user_id,membershipId:schoolMembership.id,email:b.email,firstName:b.firstName,lastName:b.lastName,
    jobTitle:b.jobTitle,invitation
  });
});
app.post('/api/staff/teachers/:osUserId/send-invitation',async request=>{
  const a=await authorize(request,db,config,'staff.edit');
  if(!config.CORE_SERVICE_KEY)throw fail(503,'Core service authentication is not configured');
  const {osUserId}=z.object({osUserId:z.string().uuid()}).parse(request.params);
  const schoolMembership=await one<any>(db,`SELECT sm.* FROM school_memberships sm
    JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 AND sm.os_user_id=$2 AND sm.status='active' AND sr.is_active=true AND sr.can_teach=true`,
    [a.core.organisation_id,osUserId]);
  const users=await fetchCoreUsers(a.core.organisation_id);
  const teacher=users.find((u:any)=>u.id===osUserId);
  if(!teacher?.membership_id)throw fail(404,'Teacher Core OS membership was not found');

  const base=config.CORE_OS_URL.replace(/\/$/,'');
  const activated=await fetch(base+'/v1/internal/school/users/'+teacher.membership_id+'/status',{
    method:'PATCH',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id,status:'active'}),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!activated?.ok)throw fail(activated?.status||503,'Teacher Core OS access could not be activated');

  const setupRes=await fetch(base+'/v1/internal/school/users/'+teacher.membership_id+'/password-setup',{
    method:'POST',
    headers:{...coreServiceHeaders(),'content-type':'application/json'},
    body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id}),
    signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!setupRes)throw fail(503,'Core OS could not create a password setup invitation');
  const setup=await setupRes.json().catch(()=>null) as any;
  if(!setupRes.ok)throw fail(setupRes.status,setup?.error?.message||'Could not create password setup invitation');

  const publicBase=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
  const setupUrl=publicBase+'/login?next='+encodeURIComponent('/teacher')+'&setup='+encodeURIComponent(setup.setupToken);
  const delivered=await deliverCommunication({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,channel:'email',
    recipientName:(teacher.first_name+' '+teacher.last_name).trim(),recipientAddress:teacher.email,
    subject:'Set up your Revolt-X Teacher account',
    body:`Hello ${teacher.first_name},

A secure password-setup link has been generated for your Revolt-X School Teacher account.

Create your password here:
${setupUrl}

This link expires in 24 hours. After setting your password, sign in at ${publicBase}/login using ${teacher.email}.

If you did not request or expect this message, contact your school administrator.`,
    templateKey:'teacher.invitation',relatedType:'school_membership',relatedId:schoolMembership.id
  });
  await audit(a.core.organisation_id,a.core.id,'teacher.invitation_sent','school_membership',schoolMembership.id,{email:teacher.email,status:delivered.status});
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'teacher.invitation_sent',
    resourceType:'teacher',resourceId:osUserId,performedOn:(teacher.first_name+' '+teacher.last_name).trim(),
    oldValue:null,newValue:{invitationStatus:delivered.status,expiresInHours:24}
  });
  return{status:delivered.status,error:delivered.last_error??null,expiresInHours:24};
});

app.get('/api/staff/module-memberships',async request=>{
  const a=await authorize(request,db,config,'staff.view');
  return (await db.query(`SELECT sm.*,sr.name role_name,sr.portal_mode,sr.can_teach
    FROM school_memberships sm LEFT JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 ORDER BY sm.created_at`,[a.core.organisation_id])).rows;
});
app.post('/api/staff/module-memberships',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.edit');
  const b=z.object({osUserId:z.string().uuid(),role:z.string().min(1).max(40),status:z.enum(['active','suspended']).default('active')}).parse(request.body);
  await one<any>(db,'SELECT 1 FROM school_roles WHERE organisation_id=$1 AND key=$2 AND is_active=true',[a.core.organisation_id,b.role]);
  const row=await one<any>(db,`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,updated_at=now()
    RETURNING *`,[a.core.organisation_id,b.osUserId,b.role,b.status]);
  await audit(a.core.organisation_id,a.core.id,'school_staff.assigned','school_membership',row.id,{role:b.role});
  return reply.code(201).send(row);
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
  const b=z.object({
    name:z.string().min(2).max(80).optional(),startDate:z.string().date().optional(),endDate:z.string().date().optional(),
    nextTermBegins:z.string().date().nullable().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const start=b.startDate??String(current.start_date).slice(0,10),end=b.endDate??String(current.end_date).slice(0,10);
  const next=Object.hasOwn(b,'nextTermBegins')?b.nextTermBegins:(current.next_term_begins?String(current.next_term_begins).slice(0,10):null);
  if(end<=start)throw fail(400,'Term end date must be after start date');
  if(next&&next<=end)throw fail(400,'Next term begins must be after the current term ends');
  const row=await one<any>(db,`UPDATE terms SET name=COALESCE($1,name),start_date=COALESCE($2::date,start_date),end_date=COALESCE($3::date,end_date),
    next_term_begins=CASE WHEN $4 THEN $5::date ELSE next_term_begins END WHERE id=$6 AND organisation_id=$7 RETURNING *`,
    [b.name??null,b.startDate??null,b.endDate??null,Object.hasOwn(b,'nextTermBegins'),b.nextTermBegins??null,id,a.core.organisation_id]);
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
  const before=await one<any>(db,'SELECT * FROM classrooms WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(Object.hasOwn(b,'classTeacherOsUserId')&&b.classTeacherOsUserId){
    const other=await maybeOne<any>(db,`SELECT name FROM classrooms
      WHERE organisation_id=$1 AND academic_year_id=$2 AND is_active=true
        AND class_teacher_os_user_id=$3 AND id<>$4 LIMIT 1`,
      [a.core.organisation_id,before.academic_year_id,b.classTeacherOsUserId,id]);
    if(other)throw fail(409,`This teacher is already Class Teacher for ${other.name}. A teacher can be Class Teacher for only one active class.`);
  }
  const row=await one<any>(db,`UPDATE classrooms SET name=COALESCE($1,name),stream=CASE WHEN $2 THEN $3 ELSE stream END,capacity=CASE WHEN $4 THEN $5 ELSE capacity END,class_teacher_os_user_id=CASE WHEN $6 THEN $7 ELSE class_teacher_os_user_id END,is_active=COALESCE($8,is_active) WHERE id=$9 AND organisation_id=$10 RETURNING *`,[b.name??null,Object.hasOwn(b,'stream'),b.stream??null,Object.hasOwn(b,'capacity'),b.capacity??null,Object.hasOwn(b,'classTeacherOsUserId'),b.classTeacherOsUserId??null,b.isActive??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'class.updated','classroom',id);
  await changeLog({organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'class.updated',resourceType:'classroom',resourceId:id,performedOn:row.name,oldValue:before,newValue:row});
  return row;
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
    name:z.string().min(2).max(160).optional(),categoryId:z.string().uuid().optional(),
    maxScore:z.number().positive().optional(),assessmentDate:z.string().date().nullable().optional(),
    teacherOsUserId:z.string().uuid().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,current.classroom_id,current.subject_id);
  if(a.role==='teacher'&&current.teacher_os_user_id!==a.core.id)throw fail(403,'This exercise is assigned to another teacher');
  if(a.role==='teacher'&&b.teacherOsUserId&&b.teacherOsUserId!==a.core.id)throw fail(403,'Teachers cannot reassign exercises to another teacher');
  if(b.teacherOsUserId&&b.teacherOsUserId!==current.teacher_os_user_id){
    await validateTeachingAssignment({
      organisationId:a.core.organisation_id,academicYearId:current.academic_year_id,termId:current.term_id,
      classroomId:current.classroom_id,subjectId:current.subject_id,teacherOsUserId:b.teacherOsUserId
    });
  }
  let category:any=null;
  if(b.categoryId){
    category=await one<any>(db,`SELECT * FROM assessment_categories
      WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND term_id=$4 AND is_active=true`,
      [b.categoryId,a.core.organisation_id,current.academic_year_id,current.term_id]);
  }
  const type=category?(category.code==='CLASSWORK'?'classwork':category.code==='HOMEWORK'?'homework':category.code==='PROJECT'?'project':category.code==='EXAM'?'exam':category.code==='MIDTERM'?'test':'other'):null;
  const row=await one<any>(db,`UPDATE assessments SET
      name=COALESCE($1,name),category_id=COALESCE($2,category_id),assessment_type=COALESCE($3,assessment_type),
      max_score=COALESCE($4,max_score),weight=COALESCE($5,weight),
      assessment_date=CASE WHEN $6 THEN $7::date ELSE assessment_date END,
      teacher_os_user_id=COALESCE($8,teacher_os_user_id)
    WHERE id=$9 AND organisation_id=$10 RETURNING *`,
    [b.name??null,b.categoryId??null,type,b.maxScore??null,category?.weight_percent??null,Object.hasOwn(b,'assessmentDate'),
      b.assessmentDate??null,b.teacherOsUserId??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'assessment.updated','assessment',id,{
    categoryId:b.categoryId??current.category_id,teacherOsUserId:row.teacher_os_user_id
  });
  return row;
});
app.delete('/api/assessments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.delete');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM assessments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,row.classroom_id,row.subject_id);
  if(a.role==='teacher'&&row.teacher_os_user_id!==a.core.id)throw fail(403,'This exercise is assigned to another teacher');
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
  const a=await authorize(request,db,config,'fees.view');const q=z.object({studentId:z.string().uuid().optional()}).parse(request.query);
  return (await db.query(`SELECT sf.id student_fee_id,sf.student_id,s.admission_no,s.first_name,s.last_name,f.name fee_name,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid,((sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0)) balance,sf.status FROM student_fees sf JOIN students s ON s.id=sf.student_id JOIN fee_items f ON f.id=sf.fee_item_id LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.organisation_id=$1 AND ($2::uuid IS NULL OR sf.student_id=$2) GROUP BY sf.id,s.id,f.id HAVING ((sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0))>0 ORDER BY s.last_name,s.first_name,f.name`,[a.core.organisation_id,q.studentId??null])).rows;
});
app.get('/api/payments',async request=>{
  const a=await authorize(request,db,config,'fees.view');const q=z.object({studentId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
  return (await db.query(`SELECT p.*,s.admission_no,s.first_name,s.last_name,f.name fee_name FROM payments p JOIN students s ON s.id=p.student_id LEFT JOIN student_fees sf ON sf.id=p.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id WHERE p.organisation_id=$1 AND ($2::uuid IS NULL OR p.student_id=$2) ORDER BY p.paid_at DESC LIMIT $3`,[a.core.organisation_id,q.studentId??null,q.limit])).rows;
});
app.post('/api/payments/:id/void',async request=>{
  const a=await authorize(request,db,config,'fees.void');const {id}=z.object({id:z.string().uuid()}).parse(request.params);const b=z.object({originalReference:z.string().trim().min(2).max(160),reason:z.string().min(2).max(500)}).parse(request.body);
  const row=await tx(db,async client=>{
    const current=await one<any>(client,'SELECT * FROM payments WHERE id=$1 AND organisation_id=$2 AND voided_at IS NULL FOR UPDATE',[id,a.core.organisation_id]);
    if(String(current.reference||'').trim().toLowerCase()!==String(b.originalReference).trim().toLowerCase())throw fail(409,'Original transaction reference does not match this payment');
    const updated=await one<any>(client,'UPDATE payments SET voided_at=now(),voided_by_os_user_id=$1,void_reason=$2 WHERE id=$3 RETURNING *',[a.core.id,b.reason,id]);
    if(updated.student_fee_id)await updateStudentFeeStatus(client,updated.student_fee_id);
    const journal=await maybeOne<any>(client,`SELECT * FROM finance_journal_entries WHERE organisation_id=$1 AND source_type='student_payment' AND source_id=$2 AND status='posted' ORDER BY created_at LIMIT 1`,[a.core.organisation_id,id]);
    if(journal)await reverseFinanceJournal(client,a.core.organisation_id,journal.id,a.core.id,b.reason,'student_payment_void',id);
    return updated;
  });
  await audit(a.core.organisation_id,a.core.id,'payment.voided','payment',id,{reason:b.reason,originalReference:b.originalReference});return row;
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
  const rules=await maybeOne<any>(db,`SELECT * FROM timetable_settings WHERE organisation_id=$1 AND academic_year_id=$2
    AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL) ORDER BY term_id NULLS LAST LIMIT 1`,
    [a.core.organisation_id,current.academic_year_id,current.term_id]);
  if(rules){
    const dayStart=String(rules.school_day_start).slice(0,5),dayEnd=String(rules.school_day_end).slice(0,5);
    if(start<dayStart||end>dayEnd)throw fail(400,`Period must fall within the configured school day (${dayStart} - ${dayEnd})`);
  }
  const scheduledBreak=await maybeOne<any>(db,`SELECT label FROM timetable_breaks WHERE organisation_id=$1 AND academic_year_id=$2
    AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL) AND (day_of_week IS NULL OR day_of_week=$4)
    AND start_time<$6::time AND end_time>$5::time LIMIT 1`,
    [a.core.organisation_id,current.academic_year_id,current.term_id,day,start,end]);
  if(scheduledBreak)throw fail(409,`This period overlaps the scheduled ${scheduledBreak.label}`);
  if(teacher){
    const unavailable=await maybeOne<any>(db,`SELECT reason FROM timetable_teacher_unavailability
      WHERE organisation_id=$1 AND academic_year_id=$2 AND teacher_os_user_id=$3
        AND (term_id IS NOT DISTINCT FROM $4::uuid OR term_id IS NULL) AND day_of_week=$5
        AND start_time<$7::time AND end_time>$6::time LIMIT 1`,
      [a.core.organisation_id,current.academic_year_id,teacher,current.term_id,day,start,end]);
    if(unavailable)throw fail(409,'The selected teacher is unavailable during this period'+(unavailable.reason?': '+unavailable.reason:''));
  }
  const conflict=await maybeOne<any>(db,`SELECT tt.id,c.name classroom_name,s.name subject_name FROM timetable_entries tt
    JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    WHERE tt.organisation_id=$1 AND tt.academic_year_id=$2 AND tt.day_of_week=$3 AND tt.id<>$4
      AND tt.start_time<$6::time AND tt.end_time>$5::time
      AND (tt.classroom_id=$7 OR ($8::uuid IS NOT NULL AND tt.teacher_os_user_id=$8)
        OR ($10::text IS NOT NULL AND NULLIF(trim($10),'') IS NOT NULL AND lower(trim(tt.room))=lower(trim($10))))
      AND (tt.term_id IS NOT DISTINCT FROM $9::uuid OR tt.term_id IS NULL OR $9::uuid IS NULL)
    LIMIT 1`,[a.core.organisation_id,current.academic_year_id,day,id,start,end,current.classroom_id,teacher??null,current.term_id,Object.hasOwn(b,'room')?b.room:current.room]);
  if(conflict)throw fail(409,`Timetable conflict with ${conflict.classroom_name} - ${conflict.subject_name}`);
  const row=await one<any>(db,`UPDATE timetable_entries SET subject_id=COALESCE($1,subject_id),
    teacher_os_user_id=CASE WHEN $2 THEN $3 ELSE teacher_os_user_id END,day_of_week=COALESCE($4,day_of_week),
    start_time=COALESCE($5::time,start_time),end_time=COALESCE($6::time,end_time),
    room=CASE WHEN $7 THEN $8 ELSE room END,schedule_source='manual',is_locked=true
    WHERE id=$9 AND organisation_id=$10 RETURNING *`,[
    b.subjectId??null,Object.hasOwn(b,'teacherOsUserId'),b.teacherOsUserId??null,b.dayOfWeek??null,b.startTime??null,b.endTime??null,
    Object.hasOwn(b,'room'),b.room??null,id,a.core.organisation_id
  ]);
  await audit(a.core.organisation_id,a.core.id,'timetable.updated','timetable_entry',id);
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'timetable.updated',
    resourceType:'timetable_entry',resourceId:id,performedOn:'Class '+current.classroom_id,
    oldValue:current,newValue:row,metadata:{manualOverride:true}
  });
  return row;
});
app.delete('/api/timetable/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.manage');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await one<any>(db,'DELETE FROM timetable_entries WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'timetable.deleted','timetable_entry',id);return reply.code(204).send();
});

app.patch('/api/staff/module-memberships/:id',async request=>{
  const a=await authorize(request,db,config,'staff.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({role:z.string().min(1).max(40).optional(),status:z.enum(['active','suspended']).optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
  if(b.role)await one<any>(db,'SELECT 1 FROM school_roles WHERE organisation_id=$1 AND key=$2 AND is_active=true',[a.core.organisation_id,b.role]);
  const row=await one<any>(db,'UPDATE school_memberships SET role=COALESCE($1,role),status=COALESCE($2,status),updated_at=now() WHERE id=$3 AND organisation_id=$4 RETURNING *',[b.role??null,b.status??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'school_staff.updated','school_membership',id,{role:row.role,status:row.status});
  return row;
});
app.delete('/api/staff/module-memberships/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'staff.delete');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'SELECT * FROM school_memberships WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(row.os_user_id===a.core.id)throw fail(409,'You cannot remove your own School access');
  await db.query('DELETE FROM school_memberships WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);await audit(a.core.organisation_id,a.core.id,'school_staff.removed','school_membership',id,{osUserId:row.os_user_id});return reply.code(204).send();
});


async function validateTeachingAssignment(input:{
  organisationId:string;
  academicYearId:string;
  termId?:string|null;
  classroomId:string;
  subjectId?:string|null;
  teacherOsUserId:string;
}){
  const membership=await maybeOne<any>(db,`SELECT sm.*,sr.can_teach,sr.portal_mode,sr.name role_name
    FROM school_memberships sm
    JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 AND sm.os_user_id=$2 AND sm.status='active' AND sr.is_active=true AND sr.can_teach=true`,
    [input.organisationId,input.teacherOsUserId]);
  if(!membership)throw fail(409,'The selected user does not have an active teaching role in Revolt-X School');

  const classroom=await one<any>(db,`SELECT c.*,g.stage FROM classrooms c
    JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE c.id=$1 AND c.organisation_id=$2 AND c.academic_year_id=$3 AND c.is_active=true`,
    [input.classroomId,input.organisationId,input.academicYearId]);

  if(input.termId){
    await one<any>(db,`SELECT id FROM terms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3`,
      [input.termId,input.organisationId,input.academicYearId]);
  }

  if(input.subjectId){
    const subject=await one<any>(db,`SELECT s.* FROM subjects s
      WHERE s.id=$1 AND s.organisation_id=$2 AND s.is_active=true`,[input.subjectId,input.organisationId]);
    if(subject.stage!=='both'&&subject.stage!==classroom.stage)throw fail(400,'The selected subject is not configured for this class stage');
    const classSubject=await maybeOne<any>(db,`SELECT id FROM class_subjects
      WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3 AND subject_id=$4 AND is_active=true`,
      [input.organisationId,input.academicYearId,input.classroomId,input.subjectId]);
    if(!classSubject)throw fail(409,'Add this subject to the selected class before assigning a teacher');
  }

  if(!input.subjectId){
    const other=await maybeOne<any>(db,`SELECT c.name classroom_name FROM teacher_assignments ta
      JOIN classrooms c ON c.id=ta.classroom_id
      WHERE ta.organisation_id=$1 AND ta.academic_year_id=$2 AND ta.teacher_os_user_id=$3
        AND ta.subject_id IS NULL AND ta.is_active=true AND ta.classroom_id<>$4
      ORDER BY (ta.term_id IS NULL) DESC,ta.created_at LIMIT 1`,
      [input.organisationId,input.academicYearId,input.teacherOsUserId,input.classroomId]);
    if(other)throw fail(409,`This teacher is already Class Teacher for ${other.classroom_name}. A teacher can be Class Teacher for only one active class in an academic year.`);
  }

  return{membership,classroom};
}

app.get('/api/teacher-assignments',async request=>{
  const a=await authorize(request,db,config,'teaching_assignments.view');
  return (await db.query(`SELECT ta.*,c.name classroom_name,s.name subject_name,y.name academic_year,t.name term_name
    FROM teacher_assignments ta
    JOIN classrooms c ON c.id=ta.classroom_id
    LEFT JOIN subjects s ON s.id=ta.subject_id
    JOIN academic_years y ON y.id=ta.academic_year_id
    LEFT JOIN terms t ON t.id=ta.term_id
    WHERE ta.organisation_id=$1
    ORDER BY ta.is_active DESC,c.name,s.name NULLS FIRST,ta.created_at DESC`,[a.core.organisation_id])).rows;
});
app.post('/api/teacher-assignments',async(request,reply)=>{
  const a=await authorize(request,db,config,'teaching_assignments.manage');
  const b=z.object({
    academicYearId:z.string().uuid(),
    termId:z.string().uuid().nullable().optional(),
    classroomId:z.string().uuid(),
    subjectId:z.string().uuid().nullable().optional(),
    teacherOsUserId:z.string().uuid(),
    replaceExisting:z.boolean().default(false)
  }).parse(request.body);

  const validated=await validateTeachingAssignment({
    organisationId:a.core.organisation_id,academicYearId:b.academicYearId,termId:b.termId??null,
    classroomId:b.classroomId,subjectId:b.subjectId??null,teacherOsUserId:b.teacherOsUserId
  });

  const existingSame=await maybeOne<any>(db,`SELECT * FROM teacher_assignments
    WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3
      AND subject_id IS NOT DISTINCT FROM $4::uuid AND term_id IS NOT DISTINCT FROM $5::uuid
      AND teacher_os_user_id=$6 ORDER BY created_at DESC LIMIT 1`,
    [a.core.organisation_id,b.academicYearId,b.classroomId,b.subjectId??null,b.termId??null,b.teacherOsUserId]);

  if(existingSame){
    const row=await one<any>(db,'UPDATE teacher_assignments SET is_active=true WHERE id=$1 RETURNING *',[existingSame.id]);
    if(!b.subjectId&&!b.termId)await db.query('UPDATE classrooms SET class_teacher_os_user_id=$1 WHERE id=$2',[b.teacherOsUserId,b.classroomId]);
    await audit(a.core.organisation_id,a.core.id,'teacher_assignment.reactivated','teacher_assignment',row.id,{teacherOsUserId:b.teacherOsUserId});
    return reply.code(200).send({...row,reused:true});
  }

  const conflicts=(await db.query(`SELECT * FROM teacher_assignments
    WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3
      AND subject_id IS NOT DISTINCT FROM $4::uuid AND term_id IS NOT DISTINCT FROM $5::uuid
      AND is_active=true AND teacher_os_user_id<>$6`,
    [a.core.organisation_id,b.academicYearId,b.classroomId,b.subjectId??null,b.termId??null,b.teacherOsUserId])).rows;

  if(!b.subjectId&&!b.termId&&validated.classroom.class_teacher_os_user_id&&validated.classroom.class_teacher_os_user_id!==b.teacherOsUserId&&!b.replaceExisting){
    throw fail(409,'This class already has a class teacher. Choose Replace existing teacher to reassign it.');
  }
  if(conflicts.length&&!b.replaceExisting){
    throw fail(409,b.subjectId?'This class and subject already has an active teacher. Choose Replace existing teacher to reassign it.':'This class already has an active class teacher assignment.');
  }

  const row=await tx(db,async client=>{
    if(b.replaceExisting){
      await client.query(`UPDATE teacher_assignments SET is_active=false
        WHERE organisation_id=$1 AND academic_year_id=$2 AND classroom_id=$3
          AND subject_id IS NOT DISTINCT FROM $4::uuid AND term_id IS NOT DISTINCT FROM $5::uuid AND is_active=true`,
        [a.core.organisation_id,b.academicYearId,b.classroomId,b.subjectId??null,b.termId??null]);
    }
    if(!b.subjectId&&!b.termId){
      await client.query('UPDATE classrooms SET class_teacher_os_user_id=$1 WHERE id=$2 AND organisation_id=$3',
        [b.teacherOsUserId,b.classroomId,a.core.organisation_id]);
    }
    return one<any>(client,`INSERT INTO teacher_assignments(
      organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,is_active
    ) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [a.core.organisation_id,b.academicYearId,b.termId??null,b.classroomId,b.subjectId??null,b.teacherOsUserId]);
  });
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.created','teacher_assignment',row.id,{
    teacherOsUserId:b.teacherOsUserId,classroomId:b.classroomId,subjectId:b.subjectId??null,replaced:b.replaceExisting
  });
  const target=await one<any>(db,`SELECT c.name classroom_name,s.name subject_name FROM classrooms c
    LEFT JOIN subjects s ON s.id=$1 WHERE c.id=$2`,[b.subjectId??null,b.classroomId]);
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'teacher_assignment.created',
    resourceType:'teacher_assignment',resourceId:row.id,
    performedOn:target.classroom_name+' • '+(target.subject_name||'Class Teacher'),
    oldValue:b.replaceExisting?conflicts:null,
    newValue:{teacherOsUserId:b.teacherOsUserId,classroomId:b.classroomId,subjectId:b.subjectId??null,termId:b.termId??null,isActive:true}
  });
  return reply.code(201).send(row);
});
app.patch('/api/teacher-assignments/:id',async request=>{
  const a=await authorize(request,db,config,'teaching_assignments.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({isActive:z.boolean()}).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM teacher_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  const row=await one<any>(db,'UPDATE teacher_assignments SET is_active=$1 WHERE id=$2 AND organisation_id=$3 RETURNING *',[b.isActive,id,a.core.organisation_id]);
  if(!current.subject_id&&!current.term_id){
    await db.query('UPDATE classrooms SET class_teacher_os_user_id=$1 WHERE id=$2 AND organisation_id=$3',
      [b.isActive?current.teacher_os_user_id:null,current.classroom_id,a.core.organisation_id]);
  }
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.updated','teacher_assignment',id,{isActive:b.isActive});
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'teacher_assignment.updated',
    resourceType:'teacher_assignment',resourceId:id,performedOn:current.classroom_id,
    oldValue:{isActive:current.is_active,teacherOsUserId:current.teacher_os_user_id,subjectId:current.subject_id},
    newValue:{isActive:row.is_active,teacherOsUserId:row.teacher_os_user_id,subjectId:row.subject_id}
  });
  return row;
});
app.delete('/api/teacher-assignments/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'teaching_assignments.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM teacher_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await db.query('DELETE FROM teacher_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(!current.subject_id){
    await db.query('UPDATE classrooms SET class_teacher_os_user_id=NULL WHERE id=$1 AND organisation_id=$2 AND class_teacher_os_user_id=$3',
      [current.classroom_id,a.core.organisation_id,current.teacher_os_user_id]);
  }
  await audit(a.core.organisation_id,a.core.id,'teacher_assignment.deleted','teacher_assignment',id);
  await changeLog({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'teacher_assignment.deleted',
    resourceType:'teacher_assignment',resourceId:id,performedOn:current.classroom_id,
    oldValue:current,newValue:null
  });
  return reply.code(204).send();
});

app.get('/api/grading-bands',async request=>{
  const a=await authorize(request,db,config,'assessment.view');
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
  const a=await authorize(request,db,config,'homework.view');
  const q=z.object({
    classroomId:z.string().uuid().optional(),termId:z.string().uuid().optional(),
    status:z.enum(['draft','published','closed']).optional(),teacherOsUserId:z.string().uuid().optional()
  }).parse(request.query);
  let rows=(await db.query(`SELECT h.*,c.name classroom_name,s.name subject_name,t.name term_name,
      (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=h.classroom_id AND e.status='active') student_count,
      (SELECT count(*)::int FROM homework_submissions hs WHERE hs.homework_id=h.id) tracked_students,
      (SELECT count(*)::int FROM homework_submissions hs WHERE hs.homework_id=h.id AND hs.status IN('submitted','late','graded')) submitted_students,
      (SELECT count(*)::int FROM homework_submissions hs WHERE hs.homework_id=h.id AND hs.status='graded') graded_students
    FROM homework_assignments h JOIN classrooms c ON c.id=h.classroom_id JOIN subjects s ON s.id=h.subject_id
    JOIN terms t ON t.id=h.term_id
    WHERE h.organisation_id=$1 AND ($2::uuid IS NULL OR h.classroom_id=$2)
      AND ($3::uuid IS NULL OR h.term_id=$3) AND ($4::text IS NULL OR h.status=$4)
      AND ($5::uuid IS NULL OR h.teacher_os_user_id=$5)
    ORDER BY h.created_at DESC`,[
      a.core.organisation_id,q.classroomId??null,q.termId??null,q.status??null,q.teacherOsUserId??null
    ])).rows;
  if(a.role==='teacher')rows=rows.filter((r:any)=>r.teacher_os_user_id===a.core.id);
  return rows.map((r:any)=>{
    const total=Number(r.student_count||r.tracked_students||0),submitted=Number(r.submitted_students||0),graded=Number(r.graded_students||0);
    let progressStatus='pending',progressPercent=0;
    if(r.status==='draft'){progressStatus='pending_publish';progressPercent=0}
    else if(r.status==='closed'){progressStatus='complete';progressPercent=100}
    else if(total===0){progressStatus='pending';progressPercent=0}
    else if(r.max_score!=null&&graded>=total){progressStatus='complete';progressPercent=100}
    else if(r.max_score!=null&&submitted>=total&&graded<total){progressStatus='grading_pending';progressPercent=Math.round((graded/total)*100)}
    else if(submitted===0){progressStatus=(r.due_at&&new Date(r.due_at).getTime()<Date.now())?'overdue':'pending_submissions';progressPercent=0}
    else if(submitted<total){progressStatus=(r.due_at&&new Date(r.due_at).getTime()<Date.now())?'overdue':'in_progress';progressPercent=Math.round((submitted/total)*100)}
    else {progressStatus='complete';progressPercent=100}
    return{...r,progress_percent:progressPercent,progress_status:progressStatus,pending:progressStatus!=='complete'};
  });
});
app.post('/api/homework',async(request,reply)=>{
  const a=await authorize(request,db,config,'homework.create');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),
    title:z.string().min(2).max(200),instructions:z.string().min(1).max(10000),dueAt:z.string().datetime().optional(),
    maxScore:z.number().positive().optional(),teacherOsUserId:z.string().uuid().optional()
  }).parse(request.body);
  const teacherId=a.role==='teacher'?a.core.id:(b.teacherOsUserId??a.core.id);
  if(a.role==='teacher')await ensureTeacherScope(a,b.classroomId,b.subjectId);
  else await validateTeachingAssignment({
    organisationId:a.core.organisation_id,academicYearId:b.academicYearId,termId:b.termId,
    classroomId:b.classroomId,subjectId:b.subjectId,teacherOsUserId:teacherId
  });
  const cleanTitle=b.title.trim();
  const duplicate=await maybeOne<any>(db,`SELECT id FROM homework_assignments
    WHERE organisation_id=$1 AND term_id=$2 AND classroom_id=$3 AND subject_id=$4 AND teacher_os_user_id=$5
      AND lower(trim(title))=lower($6) AND due_at IS NOT DISTINCT FROM $7::timestamptz LIMIT 1`,
    [a.core.organisation_id,b.termId,b.classroomId,b.subjectId,teacherId,cleanTitle,b.dueAt??null]);
  if(duplicate)throw fail(409,'This teacher already has homework with the same title and due date for this class and subject');
  const row=await one<any>(db,`INSERT INTO homework_assignments(
    organisation_id,academic_year_id,term_id,classroom_id,subject_id,title,instructions,due_at,max_score,created_by_os_user_id,teacher_os_user_id
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[
    a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,cleanTitle,b.instructions,b.dueAt??null,b.maxScore??null,a.core.id,teacherId
  ]);
  await audit(a.core.organisation_id,a.core.id,'homework.created','homework',row.id,{teacherOsUserId:teacherId});
  return reply.code(201).send(row);
});
app.patch('/api/homework/:id',async request=>{
  const a=await authorize(request,db,config,'homework.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,current.classroom_id,current.subject_id);
  if(a.role==='teacher'&&current.teacher_os_user_id!==a.core.id)throw fail(403,'This homework belongs to another teacher');
  const b=z.object({
    title:z.string().min(2).max(200).optional(),instructions:z.string().min(1).max(10000).optional(),
    dueAt:z.string().datetime().nullable().optional(),maxScore:z.number().positive().nullable().optional(),
    status:z.enum(['draft','published','closed']).optional(),teacherOsUserId:z.string().uuid().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  if(a.role==='teacher'&&b.teacherOsUserId&&b.teacherOsUserId!==a.core.id)throw fail(403,'Teachers cannot reassign homework');
  if(b.teacherOsUserId&&b.teacherOsUserId!==current.teacher_os_user_id){
    await validateTeachingAssignment({
      organisationId:a.core.organisation_id,academicYearId:current.academic_year_id,termId:current.term_id,
      classroomId:current.classroom_id,subjectId:current.subject_id,teacherOsUserId:b.teacherOsUserId
    });
  }
  return one<any>(db,`UPDATE homework_assignments SET title=COALESCE($1,title),instructions=COALESCE($2,instructions),
    due_at=CASE WHEN $3 THEN $4::timestamptz ELSE due_at END,max_score=CASE WHEN $5 THEN $6 ELSE max_score END,
    status=COALESCE($7,status),teacher_os_user_id=COALESCE($8,teacher_os_user_id),updated_at=now()
    WHERE id=$9 RETURNING *`,[
      b.title??null,b.instructions??null,Object.hasOwn(b,'dueAt'),b.dueAt??null,Object.hasOwn(b,'maxScore'),
      b.maxScore??null,b.status??null,b.teacherOsUserId??null,id
    ]);
});
app.post('/api/homework/:id/publish',async request=>{
  const a=await authorize(request,db,config,'homework.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const h=await one<any>(db,`SELECT h.*,c.name classroom_name,s.name subject_name,sp.school_name
    FROM homework_assignments h JOIN classrooms c ON c.id=h.classroom_id JOIN subjects s ON s.id=h.subject_id
    JOIN school_profiles sp ON sp.organisation_id=h.organisation_id
    WHERE h.id=$1 AND h.organisation_id=$2`,[id,a.core.organisation_id]);
  await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  if(a.role==='teacher'&&h.teacher_os_user_id!==a.core.id)throw fail(403,'This homework belongs to another teacher');
  if(h.status==='closed')throw fail(409,'Closed homework cannot be published again');
  const wasPublished=h.status==='published';
  const row=await tx(db,async client=>{
    const updated=await one<any>(client,"UPDATE homework_assignments SET status='published',updated_at=now() WHERE id=$1 RETURNING *",[id]);
    await client.query(`INSERT INTO homework_submissions(homework_id,student_id)
      SELECT $1,e.student_id FROM enrolments e WHERE e.classroom_id=$2 AND e.status='active'
      ON CONFLICT(homework_id,student_id) DO NOTHING`,[id,h.classroom_id]);
    return updated;
  });
  if(!wasPublished){
    const recipients=(await db.query(`SELECT DISTINCT g.id,g.first_name,g.last_name,g.phone,g.email,s.first_name student_first_name,s.last_name student_last_name
      FROM enrolments e JOIN students s ON s.id=e.student_id
      JOIN student_guardians sg ON sg.student_id=s.id JOIN guardians g ON g.id=sg.guardian_id
      WHERE e.classroom_id=$1 AND e.status='active' ORDER BY g.id`,[h.classroom_id])).rows;
    const due=h.due_at?new Date(h.due_at).toLocaleString('en-GB',{timeZone:'UTC'}):'No due date set';
    for(const g of recipients){
      await notifyContact({
        organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:g.id,eventKey:'homework.published',
        name:g.first_name+' '+g.last_name,email:g.email,phone:g.phone,
        subject:'New homework: '+h.title,
        body:`${h.school_name} has published homework for ${g.student_first_name} ${g.student_last_name}. Subject: ${h.subject_name}. Class: ${h.classroom_name}. Due: ${due}. Instructions: ${h.instructions}. Open the Parent Portal to view the homework and track its submission status.`,
        relatedType:'homework',relatedId:id
      });
    }
  }
  await audit(a.core.organisation_id,a.core.id,'homework.published','homework',id,{notified:!wasPublished});
  return row;
});
app.get('/api/homework/:id/submissions',async request=>{
  const a=await authorize(request,db,config,'homework.view');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  if(a.role==='teacher'&&h.teacher_os_user_id!==a.core.id)throw fail(403,'This homework belongs to another teacher');
  return (await db.query(`SELECT hs.*,s.admission_no,s.first_name,s.last_name
    FROM homework_submissions hs JOIN students s ON s.id=hs.student_id
    WHERE hs.homework_id=$1 ORDER BY s.last_name,s.first_name`,[id])).rows;
});
app.post('/api/homework/:id/submissions',async request=>{
  const a=await authorize(request,db,config,'homework.score');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const h=await one<any>(db,`SELECT h.*,sub.name subject_name,c.name classroom_name,sp.school_name
    FROM homework_assignments h JOIN subjects sub ON sub.id=h.subject_id JOIN classrooms c ON c.id=h.classroom_id
    JOIN school_profiles sp ON sp.organisation_id=h.organisation_id
    WHERE h.id=$1 AND h.organisation_id=$2`,[id,a.core.organisation_id]);
  await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  const b=z.object({records:z.array(z.object({
    studentId:z.string().uuid(),status:z.enum(['not_submitted','submitted','late','graded']),
    score:z.number().min(0).nullable().optional(),teacherComment:z.string().max(1000).nullable().optional()
  })).min(1).max(200)}).parse(request.body);
  for(const r of b.records)if(r.score!=null&&h.max_score!=null&&r.score>Number(h.max_score))throw fail(400,`Homework score cannot exceed ${h.max_score}`);

  const before=(await db.query('SELECT student_id,status,score,teacher_comment FROM homework_submissions WHERE homework_id=$1',[id])).rows;
  await tx(db,async client=>{
    for(const r of b.records){
      await client.query(`INSERT INTO homework_submissions(homework_id,student_id,status,submitted_at,score,teacher_comment)
        VALUES($1::uuid,$2::uuid,$3::varchar,CASE WHEN $3::varchar IN('submitted','late','graded') THEN now() ELSE NULL END,$4::numeric,$5::varchar)
        ON CONFLICT(homework_id,student_id) DO UPDATE SET
          status=EXCLUDED.status,
          submitted_at=CASE WHEN EXCLUDED.status::text IN('submitted','late','graded') THEN COALESCE(homework_submissions.submitted_at,now()) ELSE homework_submissions.submitted_at END,
          score=EXCLUDED.score,teacher_comment=EXCLUDED.teacher_comment,updated_at=now()`,
        [id,r.studentId,r.status,r.score??null,r.teacherComment??null]);
    }
  });

  let notifications=0;
  for(const r of b.records){
    const old=before.find((x:any)=>x.student_id===r.studentId);
    const changed=!old||old.status!==r.status||Number(old.score??-1)!==Number(r.score??-1)||String(old.teacher_comment??'')!==String(r.teacherComment??'');
    if(!changed||!['submitted','late','graded'].includes(r.status))continue;
    const student=await one<any>(db,'SELECT first_name,last_name FROM students WHERE id=$1 AND organisation_id=$2',[r.studentId,a.core.organisation_id]);
    const guardians=(await db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id=g.id
      WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC,g.created_at`,[r.studentId])).rows;
    const eventKey=r.status==='graded'?'homework.graded':'homework.submitted';
    const resultText=r.status==='graded'
      ? `The homework has been graded${r.score!=null?' with a score of '+r.score+(h.max_score!=null?'/'+h.max_score:''):''}.${r.teacherComment?' Teacher comment: '+r.teacherComment:''}`
      : `The homework submission has been recorded as ${r.status.replace('_',' ')}.`;
    for(const g of guardians){
      await notifyContact({
        organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:g.id,eventKey,
        name:g.first_name+' '+g.last_name,email:g.email,phone:g.phone,
        subject:(r.status==='graded'?'Homework graded: ':'Homework submission recorded: ')+h.title,
        body:`${h.school_name}: ${student.first_name} ${student.last_name} - ${h.subject_name}, ${h.title}. ${resultText} Open the Parent Portal for the full instructions and current status.`,
        relatedType:'homework',relatedId:id
      });
      notifications++;
    }
  }
  await audit(a.core.organisation_id,a.core.id,'homework.submissions_saved','homework',id,{count:b.records.length,notifications});
  return{saved:b.records.length,notifications};
});
app.delete('/api/homework/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'homework.delete');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const h=await one<any>(db,'SELECT * FROM homework_assignments WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  await ensureTeacherScope(a,h.classroom_id,h.subject_id);
  await db.query('DELETE FROM homework_assignments WHERE id=$1',[id]);
  await audit(a.core.organisation_id,a.core.id,'homework.deleted','homework',id);
  return reply.code(204).send();
});

app.get('/api/announcements',async request=>{
  const a=await authorize(request,db,config,'communications.view');return (await db.query(`SELECT a.*,c.name classroom_name FROM school_announcements a LEFT JOIN classrooms c ON c.id=a.classroom_id WHERE a.organisation_id=$1 ORDER BY a.created_at DESC`,[a.core.organisation_id])).rows;
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
    promotionDecision:z.enum(['promoted','repeated','completed']).nullable().optional()
  }).parse(request.body);
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[b.termId,a.core.organisation_id]);
  const current=await one<any>(db,`SELECT c.id classroom_id
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 AND e.organisation_id=$3
    ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id,a.core.organisation_id]);
  const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,current.classroom_id,b.termId);
  const existing=await maybeOne<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,b.termId]);
  const returnedToMe=existing?.workflow_status==='returned'&&existing?.submitted_by_os_user_id===a.core.id;
  if(!returnedToMe){
    await ensureTeacherScope(a,current.classroom_id,null);
    if(a.role!=='school_admin'&&classTeacherId!==a.core.id)throw fail(403,'Only the assigned Class Teacher for this term can complete report remarks for this class');
  }
  if(existing?.workflow_status==='submitted'||existing?.workflow_status==='approved')throw fail(409,'This report is already submitted for review. Return it to the class teacher before editing.');

  const results=await calculateStudentTermResults(a.core.organisation_id,studentId,b.termId);
  const promotion=await reportPromotionInfo(a.core.organisation_id,studentId,b.termId,current.classroom_id,results);
  const chosen=Object.hasOwn(b,'promotionDecision')
    ?(b.promotionDecision??promotion.suggestedDecision)
    :(existing?.promotion_decision??promotion.suggestedDecision);
  const basis=chosen
    ?(Object.hasOwn(b,'promotionDecision')&&b.promotionDecision&&b.promotionDecision!==promotion.suggestedDecision?'teacher_override':existing?.promotion_basis??'threshold')
    :null;

  const row=await one<any>(db,`INSERT INTO report_comments(
      organisation_id,student_id,term_id,class_teacher_comment,conduct,interest,next_term_begins,
      updated_by_os_user_id,workflow_status,class_teacher_os_user_id,promotion_decision,promotion_basis,promotion_threshold_percent
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12)
    ON CONFLICT(student_id,term_id) DO UPDATE SET
      class_teacher_comment=EXCLUDED.class_teacher_comment,conduct=EXCLUDED.conduct,interest=EXCLUDED.interest,
      next_term_begins=EXCLUDED.next_term_begins,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,
      class_teacher_os_user_id=EXCLUDED.class_teacher_os_user_id,
      promotion_decision=EXCLUDED.promotion_decision,promotion_basis=EXCLUDED.promotion_basis,
      promotion_threshold_percent=EXCLUDED.promotion_threshold_percent,
      workflow_status=report_comments.workflow_status,
      return_note=CASE WHEN report_comments.workflow_status='returned' THEN report_comments.return_note ELSE NULL END,updated_at=now()
    RETURNING *`,[
      a.core.organisation_id,studentId,b.termId,b.classTeacherComment??null,b.conduct??null,b.interest??null,
      term.next_term_begins??null,a.core.id,classTeacherId,chosen,basis,promotion.threshold
    ]);
  await audit(a.core.organisation_id,a.core.id,'report.remarks_saved','report_comment',row.id,{
    studentId,termId:b.termId,promotionDecision:chosen,promotionBasis:basis
  });
  return row;
});
app.post('/api/report-comments/:studentId/submit',async request=>{
  const a=await authorize(request,db,config,'reports.submit');
  const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
  const b=z.object({termId:z.string().uuid()}).parse(request.body);
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[b.termId,a.core.organisation_id]);
  const current=await one<any>(db,`SELECT c.id classroom_id
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 AND e.organisation_id=$3
    ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id,a.core.organisation_id]);
  const report=await one<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,b.termId]);
  const returnedToMe=report.workflow_status==='returned'&&report.submitted_by_os_user_id===a.core.id;
  if(!returnedToMe){
    await ensureTeacherScope(a,current.classroom_id,null);
    const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,current.classroom_id,b.termId);
    if(a.role!=='school_admin'&&classTeacherId!==a.core.id)throw fail(403,'Only the assigned Class Teacher for this term can submit this report');
  }
  if(!report.class_teacher_comment)throw fail(409,'Enter the class teacher remark before submitting the report');
  if(!['draft','returned'].includes(report.workflow_status))throw fail(409,'Only draft or returned reports can be submitted');

  const readiness=await reportAssessmentReadiness(a.core.organisation_id,studentId,b.termId,current.classroom_id);
  if(!readiness.complete){
    const detail=readiness.missing.slice(0,8).map((x:any)=>x.subjectName+' – '+x.missing.join('; ')).join(' | ');
    throw fail(409,'Report cannot be submitted because grades are incomplete. '+detail);
  }
  const results=await calculateStudentTermResults(a.core.organisation_id,studentId,b.termId);
  const promotion=await reportPromotionInfo(a.core.organisation_id,studentId,b.termId,current.classroom_id,results);
  const decision=report.promotion_decision??promotion.suggestedDecision;
  if(!decision)throw fail(409,'Choose the promotion decision before submitting this report');

  const updated=await one<any>(db,`UPDATE report_comments SET workflow_status='submitted',submitted_by_os_user_id=$1::uuid,submitted_at=now(),
    promotion_decision=$2,promotion_basis=COALESCE(promotion_basis,'threshold'),promotion_threshold_percent=COALESCE(promotion_threshold_percent,$3),
    return_note=NULL,released_at=NULL,released_by_os_user_id=NULL,updated_at=now()
    WHERE id=$4::uuid RETURNING *`,[a.core.id,decision,promotion.threshold,report.id]);

  const reviewerIds=(await db.query(`SELECT reviewer_os_user_id FROM report_reviewer_assignments
    WHERE organisation_id=$1 AND classroom_id=$2 AND is_active=true`,[a.core.organisation_id,current.classroom_id])).rows.map((x:any)=>x.reviewer_os_user_id);
  if(!reviewerIds.length){
    reviewerIds.push(...(await db.query(`SELECT os_user_id FROM school_memberships
      WHERE organisation_id=$1 AND status='active' AND role IN('headteacher','school_admin')`,[a.core.organisation_id])).rows.map((x:any)=>x.os_user_id));
  }
  const coreUsers=await fetchCoreUsers(a.core.organisation_id);
  const reportStudent=await one<any>(db,'SELECT first_name,last_name FROM students WHERE id=$1',[studentId]);
  for(const reviewerId of [...new Set(reviewerIds)]){
    const reviewer=coreUsers.find((u:any)=>u.id===reviewerId);
    if(reviewer?.email){
      await notifyContact({
        organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'reports.submitted',
        name:(reviewer.first_name+' '+reviewer.last_name).trim(),email:reviewer.email,phone:null,
        subject:'Report card awaiting review',
        body:`A report card has been submitted for review. Student: ${reportStudent.first_name} ${reportStudent.last_name}. All required Class Assessment and Exam grades are present. Open the approval queue in Revolt-X School.`,
        relatedType:'report_comment',relatedId:report.id
      });
    }
  }
  await audit(a.core.organisation_id,a.core.id,'report.submitted','report_comment',report.id,{
    studentId,termId:b.termId,classroomId:current.classroom_id,promotionDecision:decision
  });
  return updated;
});
app.get('/api/teacher/report-worklist',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  await ensureTeachingRole(a);
  const q=z.object({termId:z.string().uuid().optional()}).parse(request.query);
  return (await db.query(`SELECT rc.*,s.admission_no,s.first_name,s.last_name,c.id classroom_id,c.name classroom_name,
      t.name term_name,y.name academic_year
    FROM report_comments rc
    JOIN students s ON s.id=rc.student_id
    JOIN terms t ON t.id=rc.term_id
    JOIN academic_years y ON y.id=t.academic_year_id
    JOIN enrolments e ON e.student_id=s.id AND e.academic_year_id=t.academic_year_id
    JOIN classrooms c ON c.id=e.classroom_id
    WHERE rc.organisation_id=$1
      AND (
        COALESCE(
          (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
           WHERE ta.organisation_id=rc.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true
             AND ta.term_id=rc.term_id ORDER BY ta.created_at DESC LIMIT 1),
          (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
           WHERE ta.organisation_id=rc.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true
             AND ta.term_id IS NULL ORDER BY ta.created_at DESC LIMIT 1),
          c.class_teacher_os_user_id
        )=$2
        OR (rc.workflow_status='returned' AND rc.submitted_by_os_user_id=$2)
      )
      AND ($3::uuid IS NULL OR rc.term_id=$3)
    ORDER BY CASE rc.workflow_status WHEN 'returned' THEN 0 WHEN 'draft' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END,rc.updated_at DESC`,
    [a.core.organisation_id,a.core.id,q.termId??null])).rows;
});

async function classReportPool(organisationId:string,classroomId:string,termId:string){
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[termId,organisationId]);
  const classroom=await one<any>(db,'SELECT * FROM classrooms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3',[classroomId,organisationId,term.academic_year_id]);
  const rows=(await db.query(`
    SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,
      g.id guardian_id,g.first_name guardian_first_name,g.last_name guardian_last_name,g.email guardian_email,g.phone guardian_phone,
      rc.id report_id,COALESCE(rc.workflow_status,'not_started') workflow_status,rc.submitted_at,rc.reviewed_at,
      rc.promotion_decision,rc.promotion_basis,rc.released_at,
      (SELECT count(*)::int FROM class_subjects cs
        WHERE cs.organisation_id=$1 AND cs.classroom_id=$2 AND cs.academic_year_id=$4 AND cs.is_active=true) required_subjects,
      (SELECT count(*)::int FROM class_subjects cs
        WHERE cs.organisation_id=$1 AND cs.classroom_id=$2 AND cs.academic_year_id=$4 AND cs.is_active=true
          AND (
            NOT EXISTS(
              SELECT 1 FROM assessments a LEFT JOIN assessment_categories ac ON ac.id=a.category_id
              WHERE a.organisation_id=$1 AND a.classroom_id=$2 AND a.term_id=$3 AND a.subject_id=cs.subject_id
                AND COALESCE(ac.code,upper(a.assessment_type))<>'EXAM'
            )
            OR NOT EXISTS(
              SELECT 1 FROM assessments a LEFT JOIN assessment_categories ac ON ac.id=a.category_id
              WHERE a.organisation_id=$1 AND a.classroom_id=$2 AND a.term_id=$3 AND a.subject_id=cs.subject_id
                AND COALESCE(ac.code,upper(a.assessment_type))='EXAM'
            )
            OR EXISTS(
              SELECT 1 FROM assessments a
              WHERE a.organisation_id=$1 AND a.classroom_id=$2 AND a.term_id=$3 AND a.subject_id=cs.subject_id
                AND NOT EXISTS(SELECT 1 FROM assessment_scores sc WHERE sc.assessment_id=a.id AND sc.student_id=s.id)
            )
          )
      ) incomplete_subjects
    FROM enrolments e
    JOIN students s ON s.id=e.student_id
    LEFT JOIN report_comments rc ON rc.organisation_id=e.organisation_id AND rc.student_id=s.id AND rc.term_id=$3
    LEFT JOIN LATERAL (
      SELECT gx.id,gx.first_name,gx.last_name,gx.email,gx.phone
      FROM student_guardians sg JOIN guardians gx ON gx.id=sg.guardian_id
      WHERE sg.student_id=s.id ORDER BY sg.is_primary DESC,gx.created_at LIMIT 1
    ) g ON true
    WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.academic_year_id=$4 AND e.status='active' AND s.status='active'
    ORDER BY s.last_name,s.first_name
  `,[organisationId,classroomId,termId,term.academic_year_id])).rows.map((row:any)=>({
    ...row,
    assessment_ready:Number(row.required_subjects)>0&&Number(row.incomplete_subjects)===0
  }));
  return{term,classroom,rows};
}

async function classReportReadinessDetails(organisationId:string,classroomId:string,termId:string){
  const pool=await classReportPool(organisationId,classroomId,termId);
  const assignments=(await db.query(`
    SELECT ta.subject_id,ta.teacher_os_user_id,s.name subject_name
    FROM teacher_assignments ta
    JOIN subjects s ON s.id=ta.subject_id
    WHERE ta.organisation_id=$1
      AND ta.classroom_id=$2
      AND ta.academic_year_id=$3
      AND ta.is_active=true
      AND ta.subject_id IS NOT NULL
      AND (ta.term_id=$4 OR ta.term_id IS NULL)
    ORDER BY s.name,ta.created_at
  `,[organisationId,classroomId,pool.term.academic_year_id,termId])).rows;
  const users=await fetchCoreUsers(organisationId);
  const userMap=new Map(users.map((u:any)=>[u.id,u]));
  const teachersBySubject=new Map<string,any[]>();
  for(const a of assignments){
    const u:any=userMap.get(a.teacher_os_user_id);
    const list=teachersBySubject.get(a.subject_id)||[];
    if(!list.some((x:any)=>x.id===a.teacher_os_user_id)){
      list.push({
        id:a.teacher_os_user_id,
        name:u?(u.first_name+' '+u.last_name):a.teacher_os_user_id,
        email:u?.email??null
      });
    }
    teachersBySubject.set(a.subject_id,list);
  }

  const grouped=new Map<string,any>();
  for(const row of pool.rows.filter((x:any)=>!x.assessment_ready)){
    const readiness=await reportAssessmentReadiness(organisationId,row.student_id,termId,classroomId);
    for(const missing of readiness.missing){
      let subject=grouped.get(missing.subjectId);
      if(!subject){
        subject={
          subjectId:missing.subjectId,
          subjectName:missing.subjectName,
          teachers:teachersBySubject.get(missing.subjectId)||[],
          students:[]
        };
        grouped.set(missing.subjectId,subject);
      }
      subject.students.push({
        studentId:row.student_id,
        admissionNo:row.admission_no,
        studentName:row.first_name+' '+row.last_name,
        issues:missing.missing
      });
    }
  }

  const subjects=[...grouped.values()].sort((a:any,b:any)=>String(a.subjectName).localeCompare(String(b.subjectName)));
  return{
    term:pool.term,
    classroom:pool.classroom,
    summary:{
      students:pool.rows.length,
      readyStudents:pool.rows.filter((x:any)=>x.assessment_ready).length,
      incompleteStudents:pool.rows.filter((x:any)=>!x.assessment_ready).length,
      affectedSubjects:subjects.length
    },
    subjects
  };
}

app.get('/api/teacher/report-pool',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const q=z.object({classroomId:z.string().uuid(),termId:z.string().uuid()}).parse(request.query);
  const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,q.classroomId,q.termId);
  if(a.role!=='school_admin'&&classTeacherId!==a.core.id)throw fail(403,'Only the Class Teacher can open the final report pool for this class');
  const pool=await classReportPool(a.core.organisation_id,q.classroomId,q.termId);
  return{
    ...pool,
    summary:{
      total:pool.rows.length,
      ready:pool.rows.filter((x:any)=>x.assessment_ready).length,
      missingGrades:pool.rows.filter((x:any)=>!x.assessment_ready).length,
      approved:pool.rows.filter((x:any)=>x.workflow_status==='approved').length,
      released:pool.rows.filter((x:any)=>Boolean(x.released_at)).length,
      missingGuardianEmail:pool.rows.filter((x:any)=>!x.guardian_email).length
    }
  };
});

app.get('/api/teacher/report-pool/readiness',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const q=z.object({classroomId:z.string().uuid(),termId:z.string().uuid()}).parse(request.query);
  const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,q.classroomId,q.termId);
  if(a.role!=='school_admin'&&classTeacherId!==a.core.id)throw fail(403,'Only the Class Teacher can review missing report grades for this class');
  return classReportReadinessDetails(a.core.organisation_id,q.classroomId,q.termId);
});

app.post('/api/teacher/report-pool/remind-missing',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  const b=z.object({classroomId:z.string().uuid(),termId:z.string().uuid()}).parse(request.body);
  const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,b.classroomId,b.termId);
  if(a.role!=='school_admin'&&classTeacherId!==a.core.id)throw fail(403,'Only the Class Teacher can remind teachers about missing grades for this class');

  const readiness=await classReportReadinessDetails(a.core.organisation_id,b.classroomId,b.termId);
  const results:any[]=[];
  for(const subject of readiness.subjects){
    const students=subject.students.slice(0,40).map((x:any)=>x.admissionNo+' '+x.studentName+': '+x.issues.join('; '));
    const bodyText=[
      'Assessment grades are incomplete for '+readiness.classroom.name+' - '+subject.subjectName+'.',
      '',
      ...students,
      '',
      'Please enter the missing assessment scores in Revolt-X School. Report cards remain locked until all required grades are complete.'
    ].join('\n');

    if(!subject.teachers.length){
      results.push({subjectId:subject.subjectId,subjectName:subject.subjectName,status:'no_teacher_assigned'});
      continue;
    }

    for(const teacher of subject.teachers){
      if(!teacher.email){
        results.push({subjectId:subject.subjectId,subjectName:subject.subjectName,teacherId:teacher.id,teacherName:teacher.name,status:'missing_email'});
        continue;
      }
      const delivery=await deliverCommunication({
        organisationId:a.core.organisation_id,
        actorOsUserId:a.core.id,
        channel:'email',
        recipientName:teacher.name,
        recipientAddress:teacher.email,
        subject:'Missing assessment grades - '+readiness.classroom.name+' / '+subject.subjectName,
        body:bodyText,
        templateKey:'assessment.missing_scores',
        relatedType:'classroom',
        relatedId:b.classroomId
      });
      results.push({
        subjectId:subject.subjectId,
        subjectName:subject.subjectName,
        teacherId:teacher.id,
        teacherName:teacher.name,
        status:delivery.status
      });
    }
  }

  await audit(a.core.organisation_id,a.core.id,'reports.missing_grades_reminded','classroom',b.classroomId,{
    termId:b.termId,
    affectedSubjects:readiness.subjects.length,
    incompleteStudents:readiness.summary.incompleteStudents,
    deliveries:results
  });
  return{...readiness.summary,results};
});

app.post('/api/teacher/report-pool/release',async request=>{
  const a=await authorize(request,db,config,'reports.release');
  const b=z.object({classroomId:z.string().uuid(),termId:z.string().uuid()}).parse(request.body);
  const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,b.classroomId,b.termId);
  if(a.role!=='school_admin'&&classTeacherId!==a.core.id)throw fail(403,'Only the Class Teacher can release the final report pool for this class');

  const pool=await classReportPool(a.core.organisation_id,b.classroomId,b.termId);
  if(!pool.rows.length)throw fail(409,'There are no active students in this class to release');
  const notApproved=pool.rows.filter((x:any)=>x.workflow_status!=='approved');
  if(notApproved.length)throw fail(409,'All reports must be approved before class release. Pending: '+notApproved.slice(0,8).map((x:any)=>x.admission_no+' '+x.first_name+' '+x.last_name).join(', '));
  const incomplete=pool.rows.filter((x:any)=>!x.assessment_ready);
  if(incomplete.length){
    const details:any[]=[];
    for(const row of incomplete.slice(0,5)){
      const readiness=await reportAssessmentReadiness(a.core.organisation_id,row.student_id,b.termId,b.classroomId);
      details.push(row.admission_no+' '+row.first_name+' '+row.last_name+': '+readiness.missing.map((m:any)=>m.subjectName+' ('+m.missing.join('; ')+')').join(', '));
    }
    throw fail(409,'Reports cannot be released while grades are incomplete. '+details.join(' | '));
  }

  const newlyReleased:any[]=[];
  await tx(db,async client=>{
    for(const row of pool.rows){
      if(row.released_at)continue;
      let decision=row.promotion_decision;
      if(!decision){
        const results=await calculateStudentTermResults(a.core.organisation_id,row.student_id,b.termId);
        const promotion=await reportPromotionInfo(a.core.organisation_id,row.student_id,b.termId,b.classroomId,results);
        decision=promotion.suggestedDecision;
      }
      const updated=await one<any>(client,`UPDATE report_comments
        SET promotion_decision=COALESCE(promotion_decision,$1),
            promotion_basis=COALESCE(promotion_basis,'threshold'),
            released_at=now(),released_by_os_user_id=$2,updated_at=now()
        WHERE organisation_id=$3 AND student_id=$4 AND term_id=$5 AND workflow_status='approved'
        RETURNING *`,[decision,a.core.id,a.core.organisation_id,row.student_id,b.termId]);
      newlyReleased.push({...row,promotion_decision:updated.promotion_decision,released_at:updated.released_at});
    }
  });

  const school=await one<any>(db,'SELECT school_name FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  let communicationCount=0,missingGuardianEmail=0;
  for(const row of newlyReleased){
    if(!row.guardian_email)missingGuardianEmail++;
    if(!row.guardian_id)continue;
    const results=await notifyContact({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:row.guardian_id,eventKey:'reports.released',
      name:((row.guardian_first_name||'')+' '+(row.guardian_last_name||'')).trim(),
      email:row.guardian_email,phone:row.guardian_phone,
      subject:'Report card available - '+row.first_name+' '+row.last_name,
      body:`${school.school_name} has released the report card for ${row.first_name} ${row.last_name} (${row.admission_no}) to the Parent Portal. Promotion outcome: ${String(row.promotion_decision||'pending').replace('_',' ')}.`,
      relatedType:'report_comment',relatedId:row.report_id
    });
    communicationCount+=results.length;
  }
  await audit(a.core.organisation_id,a.core.id,'reports.class_released','classroom',b.classroomId,{
    termId:b.termId,released:newlyReleased.length,communications:communicationCount,missingGuardianEmail
  });
  return{
    released:newlyReleased.length,
    alreadyReleased:pool.rows.length-newlyReleased.length,
    communications:communicationCount,
    missingGuardianEmail,
    students:newlyReleased.map((x:any)=>({studentId:x.student_id,admissionNo:x.admission_no,promotionDecision:x.promotion_decision}))
  };
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
    returnNote:z.string().max(2000).nullable().optional()
  }).parse(request.body);
  const report=await one<any>(db,'SELECT * FROM report_comments WHERE organisation_id=$1 AND student_id=$2 AND term_id=$3',[a.core.organisation_id,studentId,b.termId]);
  if(report.workflow_status!=='submitted')throw fail(409,'Only submitted reports can be reviewed');
  const term=await one<any>(db,'SELECT * FROM terms WHERE id=$1',[b.termId]);
  const current=await one<any>(db,`SELECT c.id classroom_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 ORDER BY e.enrolled_at DESC LIMIT 1`,[studentId,term.academic_year_id]);
  const classTeacherId=await effectiveClassTeacher(a.core.organisation_id,current.classroom_id,b.termId);
  if(classTeacherId===a.core.id&&a.role!=='school_admin')throw fail(403,'The Class Teacher cannot approve their own report');
  if(a.role!=='school_admin'&&a.role!=='headteacher'){
    const assignment=await maybeOne<any>(db,'SELECT 1 FROM report_reviewer_assignments WHERE organisation_id=$1 AND classroom_id=$2 AND reviewer_os_user_id=$3 AND is_active=true',[a.core.organisation_id,current.classroom_id,a.core.id]);
    if(!assignment)throw fail(403,'You are not assigned to review reports for this class');
  }
  if(b.action==='return'&&!b.returnNote)throw fail(400,'Give the class teacher a reason for returning the report');

  if(b.action==='approve'){
    const readiness=await reportAssessmentReadiness(a.core.organisation_id,studentId,b.termId,current.classroom_id);
    if(!readiness.complete){
      const detail=readiness.missing.slice(0,8).map((x:any)=>x.subjectName+' – '+x.missing.join('; ')).join(' | ');
      throw fail(409,'This report cannot be approved because grades are incomplete. '+detail);
    }
    if(!report.promotion_decision)throw fail(409,'The Class Teacher must set a promotion decision before approval');
  }

  const status=b.action==='approve'?'approved':'returned';
  const updated=status==='approved'
    ?await one<any>(db,`UPDATE report_comments SET workflow_status='approved',headteacher_comment=$1::text,
        next_term_begins=$2::date,return_note=NULL,reviewed_by_os_user_id=$3::uuid,reviewed_at=now(),
        released_at=NULL,released_by_os_user_id=NULL,updated_at=now()
      WHERE id=$4::uuid RETURNING *`,[b.headteacherComment??null,term.next_term_begins??null,a.core.id,report.id])
    :await one<any>(db,`UPDATE report_comments SET workflow_status='returned',next_term_begins=$1::date,
        return_note=$2::text,reviewed_by_os_user_id=$3::uuid,reviewed_at=now(),
        released_at=NULL,released_by_os_user_id=NULL,updated_at=now()
      WHERE id=$4::uuid RETURNING *`,[term.next_term_begins??null,b.returnNote??null,a.core.id,report.id]);

  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1',[studentId]);
  if(status==='returned'&&classTeacherId){
    const coreUsers=await fetchCoreUsers(a.core.organisation_id);
    const teacher=coreUsers.find((u:any)=>u.id===classTeacherId);
    if(teacher?.email){
      await notifyContact({
        organisationId:a.core.organisation_id,actorOsUserId:a.core.id,eventKey:'reports.returned',
        name:(teacher.first_name+' '+teacher.last_name).trim(),email:teacher.email,phone:null,
        subject:'Report card returned for correction',
        body:`The report card for ${student.first_name} ${student.last_name} has been returned for correction. Reviewer note: ${b.returnNote||''}`,
        relatedType:'report_comment',relatedId:report.id
      });
    }
  }
  await audit(a.core.organisation_id,a.core.id,'report.'+status,'report_comment',report.id,{
    studentId,termId:b.termId,released:false
  });
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
  const rawStudents=(await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,s.status,
      e.id enrolment_id,c.name classroom_name,g.name grade_name
    FROM enrolments e JOIN students s ON s.id=e.student_id JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE e.organisation_id=$1 AND e.academic_year_id=$2 AND e.classroom_id=$3 AND e.status='active'
    ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,q.fromAcademicYearId,q.classroomId])).rows;
  const evidence=await academicYearPromotionEvidence(db,a.core.organisation_id,q.fromAcademicYearId,q.classroomId);
  const students=rawStudents.map((row:any)=>{
    const ev=evidence.byStudent.get(row.id)||{configuredTerms:evidence.terms.length,completeTerms:0,readyTerms:0,annualAverage:null,termAverages:[],ready:false,reason:'Academic results are not complete',threshold:evidence.threshold};
    let recommendedOutcome='repeated';
    if(ev.ready&&Number(ev.annualAverage)>=evidence.threshold)recommendedOutcome=nextGrade?'promoted':'completed';
    return{...row,...ev,recommended_outcome:recommendedOutcome};
  });
  return{
    classroom,nextGrade,terms:evidence.terms,threshold:evidence.threshold,
    defaultOutcome:nextGrade?'promoted':'completed',
    destinations,repeatDestinations,students
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
    const evidence=await academicYearPromotionEvidence(client,a.core.organisation_id,b.fromAcademicYearId,b.fromClassroomId??null);
    if(evidence.terms.length!==3)throw fail(409,'Promotion requires three configured terms in the source academic year');
    let processed=0,promoted=0,repeated=0,completed=0;
    for(const r of b.records){
      const old=await maybeOne<any>(client,`SELECT e.*,c.grade_level_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
        WHERE e.student_id=$1 AND e.academic_year_id=$2 AND e.organisation_id=$3 AND e.status='active' FOR UPDATE`,
        [r.studentId,b.fromAcademicYearId,a.core.organisation_id]);
      if(!old)throw fail(409,'One or more selected students no longer have an active enrolment in the source year');
      if(b.fromClassroomId&&old.classroom_id!==b.fromClassroomId)throw fail(409,'A selected student is no longer in the source class');
      const ev=evidence.byStudent.get(r.studentId);
      if(!ev?.ready)throw fail(409,(ev?.reason||'Academic-year promotion evidence is incomplete')+' for one or more selected students');
      const nextGrade=await maybeOne<any>(client,`SELECT id FROM grade_levels WHERE organisation_id=$1 AND is_active=true AND level_order>(
        SELECT g.level_order FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id WHERE c.id=$2
      ) ORDER BY level_order LIMIT 1`,[a.core.organisation_id,old.classroom_id]);
      const recommendedOutcome=Number(ev.annualAverage)>=evidence.threshold?(nextGrade?'promoted':'completed'):'repeated';
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
        await assignMandatoryFees(client,a.core.organisation_id,r.studentId,b.toAcademicYearId,r.toClassroomId!);
        await client.query("UPDATE students SET status='active',updated_at=now() WHERE id=$1",[r.studentId]);
        if(r.outcome==='promoted')promoted++;else repeated++;
      }
      await client.query(`INSERT INTO student_promotions(
        organisation_id,student_id,from_academic_year_id,to_academic_year_id,from_classroom_id,to_classroom_id,
        outcome,processed_by_os_user_id,academic_average,terms_count,promotion_basis
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(student_id,to_academic_year_id)
      DO UPDATE SET from_classroom_id=EXCLUDED.from_classroom_id,to_classroom_id=EXCLUDED.to_classroom_id,
        outcome=EXCLUDED.outcome,processed_by_os_user_id=EXCLUDED.processed_by_os_user_id,
        academic_average=EXCLUDED.academic_average,terms_count=EXCLUDED.terms_count,
        promotion_basis=EXCLUDED.promotion_basis,created_at=now()`,
        [a.core.organisation_id,r.studentId,b.fromAcademicYearId,b.toAcademicYearId,old.classroom_id,r.toClassroomId??null,r.outcome,a.core.id,
          ev.annualAverage,ev.completeTerms,r.outcome===recommendedOutcome?'academic_year_average':'manual_override']);
      processed++;
    }
    await client.query(`UPDATE promotion_batches SET promoted_count=$1,repeated_count=$2,completed_count=$3 WHERE id=$4`,
      [promoted,repeated,completed,batch.id]);
    await audit(a.core.organisation_id,a.core.id,'students.promoted','promotion_batch',batch.id,{processed,promoted,repeated,completed});
    return{batchId:batch.id,processed,promoted,repeated,completed};
  });
});
app.get('/api/promotions',async request=>{const a=await authorize(request,db,config,'reports.view');return (await db.query(`SELECT p.*,s.admission_no,s.first_name,s.last_name,fc.name from_class,tc.name to_class,fy.name from_year,ty.name to_year FROM student_promotions p JOIN students s ON s.id=p.student_id LEFT JOIN classrooms fc ON fc.id=p.from_classroom_id LEFT JOIN classrooms tc ON tc.id=p.to_classroom_id JOIN academic_years fy ON fy.id=p.from_academic_year_id JOIN academic_years ty ON ty.id=p.to_academic_year_id WHERE p.organisation_id=$1 ORDER BY p.created_at DESC`,[a.core.organisation_id])).rows});

app.post('/api/parent/login',async request=>{
  const b=z.object({phone:z.string().trim().min(5).max(60),admissionNo:z.string().trim().min(1).max(60)}).parse(request.body);
  const normalizedPhone=b.phone.replace(/\\D/g,'');
  const identityKey=throttleFingerprint(normalizedPhone+'|'+b.admissionNo.toLowerCase());
  const ipKey=throttleFingerprint(String(request.ip||request.headers['x-forwarded-for']||'unknown'));
  await assertPortalLoginAllowed(db,'parent_identity',identityKey);
  await assertPortalLoginAllowed(db,'parent_ip',ipKey);

  const row=await maybeOne<any>(db,`
    SELECT g.*
    FROM guardians g
    JOIN student_guardians sg ON sg.guardian_id=g.id
    JOIN students s ON s.id=sg.student_id
    WHERE g.organisation_id=s.organisation_id
      AND regexp_replace(g.phone,'\\D','','g')=regexp_replace($1,'\\D','','g')
      AND lower(s.admission_no)=lower($2)
    LIMIT 1`,[b.phone,b.admissionNo]);

  if(!row){
    await Promise.all([
      recordPortalLoginFailure(db,'parent_identity',identityKey,config.PARENT_LOGIN_FAILURE_LIMIT,config.PARENT_LOGIN_BLOCK_MINUTES),
      recordPortalLoginFailure(db,'parent_ip',ipKey,config.PARENT_LOGIN_FAILURE_LIMIT*3,config.PARENT_LOGIN_BLOCK_MINUTES)
    ]);
    throw fail(401,'Invalid parent portal credentials');
  }

  await Promise.all([
    clearPortalLoginThrottle(db,'parent_identity',identityKey),
    clearPortalLoginThrottle(db,'parent_ip',ipKey)
  ]);

  const token=randomBytes(48).toString('base64url');
  await db.query('UPDATE guardian_portal_sessions SET revoked_at=now() WHERE guardian_id=$1 AND revoked_at IS NULL',[row.id]);
  await db.query(`INSERT INTO guardian_portal_sessions(guardian_id,token_hash,expires_at) VALUES($1,$2,now()+interval '8 hours')`,[row.id,hashPortalToken(token)]);
  return{token,expiresIn:28800};
});
app.post('/api/parent/logout',async request=>{const g=await guardianAuth(request);await db.query('UPDATE guardian_portal_sessions SET revoked_at=now() WHERE id=$1',[g.session_id]);return{ok:true}});
app.get('/api/parent/me',async request=>{
  const g=await guardianAuth(request);
  const students=(await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,s.status,c.name classroom_name FROM student_guardians sg JOIN students s ON s.id=sg.student_id LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active' LEFT JOIN classrooms c ON c.id=e.classroom_id WHERE sg.guardian_id=$1 ORDER BY s.first_name,s.last_name`,[g.guardian_id])).rows;
  const school=await one<any>(db,'SELECT school_name,short_name,motto,phone,email,address FROM school_profiles WHERE organisation_id=$1',[g.organisation_id]);
  return{guardian:g,students,school};
});

app.get('/api/parent/alerts',async request=>{
  const g=await guardianAuth(request);
  const rows=(await db.query(`
    SELECT id,event_key,subject,body,related_type,related_id,created_at,read_at
    FROM guardian_notifications
    WHERE organisation_id=$1 AND guardian_id=$2
    ORDER BY created_at DESC
    LIMIT 100
  `,[g.organisation_id,g.guardian_id])).rows;
  return{alerts:rows,unread:rows.filter((x:any)=>!x.read_at).length};
});
app.post('/api/parent/alerts/:id/read',async request=>{
  const g=await guardianAuth(request);
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,`
    UPDATE guardian_notifications
    SET read_at=COALESCE(read_at,now())
    WHERE id=$1 AND organisation_id=$2 AND guardian_id=$3
    RETURNING id,read_at
  `,[id,g.organisation_id,g.guardian_id]);
  return{read:true,readAt:row.read_at};
});
app.get('/api/parent/students/:id/dashboard',async request=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);const student=await ensureGuardianStudent(g.guardian_id,id);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.name classroom_name,g.name grade_name,e.academic_year_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels g ON g.id=c.grade_level_id WHERE e.student_id=$1 AND e.status='active' ORDER BY e.enrolled_at DESC LIMIT 1`,[id]);
  Object.assign(student,current||{});
  const fee=await one<any>(db,`SELECT COALESCE(sum((sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0)),0) outstanding FROM student_fees sf WHERE sf.organisation_id=$1 AND sf.student_id=$2`,[g.organisation_id,id]);
  const attRows=(await db.query('SELECT status,count(*)::int count FROM attendance_records WHERE organisation_id=$1 AND student_id=$2 GROUP BY status',[g.organisation_id,id])).rows;const attendance:any={};for(const x of attRows)attendance[x.status]=x.count;
  const homework=current?(await db.query(`SELECT h.id,h.title,h.instructions,h.due_at,h.status,h.max_score,s.name subject_name,hs.status submission_status,hs.score,hs.teacher_comment FROM homework_assignments h JOIN subjects s ON s.id=h.subject_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$2 WHERE h.organisation_id=$1 AND h.classroom_id=$3 AND h.status='published' ORDER BY h.due_at DESC NULLS LAST LIMIT 20`,[g.organisation_id,id,current.classroom_id])).rows:[];
  const announcements=(await db.query(`SELECT a.title,a.body,a.audience,a.published_at FROM school_announcements a WHERE a.organisation_id=$1 AND a.status='published' AND (a.audience IN('all','parents') OR (a.audience='class' AND a.classroom_id=$2)) ORDER BY a.published_at DESC LIMIT 20`,[g.organisation_id,current?.classroom_id??null])).rows;
  return{student,fees:fee,attendance,homework,announcements};
});
app.get('/api/parent/students/:id/fees',async request=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);await ensureGuardianStudent(g.guardian_id,id);
  const items=(await db.query(`SELECT sf.id,f.name fee_name,(sf.amount_due-sf.discount) due,COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) paid,((sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0)) balance,sf.status FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id LEFT JOIN payments p ON p.student_fee_id=sf.id WHERE sf.organisation_id=$1 AND sf.student_id=$2 GROUP BY sf.id,f.id ORDER BY sf.created_at DESC`,[g.organisation_id,id])).rows;
  const payments=(await db.query('SELECT id,amount,payment_method,reference,paid_at,note FROM payments WHERE organisation_id=$1 AND student_id=$2 AND voided_at IS NULL ORDER BY paid_at DESC',[g.organisation_id,id])).rows;return{items,payments};
});
async function buildGuardianReleasedReport(g:any,id:string){
  const student=await ensureGuardianStudent(g.guardian_id,id);
  const approved=await maybeOne<any>(db,`SELECT rc.*,t.name term_name,t.id term_id,t.academic_year_id
    FROM report_comments rc JOIN terms t ON t.id=rc.term_id
    WHERE rc.organisation_id=$1 AND rc.student_id=$2 AND rc.workflow_status='approved' AND rc.released_at IS NOT NULL
    ORDER BY rc.released_at DESC NULLS LAST,rc.reviewed_at DESC NULLS LAST,rc.updated_at DESC LIMIT 1`,[g.organisation_id,id]);
  if(!approved)return{available:false,term:null,student,subjects:[],comments:null};

  const term=await one<any>(db,`SELECT t.*,y.name academic_year FROM terms t
    JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=$1`,[approved.term_id]);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,c.name classroom_name,gl.name grade_name,c.class_teacher_os_user_id
    FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id JOIN grade_levels gl ON gl.id=c.grade_level_id
    WHERE e.student_id=$1 AND e.academic_year_id=$2 ORDER BY e.enrolled_at DESC LIMIT 1`,[id,term.academic_year_id]);
  Object.assign(student,current||{});
  const subjects=await calculateStudentTermResults(g.organisation_id,id,term.id);

  let overallAverage=subjects.length
    ?Math.round((subjects.filter((x:any)=>x.percentage!=null).reduce((sum:number,x:any)=>sum+Number(x.percentage||0),0)/
      Math.max(1,subjects.filter((x:any)=>x.percentage!=null).length))*100)/100
    :null;
  let classPosition:number|null=null,classSize:number|null=null;
  if(current?.classroom_id){
    const rank=await calculateClassRank(g.organisation_id,current.classroom_id,term.id,id);
    if(rank){overallAverage=Number(rank.average);classPosition=rank.position;classSize=rank.class_size}
  }
  const attRows=(await db.query(`SELECT status,count(*)::int count FROM attendance_records
    WHERE organisation_id=$1 AND student_id=$2 AND attendance_date BETWEEN $3::date AND $4::date GROUP BY status`,
    [g.organisation_id,id,term.start_date,term.end_date])).rows;
  const attendance:any={present:0,absent:0,late:0,excused:0,total:0,rate:0};
  for(const r of attRows){attendance[r.status]=Number(r.count);attendance.total+=Number(r.count)}
  if(attendance.total)attendance.rate=Math.round(((attendance.present+attendance.late+attendance.excused)/attendance.total)*10000)/100;
  const school=await one<any>(db,'SELECT school_name,short_name,motto,phone,email,address FROM school_profiles WHERE organisation_id=$1',[g.organisation_id]);

  return{
    available:true,school,term,student,subjects,comments:approved,
    performance:{overallAverage,classPosition,classSize},
    attendance
  };
}

app.get('/api/parent/students/:id/latest-report',async request=>{
  const g=await guardianAuth(request);
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  return buildGuardianReleasedReport(g,id);
});

app.get('/api/parent/students/:id/report-card.pdf',async(request,reply)=>{
  const g=await guardianAuth(request);
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const report:any=await buildGuardianReleasedReport(g,id);
  if(!report.available)throw fail(404,'No released report card is available');

  const pdf:Buffer=await new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:42,info:{Title:'Student Report Card'}});
    const chunks:Buffer[]=[];
    doc.on('data',(chunk:Buffer)=>chunks.push(chunk));
    doc.on('error',reject);
    doc.on('end',()=>resolve(Buffer.concat(chunks)));

    const school=report.school||{},student=report.student||{},term=report.term||{},
      performance=report.performance||{},attendance=report.attendance||{},comments=report.comments||{};
    const title=school.school_name||'Revolt-X School';
    doc.fontSize(19).font('Helvetica-Bold').text(title,{align:'center'});
    if(school.motto)doc.fontSize(9).font('Helvetica').text(String(school.motto),{align:'center'});
    doc.moveDown(.2).fontSize(8).text([school.address,school.phone,school.email].filter(Boolean).join('  •  '),{align:'center'});
    doc.moveDown(.8).fontSize(15).font('Helvetica-Bold').text('STUDENT REPORT CARD',{align:'center'});
    doc.fontSize(10).font('Helvetica').text((term.academic_year||'')+' • '+(term.name||''),{align:'center'});
    doc.moveDown();

    const fullName=[student.first_name,student.middle_name,student.last_name].filter(Boolean).join(' ');
    const meta=[
      ['Student',fullName],['Student ID',student.admission_no||'—'],
      ['Class',student.classroom_name||'—'],['Grade',student.grade_name||'—'],
      ['Overall Average',performance.overallAverage==null?'—':performance.overallAverage+'%'],
      ['Class Position',performance.classPosition?(performance.classPosition+' / '+performance.classSize):'—'],
      ['Attendance',String(attendance.rate||0)+'%'],['Promotion',String(comments.promotion_decision||'Pending').replace(/_/g,' ')]
    ];
    meta.forEach(([label,value])=>{
      doc.fontSize(8).fillColor('#667780').text(label,{continued:true,width:120});
      doc.fillColor('#172027').font('Helvetica-Bold').text('  '+value).font('Helvetica');
    });
    doc.moveDown(.7).fillColor('#172027').fontSize(11).font('Helvetica-Bold').text('Academic Performance');
    doc.moveDown(.2);
    const widths=[180,95,95,70];
    const headers=['Subject','Class Assessment','Exam','Total'];
    let x=doc.x,y=doc.y;
    doc.fontSize(8).font('Helvetica-Bold');
    headers.forEach((h,i)=>doc.text(h,x+widths.slice(0,i).reduce((a,b)=>a+b,0),y,{width:widths[i]}));
    y+=16;doc.moveTo(x,y-3).lineTo(x+widths.reduce((a,b)=>a+b,0),y-3).strokeColor('#cccccc').stroke();
    doc.font('Helvetica');
    for(const row of report.subjects||[]){
      if(y>720){doc.addPage();y=48}
      const vals=[row.subject_name||'',row.class_assessment_score==null?'—':row.class_assessment_score+' / 30',row.exam_score==null?'—':row.exam_score+' / 70',row.total==null?'—':row.total+'%'];
      vals.forEach((v,i)=>doc.text(String(v),x+widths.slice(0,i).reduce((a,b)=>a+b,0),y,{width:widths[i]}));
      y+=15;
    }
    doc.y=y+8;
    doc.fontSize(10).font('Helvetica-Bold').text('Attendance Summary');
    doc.fontSize(9).font('Helvetica').text('Present: '+(attendance.present||0)+'   Absent: '+(attendance.absent||0)+'   Late: '+(attendance.late||0)+'   Excused: '+(attendance.excused||0));
    doc.moveDown(.7).font('Helvetica-Bold').text('Class Teacher Remark');
    doc.font('Helvetica').text(comments.class_teacher_comment||'—');
    doc.moveDown(.5).font('Helvetica-Bold').text('Headteacher Remark');
    doc.font('Helvetica').text(comments.headteacher_comment||'—');
    doc.moveDown(.7).fontSize(8).fillColor('#667780').text('Official report released by the school through Revolt-X School. Generated '+new Date().toLocaleString()+'.',{align:'center'});
    doc.end();
  });
  const safeName=String(report.student.admission_no||'student').replace(/[^A-Za-z0-9_-]/g,'_');
  return reply.header('content-type','application/pdf')
    .header('content-disposition','attachment; filename="report-card-'+safeName+'.pdf"')
    .header('cache-control','private, no-store')
    .send(pdf);
});

app.get('/api/payments/:id/receipt',async request=>{
  const a=await authorize(request,db,config,'fees.view');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const payment=await one<any>(db,`SELECT p.*,s.admission_no,s.first_name,s.middle_name,s.last_name,f.name fee_name,
      sp.school_name,sp.short_name,sp.motto,sp.phone school_phone,sp.email school_email,sp.address school_address,sp.currency,sp.logo_url,
      fr.receipt_no finance_receipt_no,fr.reference finance_reference,je.entry_no journal_entry_no
    FROM payments p JOIN students s ON s.id=p.student_id
    LEFT JOIN student_fees sf ON sf.id=p.student_fee_id LEFT JOIN fee_items f ON f.id=sf.fee_item_id
    JOIN school_profiles sp ON sp.organisation_id=p.organisation_id
    LEFT JOIN finance_student_receipts fr ON fr.id=p.finance_receipt_id
    LEFT JOIN finance_journal_entries je ON je.id=fr.journal_entry_id
    WHERE p.id=$1 AND p.organisation_id=$2`,[id,a.core.organisation_id]);return payment;
});


app.get('/api/teacher/context',async request=>{
  const a=await authorize(request,db,config);
  await ensureTeachingRole(a);
  const school=await one<any>(db,'SELECT * FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
  const roleProfile=await schoolRoleProfile(db,a.core.organisation_id,a.role);
  if(!roleProfile?.can_teach)throw fail(403,'Teacher workspace access is not enabled for this role');
  const capabilities=await effectiveCapabilities(db,a.core.organisation_id,a.role);
  return{core:a.core,schoolRole:a.role,roleProfile,school,capabilities};
});
app.get('/api/teacher/classes',async request=>{
  const a=await authorize(request,db,config,'academic.view');
  await ensureTeachingRole(a);
  const term=await activeTerm(a.core.organisation_id);
  return (await db.query(`
    WITH effective_class_teacher AS (
      SELECT c.id classroom_id,COALESCE(
        (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
         WHERE ta.organisation_id=c.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true
           AND ta.term_id IS NOT DISTINCT FROM $3::uuid ORDER BY ta.created_at DESC LIMIT 1),
        (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
         WHERE ta.organisation_id=c.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true AND ta.term_id IS NULL
           ORDER BY ta.created_at DESC LIMIT 1),
        c.class_teacher_os_user_id
      ) teacher_os_user_id
      FROM classrooms c WHERE c.organisation_id=$1 AND c.is_active=true
    ),
    teaching_scope AS (
      SELECT c.id classroom_id,NULL::uuid subject_id,'class_teacher'::text assignment_type,true is_class_teacher
      FROM classrooms c
      JOIN effective_class_teacher ect ON ect.classroom_id=c.id AND ect.teacher_os_user_id=$2
      WHERE c.organisation_id=$1 AND c.is_active=true
      UNION ALL
      SELECT ta.classroom_id,ta.subject_id,'subject_teacher'::text assignment_type,false is_class_teacher
      FROM teacher_assignments ta
      WHERE ta.organisation_id=$1 AND ta.teacher_os_user_id=$2 AND ta.is_active=true AND ta.subject_id IS NOT NULL
        AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $3::uuid)
    )
    SELECT DISTINCT c.id classroom_id,c.name classroom_name,g.name grade_name,ts.subject_id,s.name subject_name,
      ts.assignment_type,ts.is_class_teacher,
      (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=c.id AND e.status='active') student_count
    FROM teaching_scope ts
    JOIN classrooms c ON c.id=ts.classroom_id
    JOIN grade_levels g ON g.id=c.grade_level_id
    LEFT JOIN subjects s ON s.id=ts.subject_id
    WHERE c.organisation_id=$1 AND c.is_active=true
    ORDER BY c.name,ts.is_class_teacher DESC,s.name NULLS FIRST`,[a.core.organisation_id,a.core.id,term?.id??null])).rows;
});
app.get('/api/teacher/students',async request=>{
  const a=await authorize(request,db,config,'students.view');
  await ensureTeachingRole(a);
  const term=await activeTerm(a.core.organisation_id);
  return (await db.query(`
    WITH effective_class_teacher AS (
      SELECT c.id classroom_id,COALESCE(
        (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
         WHERE ta.organisation_id=c.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true
           AND ta.term_id IS NOT DISTINCT FROM $3::uuid ORDER BY ta.created_at DESC LIMIT 1),
        (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
         WHERE ta.organisation_id=c.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true AND ta.term_id IS NULL
           ORDER BY ta.created_at DESC LIMIT 1),
        c.class_teacher_os_user_id
      ) teacher_os_user_id
      FROM classrooms c WHERE c.organisation_id=$1 AND c.is_active=true
    ),
    scoped_classes AS (
      SELECT ect.classroom_id FROM effective_class_teacher ect WHERE ect.teacher_os_user_id=$2
      UNION
      SELECT ta.classroom_id FROM teacher_assignments ta
      WHERE ta.organisation_id=$1 AND ta.teacher_os_user_id=$2 AND ta.is_active=true
        AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $3::uuid)
    )
    SELECT DISTINCT s.id,s.admission_no,s.first_name,s.last_name,s.status,c.id classroom_id,c.name classroom_name,g.name grade_name,
      (ect.teacher_os_user_id=$2) is_class_teacher
    FROM scoped_classes sc
    JOIN enrolments e ON e.classroom_id=sc.classroom_id AND e.status='active'
    JOIN students s ON s.id=e.student_id
    JOIN classrooms c ON c.id=e.classroom_id
    JOIN effective_class_teacher ect ON ect.classroom_id=c.id
    JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE e.organisation_id=$1
    ORDER BY c.name,s.last_name,s.first_name`,[a.core.organisation_id,a.core.id,term?.id??null])).rows;
});
app.get('/api/teacher/dashboard',async request=>{
  const a=await authorize(request,db,config,'reports.view');
  await ensureTeachingRole(a);
  const term=await activeTerm(a.core.organisation_id);
  const scope=await db.query(`
    WITH effective_class_teacher AS (
      SELECT c.id classroom_id,COALESCE(
        (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
         WHERE ta.organisation_id=c.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true
           AND ta.term_id IS NOT DISTINCT FROM $3::uuid ORDER BY ta.created_at DESC LIMIT 1),
        (SELECT ta.teacher_os_user_id FROM teacher_assignments ta
         WHERE ta.organisation_id=c.organisation_id AND ta.classroom_id=c.id AND ta.subject_id IS NULL AND ta.is_active=true AND ta.term_id IS NULL
           ORDER BY ta.created_at DESC LIMIT 1),
        c.class_teacher_os_user_id
      ) teacher_os_user_id
      FROM classrooms c WHERE c.organisation_id=$1 AND c.is_active=true
    ),
    assignments AS (
      SELECT ect.classroom_id,NULL::uuid subject_id,true is_class_teacher
      FROM effective_class_teacher ect WHERE ect.teacher_os_user_id=$2
      UNION ALL
      SELECT ta.classroom_id,ta.subject_id,false
      FROM teacher_assignments ta
      WHERE ta.organisation_id=$1 AND ta.teacher_os_user_id=$2 AND ta.is_active=true AND ta.subject_id IS NOT NULL
        AND (ta.term_id IS NULL OR ta.term_id IS NOT DISTINCT FROM $3::uuid)
    )
    SELECT count(DISTINCT classroom_id)::int assigned_classes,
      count(DISTINCT subject_id) FILTER(WHERE subject_id IS NOT NULL)::int subject_assignments,
      count(DISTINCT classroom_id) FILTER(WHERE is_class_teacher)::int class_teacher_classes,
      array_agg(DISTINCT classroom_id) classroom_ids
    FROM assignments`,[a.core.organisation_id,a.core.id,term?.id??null]);
  const row=scope.rows[0]||{};
  const classIds=(row.classroom_ids||[]).filter(Boolean);
  if(!classIds.length)return{assignedClasses:0,subjectAssignments:0,classTeacherClasses:0,students:0,homework:0,assessments:0,presentToday:0,absentToday:0,term};
  const q=await db.query(`SELECT
    (SELECT count(DISTINCT e.student_id)::int FROM enrolments e WHERE e.classroom_id=ANY($1::uuid[]) AND e.status='active') students,
    (SELECT count(*)::int FROM homework_assignments h WHERE h.teacher_os_user_id=$3 AND h.status<>'closed') homework,
    (SELECT count(*)::int FROM assessments ass WHERE ass.teacher_os_user_id=$3 AND ($2::uuid IS NULL OR ass.term_id=$2)) assessments,
    (SELECT count(*)::int FROM attendance_records ar WHERE ar.classroom_id=ANY($1::uuid[]) AND ar.attendance_date=current_date AND ar.status='present') present_today,
    (SELECT count(*)::int FROM attendance_records ar WHERE ar.classroom_id=ANY($1::uuid[]) AND ar.attendance_date=current_date AND ar.status='absent') absent_today`,
    [classIds,term?.id??null,a.core.id]);
  return{
    assignedClasses:Number(row.assigned_classes||0),
    subjectAssignments:Number(row.subject_assignments||0),
    classTeacherClasses:Number(row.class_teacher_classes||0),
    students:q.rows[0]?.students??0,homework:q.rows[0]?.homework??0,assessments:q.rows[0]?.assessments??0,
    presentToday:q.rows[0]?.present_today??0,absentToday:q.rows[0]?.absent_today??0,term
  };
});

function testAccessCookieValue(request:any){
  const cookie=String(request.headers?.cookie||'').split(';').map((x:string)=>x.trim()).find((x:string)=>x.startsWith('rx_test_access='));
  return cookie?decodeURIComponent(cookie.slice('rx_test_access='.length)):'';
}
function verifyTestAccessCookie(request:any){
  if(!config.ENABLE_TEST_PORTAL_ACCESS||!config.TEST_ACCESS_PASSWORD)return false;
  const value=testAccessCookieValue(request);
  const [expRaw,sig]=value.split('.');
  const exp=Number(expRaw);
  if(!exp||!sig||Date.now()>exp)return false;
  const expected=createHmac('sha256',config.TEST_ACCESS_PASSWORD).update('revolt-x-school-demo|'+expRaw).digest('base64url');
  const a=Buffer.from(expected),b=Buffer.from(sig);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function requireTestAccess(request:any){
  if(!config.ENABLE_TEST_PORTAL_ACCESS)throw fail(404,'Test access is disabled');
  if(!config.TEST_ACCESS_PASSWORD)throw fail(503,'Test access password is not configured');
  if(!verifyTestAccessCookie(request))throw fail(401,'Demo access password required');
}
app.get('/api/test-access/status',async request=>{
  return{enabled:config.ENABLE_TEST_PORTAL_ACCESS,unlocked:verifyTestAccessCookie(request)};
});
app.post('/api/test-access/unlock',async(request,reply)=>{
  if(!config.ENABLE_TEST_PORTAL_ACCESS)throw fail(404,'Test access is disabled');
  if(!config.TEST_ACCESS_PASSWORD)throw fail(503,'Test access password is not configured');
  const b=z.object({password:z.string().min(1).max(200)}).parse(request.body);
  const expected=Buffer.from(config.TEST_ACCESS_PASSWORD),provided=Buffer.from(b.password);
  if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw fail(401,'Invalid demo access password');
  const exp=Date.now()+8*60*60*1000;
  const sig=createHmac('sha256',config.TEST_ACCESS_PASSWORD).update('revolt-x-school-demo|'+String(exp)).digest('base64url');
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  reply.header('set-cookie','rx_test_access='+encodeURIComponent(String(exp)+'.'+sig)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(8*60*60)+secure);
  return{unlocked:true,expiresIn:28800};
});
app.post('/api/test-access/lock',async(_request,reply)=>{
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  reply.header('set-cookie','rx_test_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+secure);
  return{unlocked:false};
});
app.get('/api/test-access/students',async request=>{
  requireTestAccess(request);
  const school=await one<any>(db,'SELECT organisation_id FROM school_profiles ORDER BY created_at LIMIT 1');
  return (await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,c.name classroom_name,g.name grade_name
    FROM students s
    LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active'
    LEFT JOIN classrooms c ON c.id=e.classroom_id
    LEFT JOIN grade_levels g ON g.id=c.grade_level_id
    WHERE s.organisation_id=$1 AND s.status='active'
    ORDER BY c.name NULLS LAST,s.last_name,s.first_name`,[school.organisation_id])).rows;
});
app.post('/api/test-access/student-login',async request=>{
  requireTestAccess(request);
  const b=z.object({studentId:z.string().uuid()}).parse(request.body);
  const student=await one<any>(db,'SELECT * FROM students WHERE id=$1 AND status=\'active\'',[b.studentId]);
  const token=randomBytes(48).toString('base64url');
  await db.query(`INSERT INTO student_portal_sessions(student_id,token_hash,expires_at)
    VALUES($1,$2,now()+interval '8 hours')`,[student.id,hashPortalToken(token)]);
  return{token,expiresIn:28800,testAccess:true};
});
async function testStaffDirectory(portalMode?:'teacher'|'admin'){
  const school=await one<any>(db,'SELECT organisation_id FROM school_profiles ORDER BY created_at LIMIT 1');
  const memberships=(await db.query(`SELECT sm.os_user_id,sm.role,sr.name role_name,sr.portal_mode,sr.can_teach
    FROM school_memberships sm
    JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 AND sm.status='active' AND sr.is_active=true
      AND ($2::text IS NULL OR sr.portal_mode=$2)
    ORDER BY CASE sm.role WHEN 'school_admin' THEN 1 WHEN 'headteacher' THEN 2 WHEN 'teacher' THEN 3 ELSE 4 END,sr.name,sm.created_at`,
    [school.organisation_id,portalMode??null])).rows;
  const users=await fetchCoreUsers(school.organisation_id);
  return memberships.map((m:any)=>{
    const u=users.find((x:any)=>x.id===m.os_user_id)||{};
    return{
      id:m.os_user_id,role:m.role,role_name:m.role_name,portal_mode:m.portal_mode,can_teach:m.can_teach,email:u.email||'',
      first_name:u.first_name||(m.role==='headteacher'?'Headteacher':m.role==='school_admin'?'Administrator':'Demo'),
      last_name:u.last_name||'User',job_title:u.job_title||m.role_name||m.role.replace('_',' ')
    };
  });
}
function roleWorkspace(profile:any){
  return profile?.portal_mode==='teacher'?'/teacher':'/';
}
async function createTestStaffLogin(request:any,reply:any,requiredPortalMode?:'teacher'|'admin'){
  requireTestAccess(request);
  const b=z.object({osUserId:z.string().uuid()}).parse(request.body);
  const school=await one<any>(db,'SELECT organisation_id,school_name FROM school_profiles ORDER BY created_at LIMIT 1');
  const membership=await one<any>(db,`SELECT sm.*,sr.name role_name,sr.portal_mode,sr.can_teach,sr.is_active
    FROM school_memberships sm
    JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 AND sm.os_user_id=$2 AND sm.status='active' AND sr.is_active=true
      AND ($3::text IS NULL OR sr.portal_mode=$3)`,
    [school.organisation_id,b.osUserId,requiredPortalMode??null]);
  const users=await fetchCoreUsers(school.organisation_id);
  const u=users.find((x:any)=>x.id===b.osUserId)||{};
  const coreContext={
    id:b.osUserId,
    email:u.email||('test-'+b.osUserId+'@revolt-x.local'),
    first_name:u.first_name||'Demo',
    last_name:u.last_name||'User',
    status:'active',
    membership_id:'test-'+b.osUserId,
    membership_status:'active',
    organisation_id:school.organisation_id,
    organisation_name:school.school_name,
    organisation_slug:'revolt-x-school-test',
    sessionId:'test-'+randomBytes(8).toString('hex'),
    permissions:[],
    preview:true
  };
  const session=await createSchoolStaffSession(coreContext,'preview');
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  reply.header('set-cookie','rx_school_session='+encodeURIComponent(session.localToken)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(8*60*60)+secure);
  await audit(school.organisation_id,b.osUserId,'staff.test_authenticated','school_session',null,{role:membership.role,portalMode:membership.portal_mode});
  return reply.send({
    accessToken:session.localToken,expiresIn:28800,schoolRole:membership.role,
    roleProfile:{key:membership.role,name:membership.role_name,portal_mode:membership.portal_mode,can_teach:membership.can_teach},
    redirectTo:roleWorkspace(membership),testAccess:true,
    user:{id:b.osUserId,firstName:coreContext.first_name,lastName:coreContext.last_name,email:coreContext.email}
  });
}
app.get('/api/test-access/teachers',async request=>{
  requireTestAccess(request);
  return testStaffDirectory('teacher');
});
app.post('/api/test-access/teacher-login',async(request,reply)=>{
  return createTestStaffLogin(request,reply,'teacher');
});
app.get('/api/test-access/staff',async request=>{
  requireTestAccess(request);
  return testStaffDirectory();
});
app.post('/api/test-access/staff-login',async(request,reply)=>{
  return createTestStaffLogin(request,reply);
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
  const homework=current?(await db.query(`SELECT h.id,h.title,h.instructions,h.due_at,h.status,h.max_score,sub.name subject_name,hs.status submission_status,hs.score,hs.teacher_comment FROM homework_assignments h JOIN subjects sub ON sub.id=h.subject_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$2 WHERE h.organisation_id=$1 AND h.classroom_id=$3 AND h.status='published' ORDER BY h.due_at DESC NULLS LAST LIMIT 30`,[s.organisation_id,s.student_id,current.classroom_id])).rows:[];
  const timetable=current?(await db.query(`SELECT tt.*,sub.name subject_name FROM timetable_entries tt JOIN subjects sub ON sub.id=tt.subject_id WHERE tt.organisation_id=$1 AND tt.classroom_id=$2 ORDER BY tt.day_of_week,tt.start_time`,[s.organisation_id,current.classroom_id])).rows:[];
  const announcements=(await db.query(`SELECT title,body,published_at FROM school_announcements WHERE organisation_id=$1 AND status='published' AND (audience IN('all','students') OR (audience='class' AND classroom_id=$2)) ORDER BY published_at DESC LIMIT 30`,[s.organisation_id,current?.classroom_id??null])).rows;
  return{student,school,attendance,homework,timetable,announcements};
});
app.get('/api/student/latest-report',async request=>{
  const s=await studentAuth(request);
  const approved=await maybeOne<any>(db,`SELECT rc.*,t.id term_id FROM report_comments rc
    JOIN terms t ON t.id=rc.term_id
    WHERE rc.organisation_id=$1 AND rc.student_id=$2 AND rc.workflow_status='approved' AND rc.released_at IS NOT NULL
    ORDER BY rc.released_at DESC NULLS LAST,rc.reviewed_at DESC NULLS LAST,rc.updated_at DESC LIMIT 1`,[s.organisation_id,s.student_id]);
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
  const school=await one<any>(db,'SELECT school_name,email FROM school_profiles WHERE organisation_id=$1',[input.organisationId]);
  await notifyContact({
    organisationId:input.organisationId,actorOsUserId:input.actorOsUserId,eventKey:'admission.received',
    name:b.guardianFirstName+' '+b.guardianLastName,email:b.guardianEmail??null,phone:b.guardianPhone,
    subject:'Admission application received',
    body:`${school.school_name} has received the admission application for ${b.firstName} ${b.lastName}. Application number: ${applicationNo}. You can use this number and the guardian phone number to check the status.`,
    relatedType:'admission_application',relatedId:row.id
  });
  if(input.source==='external'&&school.email){
    await deliverCommunication({
      organisationId:input.organisationId,actorOsUserId:input.actorOsUserId,channel:'email',
      recipientName:school.school_name,recipientAddress:school.email,
      subject:'New admission application '+applicationNo,
      body:`A new external admission application has been received for ${b.firstName} ${b.lastName}, requesting ${b.requestedGradeCode}. Guardian: ${b.guardianFirstName} ${b.guardianLastName}, ${b.guardianPhone}. Open Revolt-X School Admissions to review the complete record.`,
      templateKey:'admission.received.internal',relatedType:'admission_application',relatedId:row.id
    });
  }
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
  const q=z.object({applicationNo:z.string().trim().min(1).max(40)}).parse(request.query);
  const row=await maybeOne<any>(db,`SELECT id,application_no,status,submitted_at,updated_at
    FROM admission_applications WHERE upper(application_no)=upper($1)`,[q.applicationNo]);
  if(!row)throw fail(404,'Application reference not found');
  const history=(await db.query(`SELECT new_status,created_at FROM admission_status_history
    WHERE application_id=$1 ORDER BY created_at`,[row.id])).rows;
  return{applicationNo:row.application_no,status:row.status,submittedAt:row.submitted_at,updatedAt:row.updated_at,history};
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
    const feesAssigned=await assignMandatoryFees(client,a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id);
    await client.query(`UPDATE admission_applications SET status='enrolled',student_id=$1,reviewed_by_os_user_id=$2,reviewed_at=now(),updated_at=now()
      WHERE id=$3`,[student.id,a.core.id,id]);
    await client.query(`INSERT INTO admission_status_history(organisation_id,application_id,old_status,new_status,note,actor_os_user_id)
      VALUES($1,$2,'approved','enrolled','Applicant enrolled and student record created',$3)`,[a.core.organisation_id,id,a.core.id]);
    return{student,guardian,classroom,feesAssigned};
  });
  await audit(a.core.organisation_id,a.core.id,'admission.enrolled','admission_application',id,{studentId:result.student.id,classroomId:b.classroomId});
  await notifyContact({
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:result.guardian.id,eventKey:'admission.status_changed',
    name:result.guardian.first_name+' '+result.guardian.last_name,email:result.guardian.email,phone:result.guardian.phone,
    subject:'Admission completed',
    body:`Admission has been completed for ${result.student.first_name} ${result.student.last_name}. Student admission number: ${result.student.admission_no}.`,
    relatedType:'admission_application',relatedId:id
  });
  return reply.code(201).send(result);
});

app.get('/api/approvals/summary',async request=>{
  const a=await authorize(request,db,config,'approvals.view');
  const [admissions,leave,reports]=await Promise.all([
    db.query(`SELECT id,application_no,first_name,last_name,requested_grade_code,status,submitted_at
      FROM admission_applications WHERE organisation_id=$1 AND status IN('submitted','under_review')
      ORDER BY submitted_at`,[a.core.organisation_id]),
    db.query(`SELECT lr.id,lr.applicant_os_user_id,lr.leave_type,lr.start_date,lr.end_date,lr.reason,lr.status,lr.created_at
      FROM staff_leave_requests lr WHERE lr.organisation_id=$1 AND lr.status='submitted'
      ORDER BY lr.created_at`,[a.core.organisation_id]),
    db.query(`SELECT rc.student_id,rc.term_id,rc.workflow_status,rc.submitted_at,s.admission_no,s.first_name,s.last_name,t.name term_name,c.name classroom_name
      FROM report_comments rc JOIN students s ON s.id=rc.student_id JOIN terms t ON t.id=rc.term_id
      LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active' LEFT JOIN classrooms c ON c.id=e.classroom_id
      WHERE rc.organisation_id=$1 AND rc.workflow_status='submitted' ORDER BY rc.submitted_at`,[a.core.organisation_id])
  ]);
  const users=await fetchCoreUsers(a.core.organisation_id);
  const userName=(id:string)=>{const u=users.find((x:any)=>x.id===id);return u?(u.first_name+' '+u.last_name):id};
  return{
    admissions:admissions.rows,
    leave:leave.rows.map((x:any)=>({...x,applicant_name:userName(x.applicant_os_user_id)})),
    reports:reports.rows,
    counts:{admissions:admissions.rowCount??0,leave:leave.rowCount??0,reports:reports.rowCount??0,total:(admissions.rowCount??0)+(leave.rowCount??0)+(reports.rowCount??0)}
  };
});

app.get('/api/roles/capabilities',async request=>{
  const a=await authorize(request,db,config,'roles.view');
  const capabilities=(await db.query(`SELECT * FROM school_capabilities ORDER BY sort_order,module,action,label`)).rows;
  const roles=(await db.query(`SELECT key,name,description,portal_mode,can_teach,is_system,is_active
    FROM school_roles WHERE organisation_id=$1 ORDER BY is_system DESC,name`,[a.core.organisation_id])).rows;
  const mappings=(await db.query(`SELECT role,capability_key,allowed FROM school_role_capabilities
    WHERE organisation_id=$1 ORDER BY role,capability_key`,[a.core.organisation_id])).rows;
  const manage=a.role==='school_admin'||Boolean((await maybeOne<any>(db,
    'SELECT allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND capability_key=$3',
    [a.core.organisation_id,a.role,'roles.manage']))?.allowed);
  return{currentRole:a.role,canManage:manage,roles,capabilities,mappings};
});
app.post('/api/roles',async(request,reply)=>{
  const a=await authorize(request,db,config,'roles.manage');
  const b=z.object({
    name:z.string().trim().min(2).max(120),
    key:z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
    description:z.string().max(500).optional(),
    portalMode:z.enum(['admin','teacher']).default('admin'),
    canTeach:z.boolean().default(false),
    copyFromRole:z.string().max(40).optional()
  }).parse(request.body);
  const key=(b.key||b.name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')).slice(0,40);
  if(!key||key==='school_admin')throw fail(400,'Choose a different role name');
  const existing=await maybeOne<any>(db,'SELECT 1 FROM school_roles WHERE organisation_id=$1 AND key=$2',[a.core.organisation_id,key]);
  if(existing)throw fail(409,'A School role with this key already exists');
  const row=await one<any>(db,`INSERT INTO school_roles(organisation_id,key,name,description,portal_mode,can_teach,is_system,is_active)
    VALUES($1,$2,$3,$4,$5,$6,false,true) RETURNING *`,
    [a.core.organisation_id,key,b.name,b.description??null,b.portalMode,b.canTeach]);
  const source=b.copyFromRole
    ?await db.query('SELECT capability_key,allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2',[a.core.organisation_id,b.copyFromRole])
    :null;
  if(source&&source.rowCount){
    for(const p of source.rows)await db.query(`INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[a.core.organisation_id,key,p.capability_key,p.allowed]);
  }else{
    await db.query(`INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
      SELECT $1,$2,key,false FROM school_capabilities ON CONFLICT DO NOTHING`,[a.core.organisation_id,key]);
  }
  await audit(a.core.organisation_id,a.core.id,'school_role.created','school_role',key,{name:b.name,portalMode:b.portalMode,canTeach:b.canTeach});
  return reply.code(201).send(row);
});
app.patch('/api/roles/:role',async request=>{
  const a=await authorize(request,db,config,'roles.manage');
  const {role}=z.object({role:z.string().min(1).max(40)}).parse(request.params);
  const b=z.object({
    name:z.string().trim().min(2).max(120).optional(),
    description:z.string().max(500).nullable().optional(),
    portalMode:z.enum(['admin','teacher']).optional(),
    canTeach:z.boolean().optional(),
    isActive:z.boolean().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM school_roles WHERE organisation_id=$1 AND key=$2',[a.core.organisation_id,role]);
  if(current.key==='school_admin'&&b.isActive===false)throw fail(409,'School Administrator cannot be disabled');
  const row=await one<any>(db,`UPDATE school_roles SET name=COALESCE($1,name),
    description=CASE WHEN $2 THEN $3 ELSE description END,
    portal_mode=COALESCE($4,portal_mode),can_teach=COALESCE($5,can_teach),is_active=COALESCE($6,is_active),updated_at=now()
    WHERE organisation_id=$7 AND key=$8 RETURNING *`,
    [b.name??null,Object.hasOwn(b,'description'),b.description??null,b.portalMode??null,b.canTeach??null,b.isActive??null,a.core.organisation_id,role]);
  await audit(a.core.organisation_id,a.core.id,'school_role.updated','school_role',role,{name:row.name});
  return row;
});
app.put('/api/roles/:role/capabilities',async request=>{
  const a=await authorize(request,db,config,'roles.manage');
  const {role}=z.object({role:z.string().min(1).max(40)}).parse(request.params);
  if(role==='school_admin')throw fail(409,'School Administrator always has full access');
  await one<any>(db,'SELECT 1 FROM school_roles WHERE organisation_id=$1 AND key=$2 AND is_active=true',[a.core.organisation_id,role]);
  const b=z.object({permissions:z.array(z.object({capabilityKey:z.string().min(1).max(100),allowed:z.boolean()})).min(1).max(200)}).parse(request.body);
  const known=(await db.query('SELECT key FROM school_capabilities')).rows.map((x:any)=>x.key);
  for(const p of b.permissions)if(!known.includes(p.capabilityKey))throw fail(400,`Unknown school capability: ${p.capabilityKey}`);
  const financeWorkspaceKeys=new Set([
    'finance.overview.view','finance.student_payments.view','finance.parent_payment_requests.view',
    'finance.setup.view','finance.expenses.view','finance.journals.view','finance.taxes.view',
    'finance.budgets.view','finance.accounts.view','finance.vendors.view','finance.reversals.view',
    'finance.eod.view','finance.reports.view'
  ]);
  const financeWorkspaceEnabled=b.permissions.some(p=>financeWorkspaceKeys.has(p.capabilityKey)&&p.allowed);
  await tx(db,async client=>{
    for(const p of b.permissions){
      await client.query(`INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed,updated_at)
        VALUES($1,$2,$3,$4,now())
        ON CONFLICT(organisation_id,role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now()`,
        [a.core.organisation_id,role,p.capabilityKey,p.allowed]);
    }
    if(financeWorkspaceEnabled){
      // Finance screens rely on student, academic, fee and report reference data. Keep those
      // read dependencies in sync so assigning a Finance tab never produces a hidden 403.
      for(const dependency of ['finance.view','students.view','reports.view','academic.view','fees.view','tax.view']){
        await client.query(`INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed,updated_at)
          VALUES($1,$2,$3,true,now())
          ON CONFLICT(organisation_id,role,capability_key) DO UPDATE SET allowed=true,updated_at=now()`,
          [a.core.organisation_id,role,dependency]);
      }
    }
  });
  await audit(a.core.organisation_id,a.core.id,'role_capabilities.updated','school_role',role,{
    count:b.permissions.length,financeWorkspaceEnabled
  });
  return{role,updated:b.permissions.length,financeWorkspaceEnabled};
});

app.get('/api/teacher/timetable',async request=>{
  const a=await authorize(request,db,config,'timetable.view');
  await ensureTeachingRole(a);
  const q=z.object({termId:z.string().uuid().optional(),academicYearId:z.string().uuid().optional()}).parse(request.query);
  const currentTerm=q.termId
    ?await one<any>(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2',[q.termId,a.core.organisation_id])
    :await activeTerm(a.core.organisation_id);
  const termId=currentTerm?.id??null;
  const yearId=q.academicYearId??currentTerm?.academic_year_id??null;
  return (await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name,t.name term_name,y.name academic_year
    FROM timetable_entries tt JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    JOIN academic_years y ON y.id=tt.academic_year_id LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1
      AND tt.teacher_os_user_id=$2
      AND ($3::uuid IS NULL OR tt.term_id=$3)
      AND ($4::uuid IS NULL OR tt.academic_year_id=$4)
    ORDER BY tt.day_of_week,tt.start_time,c.name`,[a.core.organisation_id,a.core.id,termId,yearId])).rows;
});
app.get('/api/student/timetable',async request=>{
  const s=await studentAuth(request);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,e.academic_year_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.status='active' ORDER BY e.enrolled_at DESC LIMIT 1`,[s.student_id]);
  if(!current)return[];
  return (await db.query(`SELECT tt.*,sub.name subject_name,c.name classroom_name,t.name term_name
    FROM timetable_entries tt JOIN subjects sub ON sub.id=tt.subject_id JOIN classrooms c ON c.id=tt.classroom_id
    LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1 AND tt.classroom_id=$2 AND tt.academic_year_id=$3
    ORDER BY tt.day_of_week,tt.start_time`,[s.organisation_id,current.classroom_id,current.academic_year_id])).rows;
});
app.get('/api/parent/students/:id/timetable',async request=>{
  const g=await guardianAuth(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  await ensureGuardianStudent(g.guardian_id,id);
  const current=await maybeOne<any>(db,`SELECT c.id classroom_id,e.academic_year_id FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
    WHERE e.student_id=$1 AND e.status='active' ORDER BY e.enrolled_at DESC LIMIT 1`,[id]);
  if(!current)return[];
  return (await db.query(`SELECT tt.*,sub.name subject_name,c.name classroom_name,t.name term_name
    FROM timetable_entries tt JOIN subjects sub ON sub.id=tt.subject_id JOIN classrooms c ON c.id=tt.classroom_id
    LEFT JOIN terms t ON t.id=tt.term_id
    WHERE tt.organisation_id=$1 AND tt.classroom_id=$2 AND tt.academic_year_id=$3
    ORDER BY tt.day_of_week,tt.start_time`,[g.organisation_id,current.classroom_id,current.academic_year_id])).rows;
});

app.get('/api/timetable/settings',async request=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().optional()}).parse(request.query);
  const settings=await maybeOne<any>(db,`SELECT * FROM timetable_settings WHERE organisation_id=$1 AND academic_year_id=$2
    AND term_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,[a.core.organisation_id,q.academicYearId,q.termId??null]);
  const breaks=(await db.query(`SELECT * FROM timetable_breaks WHERE organisation_id=$1 AND academic_year_id=$2
    AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL) ORDER BY day_of_week NULLS FIRST,start_time`,
    [a.core.organisation_id,q.academicYearId,q.termId??null])).rows;
  return{settings:settings??{school_day_start:'07:30:00',school_day_end:'15:30:00',default_period_minutes:40,minimum_break_minutes:20,max_teacher_periods_per_day:8},breaks};
});
app.put('/api/timetable/settings',async request=>{
  const a=await authorize(request,db,config,'timetable.configure');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid().nullable().optional(),
    schoolDayStart:z.string().regex(/^\d{2}:\d{2}$/),schoolDayEnd:z.string().regex(/^\d{2}:\d{2}$/),
    defaultPeriodMinutes:z.number().int().min(15).max(180),minimumBreakMinutes:z.number().int().min(0).max(180),
    maxTeacherPeriodsPerDay:z.number().int().min(1).max(20)
  }).parse(request.body);
  if(b.schoolDayEnd<=b.schoolDayStart)throw fail(400,'School day end must be after school day start');
  await db.query(`DELETE FROM timetable_settings WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id IS NOT DISTINCT FROM $3::uuid`,
    [a.core.organisation_id,b.academicYearId,b.termId??null]);
  const row=await one<any>(db,`INSERT INTO timetable_settings(
      organisation_id,academic_year_id,term_id,school_day_start,school_day_end,default_period_minutes,minimum_break_minutes,max_teacher_periods_per_day,updated_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[
      a.core.organisation_id,b.academicYearId,b.termId??null,b.schoolDayStart,b.schoolDayEnd,b.defaultPeriodMinutes,b.minimumBreakMinutes,b.maxTeacherPeriodsPerDay,a.core.id
    ]);
  await audit(a.core.organisation_id,a.core.id,'timetable.settings_updated','timetable_settings',null,{academicYearId:b.academicYearId,termId:b.termId??null});
  return row;
});
app.post('/api/timetable/breaks',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.configure');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid().nullable().optional(),dayOfWeek:z.number().int().min(1).max(5).nullable().optional(),
    label:z.string().min(2).max(100),startTime:z.string().regex(/^\d{2}:\d{2}$/),endTime:z.string().regex(/^\d{2}:\d{2}$/),
    breakType:z.enum(['break','lunch','assembly','other']).default('break')
  }).parse(request.body);
  if(b.endTime<=b.startTime)throw fail(400,'Break end time must be after start time');
  const row=await one<any>(db,`INSERT INTO timetable_breaks(organisation_id,academic_year_id,term_id,day_of_week,label,start_time,end_time,break_type)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[
      a.core.organisation_id,b.academicYearId,b.termId??null,b.dayOfWeek??null,b.label,b.startTime,b.endTime,b.breakType
    ]);
  await audit(a.core.organisation_id,a.core.id,'timetable.break_created','timetable_break',row.id);
  return reply.code(201).send(row);
});
app.delete('/api/timetable/breaks/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.configure');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'DELETE FROM timetable_breaks WHERE id=$1 AND organisation_id=$2 RETURNING id',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'timetable.break_deleted','timetable_break',row.id);
  return reply.code(204).send();
});
app.get('/api/timetable/unavailability',async request=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().optional(),teacherOsUserId:z.string().uuid().optional()}).parse(request.query);
  return (await db.query(`SELECT * FROM timetable_teacher_unavailability
    WHERE organisation_id=$1 AND academic_year_id=$2
      AND ($3::uuid IS NULL OR term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)
      AND ($4::uuid IS NULL OR teacher_os_user_id=$4)
    ORDER BY teacher_os_user_id,day_of_week,start_time`,
    [a.core.organisation_id,q.academicYearId,q.termId??null,q.teacherOsUserId??null])).rows;
});
app.post('/api/timetable/unavailability',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.configure');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid().nullable().optional(),teacherOsUserId:z.string().uuid(),
    dayOfWeek:z.number().int().min(1).max(5),startTime:z.string().regex(/^\d{2}:\d{2}$/),
    endTime:z.string().regex(/^\d{2}:\d{2}$/),reason:z.string().max(300).optional()
  }).parse(request.body);
  if(b.endTime<=b.startTime)throw fail(400,'Unavailable end time must be after start time');
  const row=await one<any>(db,`INSERT INTO timetable_teacher_unavailability(
      organisation_id,academic_year_id,term_id,teacher_os_user_id,day_of_week,start_time,end_time,reason,created_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT DO NOTHING RETURNING *`,
    [a.core.organisation_id,b.academicYearId,b.termId??null,b.teacherOsUserId,b.dayOfWeek,b.startTime,b.endTime,b.reason??null,a.core.id]);
  if(!row)throw fail(409,'This teacher unavailability already exists');
  await audit(a.core.organisation_id,a.core.id,'timetable.teacher_unavailability_created','timetable_teacher_unavailability',row.id,{teacherOsUserId:b.teacherOsUserId});
  return reply.code(201).send(row);
});
app.delete('/api/timetable/unavailability/:id',async(request,reply)=>{
  const a=await authorize(request,db,config,'timetable.configure');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,'DELETE FROM timetable_teacher_unavailability WHERE id=$1 AND organisation_id=$2 RETURNING *',[id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,'timetable.teacher_unavailability_deleted','timetable_teacher_unavailability',id,{teacherOsUserId:row.teacher_os_user_id});
  return reply.code(204).send();
});

app.get('/api/timetable/schedule-analysis',async request=>{
  const a=await authorize(request,db,config,'timetable.view');
  const q=z.object({academicYearId:z.string().uuid(),termId:z.string().uuid().optional()}).parse(request.query);
  const settings=await maybeOne<any>(db,`SELECT * FROM timetable_settings WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id IS NOT DISTINCT FROM $3::uuid`,
    [a.core.organisation_id,q.academicYearId,q.termId??null]);
  const entries=(await db.query(`SELECT tt.*,c.name classroom_name,s.name subject_name FROM timetable_entries tt
    JOIN classrooms c ON c.id=tt.classroom_id JOIN subjects s ON s.id=tt.subject_id
    WHERE tt.organisation_id=$1 AND tt.academic_year_id=$2 AND ($3::uuid IS NULL OR tt.term_id=$3)`,
    [a.core.organisation_id,q.academicYearId,q.termId??null])).rows;
  const conflicts:any[]=[];
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const x=entries[i],y=entries[j];
    if(x.day_of_week!==y.day_of_week)continue;
    if(String(x.start_time)<String(y.end_time)&&String(x.end_time)>String(y.start_time)){
      if(x.classroom_id===y.classroom_id)conflicts.push({type:'class',first:x.id,second:y.id,message:`${x.classroom_name}: ${x.subject_name} overlaps ${y.subject_name}`});
      if(x.teacher_os_user_id&&x.teacher_os_user_id===y.teacher_os_user_id)conflicts.push({type:'teacher',first:x.id,second:y.id,message:`A teacher is scheduled for two classes at the same time`});
      if(x.room&&y.room&&String(x.room).trim().toLowerCase()===String(y.room).trim().toLowerCase())conflicts.push({type:'room',first:x.id,second:y.id,message:`Room ${x.room} is assigned to two classes at the same time`});
    }
  }
  const teacherLoad=(await db.query(`SELECT teacher_os_user_id,day_of_week,count(*)::int periods FROM timetable_entries
    WHERE organisation_id=$1 AND academic_year_id=$2 AND ($3::uuid IS NULL OR term_id=$3) AND teacher_os_user_id IS NOT NULL
    GROUP BY teacher_os_user_id,day_of_week ORDER BY teacher_os_user_id,day_of_week`,
    [a.core.organisation_id,q.academicYearId,q.termId??null])).rows;
  const maxDaily=settings?.max_teacher_periods_per_day??8;
  const overloads=teacherLoad.filter((x:any)=>Number(x.periods)>Number(maxDaily));
  const unscheduled=(await db.query(`SELECT ta.id,c.name classroom_name,s.name subject_name,ta.teacher_os_user_id
    FROM teacher_assignments ta JOIN classrooms c ON c.id=ta.classroom_id LEFT JOIN subjects s ON s.id=ta.subject_id
    WHERE ta.organisation_id=$1 AND ta.academic_year_id=$2 AND ta.is_active=true AND ta.subject_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM timetable_entries tt WHERE tt.organisation_id=ta.organisation_id AND tt.academic_year_id=ta.academic_year_id
        AND tt.classroom_id=ta.classroom_id AND tt.subject_id=ta.subject_id AND tt.teacher_os_user_id=ta.teacher_os_user_id
        AND ($3::uuid IS NULL OR tt.term_id=$3))`,[a.core.organisation_id,q.academicYearId,q.termId??null])).rows;
  const unavailability=(await db.query(`SELECT * FROM timetable_teacher_unavailability
    WHERE organisation_id=$1 AND academic_year_id=$2 AND ($3::uuid IS NULL OR term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)`,
    [a.core.organisation_id,q.academicYearId,q.termId??null])).rows;
  const availabilityConflicts=entries.filter((x:any)=>x.teacher_os_user_id&&unavailability.some((u:any)=>
    u.teacher_os_user_id===x.teacher_os_user_id&&Number(u.day_of_week)===Number(x.day_of_week)&&String(x.start_time)<String(u.end_time)&&String(x.end_time)>String(u.start_time)
  )).map((x:any)=>({type:'availability',first:x.id,second:null,message:`${x.classroom_name} - ${x.subject_name} is scheduled during the teacher's unavailable time`}));
  conflicts.push(...availabilityConflicts);
  return{settings:settings??null,entryCount:entries.length,conflicts,teacherLoad,overloads,unscheduledAssignments:unscheduled,teacherUnavailability:unavailability};
});

app.get('/api/lesson-notes',async request=>{
  const a=await authorize(request,db,config,'lesson_notes.view');
  const q=z.object({
    termId:z.string().uuid().optional(),classroomId:z.string().uuid().optional(),subjectId:z.string().uuid().optional(),
    teacherOsUserId:z.string().uuid().optional(),status:z.enum(['draft','submitted','approved','returned','taught']).optional(),q:z.string().max(100).optional()
  }).parse(request.query);
  const teacherFilter=a.role==='teacher'?a.core.id:(q.teacherOsUserId??null),like=q.q?'%'+q.q+'%':null;
  return (await db.query(`SELECT ln.*,c.name classroom_name,s.name subject_name,t.name term_name,y.name academic_year
    FROM lesson_notes ln JOIN classrooms c ON c.id=ln.classroom_id JOIN subjects s ON s.id=ln.subject_id
    JOIN terms t ON t.id=ln.term_id JOIN academic_years y ON y.id=ln.academic_year_id
    WHERE ln.organisation_id=$1 AND ($2::uuid IS NULL OR ln.term_id=$2) AND ($3::uuid IS NULL OR ln.classroom_id=$3)
      AND ($4::uuid IS NULL OR ln.subject_id=$4) AND ($5::uuid IS NULL OR ln.teacher_os_user_id=$5)
      AND ($6::text IS NULL OR ln.status=$6)
      AND ($7::text IS NULL OR ln.title ILIKE $7 OR COALESCE(ln.strand,'') ILIKE $7 OR COALESCE(ln.sub_strand,'') ILIKE $7 OR COALESCE(ln.learning_objectives,'') ILIKE $7)
    ORDER BY ln.lesson_date DESC NULLS LAST,ln.updated_at DESC`,[
      a.core.organisation_id,q.termId??null,q.classroomId??null,q.subjectId??null,teacherFilter,q.status??null,like
    ])).rows;
});
app.post('/api/lesson-notes',async(request,reply)=>{
  const a=await authorize(request,db,config,'lesson_notes.create');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),
    weekNo:z.number().int().min(1).max(30).optional(),lessonDate:z.string().date().optional(),title:z.string().min(2).max(240),
    strand:z.string().max(240).optional(),subStrand:z.string().max(240).optional(),learningObjectives:z.string().max(10000).optional(),
    teachingLearningResources:z.string().max(10000).optional(),introductionActivity:z.string().max(10000).optional(),
    mainActivity:z.string().max(20000).optional(),plenaryActivity:z.string().max(10000).optional(),differentiation:z.string().max(10000).optional(),
    assessmentMethod:z.string().max(10000).optional(),homework:z.string().max(10000).optional(),teacherReflection:z.string().max(10000).optional()
  }).parse(request.body);
  await ensureTeacherScope(a,b.classroomId,b.subjectId);
  const teacherId=a.role==='teacher'?a.core.id:a.core.id;
  const row=await one<any>(db,`INSERT INTO lesson_notes(
    organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,week_no,lesson_date,title,strand,sub_strand,
    learning_objectives,teaching_learning_resources,introduction_activity,main_activity,plenary_activity,differentiation,assessment_method,homework,teacher_reflection
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[
    a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,teacherId,b.weekNo??null,b.lessonDate??null,b.title,b.strand??null,b.subStrand??null,
    b.learningObjectives??null,b.teachingLearningResources??null,b.introductionActivity??null,b.mainActivity??null,b.plenaryActivity??null,b.differentiation??null,
    b.assessmentMethod??null,b.homework??null,b.teacherReflection??null
  ]);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.created','lesson_note',row.id,{classroomId:b.classroomId,subjectId:b.subjectId});
  return reply.code(201).send(row);
});
app.patch('/api/lesson-notes/:id',async request=>{
  const a=await authorize(request,db,config,'lesson_notes.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM lesson_notes WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(a.role==='teacher'&&current.teacher_os_user_id!==a.core.id)throw fail(403,'You can only edit your own lesson notes');
  if(!['draft','returned'].includes(current.status))throw fail(409,'Only draft or returned lesson notes can be edited');
  const b=z.object({
    weekNo:z.number().int().min(1).max(30).nullable().optional(),lessonDate:z.string().date().nullable().optional(),title:z.string().min(2).max(240).optional(),
    strand:z.string().max(240).nullable().optional(),subStrand:z.string().max(240).nullable().optional(),learningObjectives:z.string().max(10000).nullable().optional(),
    teachingLearningResources:z.string().max(10000).nullable().optional(),introductionActivity:z.string().max(10000).nullable().optional(),
    mainActivity:z.string().max(20000).nullable().optional(),plenaryActivity:z.string().max(10000).nullable().optional(),differentiation:z.string().max(10000).nullable().optional(),
    assessmentMethod:z.string().max(10000).nullable().optional(),homework:z.string().max(10000).nullable().optional(),teacherReflection:z.string().max(10000).nullable().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const map:any={weekNo:'week_no',lessonDate:'lesson_date',title:'title',strand:'strand',subStrand:'sub_strand',learningObjectives:'learning_objectives',
    teachingLearningResources:'teaching_learning_resources',introductionActivity:'introduction_activity',mainActivity:'main_activity',
    plenaryActivity:'plenary_activity',differentiation:'differentiation',assessmentMethod:'assessment_method',homework:'homework',teacherReflection:'teacher_reflection'};
  const fields:string[]=[],values:any[]=[];let n=1;
  for(const [k,col] of Object.entries(map))if(Object.hasOwn(b,k)){fields.push(`${col}=${n++}`);values.push((b as any)[k]??null)}
  fields.push(`status='draft'`,`review_note=NULL`,`updated_at=now()`);
  values.push(id,a.core.organisation_id);
  const row=await one<any>(db,`UPDATE lesson_notes SET ${fields.join(',')} WHERE id=${n++} AND organisation_id=${n} RETURNING *`,values);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.updated','lesson_note',id);
  return row;
});
app.post('/api/lesson-notes/:id/submit',async request=>{
  const a=await authorize(request,db,config,'lesson_notes.submit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM lesson_notes WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(a.role==='teacher'&&current.teacher_os_user_id!==a.core.id)throw fail(403,'You can only submit your own lesson notes');
  if(!['draft','returned'].includes(current.status))throw fail(409,'Only draft or returned lesson notes can be submitted');
  const row=await one<any>(db,"UPDATE lesson_notes SET status='submitted',submitted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[id]);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.submitted','lesson_note',id);
  return row;
});
app.post('/api/lesson-notes/:id/review',async request=>{
  const a=await authorize(request,db,config,'lesson_notes.review');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({action:z.enum(['approve','return']),note:z.string().max(4000).nullable().optional()}).parse(request.body);
  const current=await one<any>(db,"SELECT * FROM lesson_notes WHERE id=$1 AND organisation_id=$2 AND status='submitted'",[id,a.core.organisation_id]);
  if(current.teacher_os_user_id===a.core.id)throw fail(403,'You cannot approve or return your own lesson note');
  if(b.action==='return'&&!b.note)throw fail(400,'Enter a review note before returning the lesson note');
  const status=b.action==='approve'?'approved':'returned';
  const row=await one<any>(db,`UPDATE lesson_notes SET status=$1,review_note=$2,reviewed_by_os_user_id=$3,reviewed_at=now(),updated_at=now()
    WHERE id=$4 RETURNING *`,[status,b.note??null,a.core.id,id]);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.'+status,'lesson_note',id);
  return row;
});
app.post('/api/lesson-notes/:id/teaching-log',async request=>{
  const a=await authorize(request,db,config,'lesson_notes.edit');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({teachingLog:z.string().min(1).max(10000),teacherReflection:z.string().max(10000).nullable().optional()}).parse(request.body);
  const current=await one<any>(db,'SELECT * FROM lesson_notes WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(a.role==='teacher'&&current.teacher_os_user_id!==a.core.id)throw fail(403,'You can only update your own teaching log');
  if(!['approved','taught'].includes(current.status))throw fail(409,'The lesson note must be approved before it can be marked as taught');
  const row=await one<any>(db,`UPDATE lesson_notes SET status='taught',teaching_log=$1,teacher_reflection=COALESCE($2,teacher_reflection),
    taught_at=COALESCE(taught_at,now()),updated_at=now() WHERE id=$3 RETURNING *`,[b.teachingLog,b.teacherReflection??null,id]);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.taught','lesson_note',id);
  return row;
});

app.get('/api/lesson-notes/:id/attachments',async request=>{
  const a=await authorize(request,db,config,'lesson_notes.view');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const note=await one<any>(db,'SELECT * FROM lesson_notes WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(a.role==='teacher'&&note.teacher_os_user_id!==a.core.id)throw fail(403,'You can only view attachments for your own lesson notes');
  return (await db.query(`SELECT id,lesson_note_id,file_name,mime_type,file_size,uploaded_by_os_user_id,created_at
    FROM lesson_note_attachments WHERE organisation_id=$1 AND lesson_note_id=$2 ORDER BY created_at`,
    [a.core.organisation_id,id])).rows;
});
app.post('/api/lesson-notes/:id/attachments',async(request,reply)=>{
  const a=await authorize(request,db,config,'lesson_notes.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const note=await one<any>(db,'SELECT * FROM lesson_notes WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(note.teacher_os_user_id!==a.core.id&&a.role!=='school_admin')throw fail(403,'Only the lesson-note owner can upload attachments');
  if(!['draft','returned'].includes(note.status))throw fail(409,'Attachments can only be changed while the lesson note is draft or returned');
  const b=z.object({
    fileName:z.string().min(1).max(260),
    mimeType:z.string().min(3).max(160),
    dataBase64:z.string().min(4)
  }).parse(request.body);
  const allowed=new Set([
    'application/pdf','text/plain',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg','image/png','image/webp'
  ]);
  if(!allowed.has(b.mimeType))throw fail(400,'Unsupported attachment type');
  const data=Buffer.from(b.dataBase64,'base64');
  if(!data.length||data.length>5*1024*1024)throw fail(400,'Attachment must be between 1 byte and 5 MB');
  const row=await one<any>(db,`INSERT INTO lesson_note_attachments(
      organisation_id,lesson_note_id,file_name,mime_type,file_size,file_data,uploaded_by_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7)
    RETURNING id,lesson_note_id,file_name,mime_type,file_size,uploaded_by_os_user_id,created_at`,
    [a.core.organisation_id,id,b.fileName.trim(),b.mimeType,data.length,data,a.core.id]);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.attachment_uploaded','lesson_note_attachment',row.id,{lessonNoteId:id,fileName:row.file_name,fileSize:row.file_size});
  return reply.code(201).send(row);
});
app.get('/api/lesson-note-attachments/:attachmentId/download',async(request,reply)=>{
  const a=await authorize(request,db,config,'lesson_notes.view');
  const {attachmentId}=z.object({attachmentId:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,`SELECT lna.*,ln.teacher_os_user_id FROM lesson_note_attachments lna
    JOIN lesson_notes ln ON ln.id=lna.lesson_note_id
    WHERE lna.id=$1 AND lna.organisation_id=$2`,[attachmentId,a.core.organisation_id]);
  if(a.role==='teacher'&&row.teacher_os_user_id!==a.core.id)throw fail(403,'You can only download attachments for your own lesson notes');
  reply.header('content-type',row.mime_type);
  reply.header('content-length',String(row.file_size));
  reply.header('content-disposition','attachment; filename="'+String(row.file_name).replace(/["\\]/g,'_')+'"');
  return reply.send(row.file_data);
});
app.delete('/api/lesson-note-attachments/:attachmentId',async(request,reply)=>{
  const a=await authorize(request,db,config,'lesson_notes.edit');
  const {attachmentId}=z.object({attachmentId:z.string().uuid()}).parse(request.params);
  const row=await one<any>(db,`SELECT lna.id,lna.file_name,ln.id lesson_note_id,ln.teacher_os_user_id,ln.status
    FROM lesson_note_attachments lna JOIN lesson_notes ln ON ln.id=lna.lesson_note_id
    WHERE lna.id=$1 AND lna.organisation_id=$2`,[attachmentId,a.core.organisation_id]);
  if(row.teacher_os_user_id!==a.core.id&&a.role!=='school_admin')throw fail(403,'Only the lesson-note owner can remove attachments');
  if(!['draft','returned'].includes(row.status))throw fail(409,'Attachments cannot be removed after the lesson note is submitted');
  await db.query('DELETE FROM lesson_note_attachments WHERE id=$1',[attachmentId]);
  await audit(a.core.organisation_id,a.core.id,'lesson_note.attachment_deleted','lesson_note_attachment',attachmentId,{lessonNoteId:row.lesson_note_id,fileName:row.file_name});
  return reply.code(204).send();
});

app.get('/api/search',async request=>{
  const a=await authorize(request,db,config);
  const q=z.object({q:z.string().trim().min(1).max(100),limit:z.coerce.number().int().min(1).max(50).default(20)}).parse(request.query);
  const like='%'+q.q+'%';
  const rows=(await db.query(`
    SELECT * FROM (
      SELECT 'student' type,s.id::text id,(s.first_name||' '||s.last_name) title,
             (s.admission_no||COALESCE(' • '||c.name,'')) subtitle,'students' section,1 rank
      FROM students s LEFT JOIN enrolments e ON e.student_id=s.id AND e.status='active' LEFT JOIN classrooms c ON c.id=e.classroom_id
      WHERE s.organisation_id=$1 AND lower(s.first_name||' '||COALESCE(s.middle_name,'')||' '||s.last_name||' '||s.admission_no) LIKE lower($2)
      UNION ALL
      SELECT 'guardian',g.id::text,(g.first_name||' '||g.last_name),(g.phone||COALESCE(' • '||g.email,'')),'students',2
      FROM guardians g WHERE g.organisation_id=$1 AND lower(g.first_name||' '||g.last_name||' '||g.phone||' '||COALESCE(g.email,'')) LIKE lower($2)
      UNION ALL
      SELECT 'admission',aa.id::text,(aa.first_name||' '||aa.last_name),(aa.application_no||' • '||aa.status),'admissions',3
      FROM admission_applications aa WHERE aa.organisation_id=$1 AND lower(aa.first_name||' '||aa.last_name||' '||aa.application_no||' '||aa.guardian_phone||' '||COALESCE(aa.guardian_email,'')) LIKE lower($2)
      UNION ALL
      SELECT 'class',c.id::text,c.name,(gl.name||' • '||COALESCE(c.stream,'No stream')),'assignments',4
      FROM classrooms c JOIN grade_levels gl ON gl.id=c.grade_level_id WHERE c.organisation_id=$1 AND (c.name ILIKE $2 OR gl.name ILIKE $2)
      UNION ALL
      SELECT 'subject',s.id::text,s.name,(s.code||' • '||s.stage),'assignments',5
      FROM subjects s WHERE s.organisation_id=$1 AND (s.name ILIKE $2 OR s.code ILIKE $2)
      UNION ALL
      SELECT 'lesson_note',ln.id::text,ln.title,(c.name||' • '||sub.name||' • '||ln.status),'lessonnotes',6
      FROM lesson_notes ln JOIN classrooms c ON c.id=ln.classroom_id JOIN subjects sub ON sub.id=ln.subject_id
      WHERE ln.organisation_id=$1 AND lower(ln.title||' '||COALESCE(ln.strand,'')||' '||COALESCE(ln.sub_strand,'')||' '||COALESCE(ln.learning_objectives,'')) LIKE lower($2)
      UNION ALL
      SELECT 'fee',f.id::text,f.name,('GHS '||f.amount::text),'fees',7
      FROM fee_items f WHERE f.organisation_id=$1 AND f.name ILIKE $2
      UNION ALL
      SELECT 'payment',p.id::text,(s.first_name||' '||s.last_name),('Payment • GHS '||p.amount::text||COALESCE(' • '||p.reference,'')),'fees',8
      FROM payments p JOIN students s ON s.id=p.student_id WHERE p.organisation_id=$1 AND (COALESCE(p.reference,'') ILIKE $2 OR s.admission_no ILIKE $2 OR (s.first_name||' '||s.last_name) ILIKE $2)
      UNION ALL
      SELECT 'finance_expense',e.id::text,e.description,(e.expense_no||' • GHS '||e.amount::text||COALESCE(' • '||e.reference,'')),'finance',9
      FROM finance_expenses e WHERE e.organisation_id=$1 AND (e.description ILIKE $2 OR e.expense_no ILIKE $2 OR COALESCE(e.reference,'') ILIKE $2)
      UNION ALL
      SELECT 'finance_journal',je.id::text,je.description,(je.entry_no||COALESCE(' • '||je.reference,'')),'finance',10
      FROM finance_journal_entries je WHERE je.organisation_id=$1 AND (je.description ILIKE $2 OR je.entry_no ILIKE $2 OR COALESCE(je.reference,'') ILIKE $2)
      UNION ALL
      SELECT 'vendor',v.id::text,v.name,(COALESCE(v.tax_id,'')||COALESCE(' • '||v.phone,'')),'finance',11
      FROM finance_vendors v WHERE v.organisation_id=$1 AND (v.name ILIKE $2 OR COALESCE(v.tax_id,'') ILIKE $2 OR COALESCE(v.phone,'') ILIKE $2)
      UNION ALL
      SELECT 'tax',o.id::text,t.name,(t.code||' • '||o.status||' • GHS '||o.amount_due::text),'finance',12
      FROM finance_tax_obligations o JOIN finance_tax_types t ON t.id=o.tax_type_id
      WHERE o.organisation_id=$1 AND (t.name ILIKE $2 OR t.code ILIKE $2 OR COALESCE(o.filing_reference,'') ILIKE $2)
      UNION ALL
      SELECT 'leave',lr.id::text,replace(lr.leave_type,'_',' ')||' leave',(lr.start_date::text||' to '||lr.end_date::text||' • '||lr.status),'leave',13
      FROM staff_leave_requests lr WHERE lr.organisation_id=$1 AND (lr.leave_type ILIKE $2 OR lr.reason ILIKE $2 OR lr.status ILIKE $2)
      UNION ALL
      SELECT 'communication',co.id::text,COALESCE(co.subject,'Message'),(co.channel||' • '||co.recipient_address||' • '||co.status),'announcements',14
      FROM communication_outbox co WHERE co.organisation_id=$1 AND (COALESCE(co.subject,'') ILIKE $2 OR co.recipient_address ILIKE $2 OR COALESCE(co.recipient_name,'') ILIKE $2)
    ) x ORDER BY rank,title LIMIT $3`,[a.core.organisation_id,like,q.limit])).rows;
  let staff:any[]=[];
  {
    const users=await fetchCoreUsers(a.core.organisation_id);
    const needle=q.q.toLowerCase();
    staff=users.filter((u:any)=>(u.first_name+' '+u.last_name+' '+u.email+' '+(u.job_title||'')).toLowerCase().includes(needle)).slice(0,8).map((u:any)=>({
      type:'staff',id:u.id,title:u.first_name+' '+u.last_name,subtitle:(u.job_title||'Staff')+' • '+u.email,section:'staff'
    }));
  }
  const caps=await effectiveCapabilities(db,a.core.organisation_id,a.role);
  const allowed=(section:string)=>a.role==='school_admin'||(
    section==='students'?caps.includes('students.view'):
    section==='admissions'?caps.includes('admissions.view'):
    section==='assignments'?(caps.includes('teaching_assignments.view')||caps.includes('academic.view')):
    section==='lessonnotes'?caps.includes('lesson_notes.view'):
    section==='fees'?caps.includes('fees.view'):
    section==='finance'?caps.includes('finance.view'):
    section==='leave'?caps.includes('leave.view'):
    section==='announcements'?caps.includes('communications.view'):
    section==='staff'?caps.includes('staff.view'):false
  );
  return[...rows,...staff].filter((x:any)=>allowed(x.section)).slice(0,q.limit);
});

app.get('/api/communications/status',async request=>{
  const a=await authorize(request,db,config,'communications.view');
  const rules=(await db.query('SELECT event_key,channel,enabled,updated_at FROM notification_rules WHERE organisation_id=$1 ORDER BY event_key,channel',[a.core.organisation_id])).rows;
  const queue=(await db.query(`
    SELECT channel,status,count(*)::int count
    FROM communication_outbox
    WHERE organisation_id=$1
    GROUP BY channel,status
    ORDER BY channel,status
  `,[a.core.organisation_id])).rows;
  const summary=queue.reduce((acc:any,row:any)=>{
    const n=Number(row.count||0);
    acc.total+=n;
    acc[row.status]=(acc[row.status]||0)+n;
    acc.byChannel[row.channel]=(acc.byChannel[row.channel]||0)+n;
    return acc;
  },{total:0,queued:0,pending_configuration:0,sending:0,sent:0,failed:0,byChannel:{email:0,sms:0,whatsapp:0}});
  return{providers:providerStatus(config),rules,queue,summary};
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
app.post('/api/communications/outbox/:id/retry',async request=>{
  const a=await authorize(request,db,config,'communications.send');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const current=await one<any>(db,'SELECT * FROM communication_outbox WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  if(current.status==='sent')return current;
  await db.query("UPDATE communication_outbox SET status='queued',last_error=NULL,next_attempt_at=now() WHERE id=$1",[id]);
  try{
    await db.query(`UPDATE communication_outbox
      SET status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),next_attempt_at=NULL
      WHERE id=$1`,[id]);
    const sent=await sendMessage(config,{
      channel:current.channel,
      to:current.channel==='email'?current.recipient_address:normalizePhone(current.recipient_address),
      subject:current.subject,
      recipientName:current.recipient_name,
      body:current.body
    });
    const row=await one<any>(db,`UPDATE communication_outbox SET status='sent',provider=$1,provider_message_id=$2,
      sent_at=now(),last_error=NULL,next_attempt_at=NULL WHERE id=$3 RETURNING *`,
      [sent.provider,sent.messageId,id]);
    await audit(a.core.organisation_id,a.core.id,'communication.retried','communication_outbox',id,{result:'sent'});
    return row;
  }catch(error:any){
    const row=await one<any>(db,`UPDATE communication_outbox SET status='failed',last_error=$1,
      next_attempt_at=CASE WHEN attempt_count>=max_attempts THEN NULL ELSE now()+interval '5 minutes' END
      WHERE id=$2 RETURNING *`,[String(error?.message||error).slice(0,4000),id]);
    await audit(a.core.organisation_id,a.core.id,'communication.retried','communication_outbox',id,{result:'failed'});
    return row;
  }
});

app.post('/api/communications/retry-pending',async request=>{
  const a=await authorize(request,db,config,'communications.send');
  const b=z.object({limit:z.number().int().min(1).max(100).default(100)}).parse(request.body??{});
  const result=await retryCommunicationOutbox(db,config,b.limit,a.core.organisation_id);
  await audit(a.core.organisation_id,a.core.id,'communications.bulk_retry','communication_outbox',null,result);
  return result;
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
    organisationId:a.core.organisation_id,actorOsUserId:a.core.id,guardianId:guardian.id,eventKey:'fees.payment_requested',
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
    await one<any>(db,'SELECT id FROM student_fees WHERE id=$1 AND student_id=$2 AND organisation_id=$3',
      [b.studentFeeId,b.studentId,a.core.organisation_id]);
  }
  const reference=await nextSystemPaymentReference(db,a.core.organisation_id,b.method,student.admission_no);
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
  const parentStudent=await one<any>(db,'SELECT id,admission_no FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,g.organisation_id]);
  if(feeId){
    await one<any>(db,'SELECT id FROM student_fees WHERE id=$1 AND student_id=$2 AND organisation_id=$3',
      [feeId,b.studentId,g.organisation_id]);
  }
  const reference=await nextSystemPaymentReference(db,g.organisation_id,b.method,parentStudent.admission_no);
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
          organisationId:intent.organisation_id,guardianId:guardian.id,eventKey:'fees.payment_received',
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


app.get('/api/system/diagnostics',async request=>{
  const a=await authorize(request,db,config,'system.logs.view');
  const org=a.core.organisation_id;
  const checks:any[]=[];
  const add=(key:string,label:string,ok:boolean,details:any,severity:'critical'|'warning'|'info'='critical')=>{
    checks.push({key,label,status:ok?'pass':severity==='warning'?'warning':'fail',details});
  };

  const coreHealth=await probeCoreOS();
  add('core_os','Core Revolt-X OS connectivity',Boolean(coreHealth.reachable),{
    reachable:coreHealth.reachable,status:coreHealth.status,responseMs:coreHealth.responseMs,url:coreHealth.url
  },'warning');

  const localSessions=await one<any>(db,`SELECT
    count(*) FILTER(WHERE revoked_at IS NULL AND expires_at>now())::int active,
    count(*) FILTER(WHERE revoked_at IS NOT NULL)::int revoked,
    count(*) FILTER(WHERE expires_at<=now())::int expired
    FROM school_sessions WHERE organisation_id=$1`,[org]);
  add('school_sessions','Local School authentication sessions',Number(localSessions.active)>=0,localSessions,'info');

  const profile=await maybeOne<any>(db,'SELECT school_name FROM school_profiles WHERE organisation_id=$1',[org]);
  add('school_profile','School profile',Boolean(profile),profile?profile.school_name:'Missing school profile');

  const years=await one<any>(db,`SELECT count(*)::int total,count(*) FILTER(WHERE status='active')::int active FROM academic_years WHERE organisation_id=$1`,[org]);
  add('academic_year','Academic year',Number(years.active)===1,{total:years.total,active:years.active});

  const terms=await one<any>(db,`SELECT count(*)::int total,count(*) FILTER(WHERE status='active')::int active FROM terms WHERE organisation_id=$1`,[org]);
  add('term','Academic term',Number(terms.active)===1,{total:terms.total,active:terms.active});

  const classData=await one<any>(db,`SELECT count(*) FILTER(WHERE is_active)::int active_classes FROM classrooms WHERE organisation_id=$1`,[org]);
  const subjectData=await one<any>(db,`SELECT count(*) FILTER(WHERE is_active)::int active_subjects FROM subjects WHERE organisation_id=$1`,[org]);
  add('academic_structure','Classes and subjects',Number(classData.active_classes)>0&&Number(subjectData.active_subjects)>0,{classes:classData.active_classes,subjects:subjectData.active_subjects});

  const curriculum=await one<any>(db,`SELECT
    count(*) FILTER(WHERE cs.is_active)::int active_links,
    count(*) FILTER(WHERE cs.is_active AND NOT EXISTS(
      SELECT 1 FROM teacher_assignments ta WHERE ta.organisation_id=cs.organisation_id
      AND ta.classroom_id=cs.classroom_id AND ta.subject_id=cs.subject_id AND ta.is_active=true
    ))::int without_teacher
    FROM class_subjects cs WHERE cs.organisation_id=$1`,[org]);
  add('curriculum_teachers','Curriculum teacher coverage',Number(curriculum.active_links)>0&&Number(curriculum.without_teacher)===0,curriculum);

  const students=await one<any>(db,`SELECT count(*) FILTER(WHERE status='active')::int active_students,
    count(*) FILTER(WHERE status='active' AND NOT EXISTS(
      SELECT 1 FROM enrolments e WHERE e.student_id=students.id AND e.status='active'
    ))::int without_enrolment FROM students WHERE organisation_id=$1`,[org]);
  add('student_enrolment','Active student enrolment',Number(students.without_enrolment)===0&&Number(students.active_students)>0,students);

  const guardianLinks=await one<any>(db,`SELECT count(*)::int links FROM student_guardians sg JOIN students s ON s.id=sg.student_id WHERE s.organisation_id=$1`,[org]);
  add('guardians','Student guardian links',Number(guardianLinks.links)>0,guardianLinks,'warning');

  const scheme=(await db.query(`SELECT t.id,t.name,COALESCE(sum(ac.weight_percent) FILTER(WHERE ac.is_active),0)::numeric total_weight
    FROM terms t LEFT JOIN assessment_categories ac ON ac.term_id=t.id
    WHERE t.organisation_id=$1 GROUP BY t.id,t.name,t.term_no ORDER BY t.term_no`,[org])).rows;
  const badScheme=scheme.filter((x:any)=>Math.abs(Number(x.total_weight)-100)>0.001);
  add('assessment_scheme','Assessment schemes total 100%',scheme.length>0&&badScheme.length===0,{terms:scheme,badTerms:badScheme.length});

  const scores=await one<any>(db,`SELECT count(*)::int invalid_scores FROM assessment_scores sc JOIN assessments a ON a.id=sc.assessment_id
    WHERE a.organisation_id=$1 AND (sc.score<0 OR sc.score>a.max_score)`,[org]);
  add('assessment_scores','Assessment score validation',Number(scores.invalid_scores)===0,scores);

  const fees=await one<any>(db,`SELECT
      count(*)::int assigned_fees,
      count(*) FILTER(WHERE e.status='active' AND f.mandatory=true AND sf.id IS NULL)::int missing_mandatory
    FROM enrolments e
    JOIN classrooms c ON c.id=e.classroom_id
    LEFT JOIN fee_items f ON f.organisation_id=e.organisation_id AND f.academic_year_id=e.academic_year_id
      AND f.mandatory=true AND (f.grade_level_id IS NULL OR f.grade_level_id=c.grade_level_id)
    LEFT JOIN student_fees sf ON sf.student_id=e.student_id AND sf.fee_item_id=f.id
    WHERE e.organisation_id=$1`,[org]);
  add('fees','Mandatory fee assignment',Number(fees.missing_mandatory)===0,fees);

  const negativeBalances=await one<any>(db,`SELECT count(*)::int negative_balances FROM (
    SELECT sf.id,(sf.amount_due-sf.discount)-COALESCE(sum(p.amount) FILTER(WHERE p.voided_at IS NULL),0) balance
    FROM student_fees sf LEFT JOIN payments p ON p.student_fee_id=sf.id
    WHERE sf.organisation_id=$1 GROUP BY sf.id
  ) x WHERE balance < -0.01`,[org]);
  add('payments','Fee ledger balances',Number(negativeBalances.negative_balances)===0,negativeBalances);

  const journalIntegrity=await one<any>(db,`SELECT count(*)::int unbalanced_entries FROM (
    SELECT je.id
    FROM finance_journal_entries je
    JOIN finance_journal_lines jl ON jl.journal_entry_id=je.id
    WHERE je.organisation_id=$1 AND je.status='posted'
    GROUP BY je.id
    HAVING abs(COALESCE(sum(jl.debit),0)-COALESCE(sum(jl.credit),0))>0.01
  ) x`,[org]);
  add('finance_journal_balance','Posted journals balance',Number(journalIntegrity.unbalanced_entries)===0,journalIntegrity);

  const receiptIntegrity=await one<any>(db,`SELECT count(*)::int mismatched_receipts FROM (
    SELECT r.id,r.amount,
      COALESCE((SELECT sum(ra.amount) FROM finance_student_receipt_allocations ra WHERE ra.receipt_id=r.id),0) allocations,
      COALESCE((SELECT sum(c.original_amount) FROM student_account_credits c WHERE c.source_receipt_id=r.id AND c.status<>'voided'),0) credits
    FROM finance_student_receipts r
    WHERE r.organisation_id=$1 AND r.status<>'voided'
  ) x WHERE abs(x.amount-x.allocations-x.credits)>0.01`,[org]);
  add('finance_receipt_reconciliation','Student receipts reconcile to allocations and credits',Number(receiptIntegrity.mismatched_receipts)===0,receiptIntegrity);

  const eodHealth=await one<any>(db,`SELECT
    count(*) FILTER(WHERE status='failed')::int failed,
    count(*) FILTER(WHERE status='completed')::int completed,
    max(completed_at) FILTER(WHERE status='completed') latest_completed
    FROM finance_eod_runs WHERE organisation_id=$1`,[org]);
  add('finance_eod','End-of-day processing',Number(eodHealth.failed)===0,eodHealth,Number(eodHealth.failed)>0?'warning':'info');

  const admissions=await one<any>(db,`SELECT count(*)::int total,
    count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM admission_status_history h WHERE h.application_id=admission_applications.id))::int without_history
    FROM admission_applications WHERE organisation_id=$1`,[org]);
  add('admissions','Admission tracking history',Number(admissions.without_history)===0,admissions);

  const timetable=await one<any>(db,`SELECT count(*)::int entries,
    count(*) FILTER(WHERE end_time<=start_time)::int invalid_times FROM timetable_entries WHERE organisation_id=$1`,[org]);
  add('timetable','Timetable entries',Number(timetable.invalid_times)===0&&Number(timetable.entries)>0,timetable,'warning');

  const reportWorkflow=await one<any>(db,`SELECT count(*)::int reports,
    count(*) FILTER(WHERE workflow_status='approved' AND headteacher_comment IS NULL)::int invalid_approved
    FROM report_comments WHERE organisation_id=$1`,[org]);
  add('reports','Report approval workflow',Number(reportWorkflow.invalid_approved)===0,reportWorkflow);

  const portal=await one<any>(db,`SELECT
    (SELECT count(*) FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id WHERE g.organisation_id=$1)::int guardian_links,
    (SELECT count(*) FROM student_portal_access spa JOIN students s ON s.id=spa.student_id WHERE s.organisation_id=$1 AND spa.is_active=true)::int student_access`,[org]);
  add('portals','Portal access provisioned',Number(portal.guardian_links)>0&&Number(portal.student_access)>0,portal,'warning');

  const communicationQueue=await one<any>(db,`SELECT
    count(*) FILTER(WHERE status='queued')::int queued,
    count(*) FILTER(WHERE status='pending_configuration')::int pending_configuration,
    count(*) FILTER(WHERE status='failed')::int failed,
    count(*) FILTER(WHERE status='sending' AND COALESCE(last_attempt_at,created_at)<now()-interval '10 minutes')::int stuck_sending,
    count(*) FILTER(WHERE status='sent')::int sent
    FROM communication_outbox WHERE organisation_id=$1`,[org]);
  add('communication_queue','Notification delivery queue',
    Number(communicationQueue.failed)===0&&Number(communicationQueue.stuck_sending)===0,
    communicationQueue,
    'warning');

  const providers=providerStatus(config);
  add('email_provider','Email provider configuration',providers.email.configured,providers.email,providers.email.configured?'info':'warning');
  if(providers.email.provider==='brevo'&&providers.email.configured){
    try{
      const verification=await validateBrevoConnection(config);
      add('email_provider_auth','Brevo authentication and sender',Boolean(verification.authenticated&&verification.senderReady),verification,'warning');
    }catch(error:any){
      add('email_provider_auth','Brevo authentication and sender',false,{error:String(error?.message||error)},'warning');
    }
  }
  add('sms_provider','SMS provider',providers.sms.configured,providers.sms,providers.sms.configured?'info':'warning');
  add('whatsapp_provider','WhatsApp provider',providers.whatsapp.configured,providers.whatsapp,providers.whatsapp.configured?'info':'warning');
  add('payments_provider','Online payment provider',providers.payments.configured,providers.payments,providers.payments.configured?'info':'warning');

  const summary={
    passed:checks.filter(x=>x.status==='pass').length,
    warnings:checks.filter(x=>x.status==='warning').length,
    failed:checks.filter(x=>x.status==='fail').length,
    total:checks.length
  };
  return{generatedAt:new Date().toISOString(),summary,checks};
});

app.get('/api/audit',async request=>{
  const a=await authorize(request,db,config,'system.logs.view');
  const q=z.object({q:z.string().max(120).optional(),action:z.string().max(120).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
  const like=q.q?'%'+q.q+'%':null;
  const rows=(await db.query(`SELECT * FROM school_audit_logs WHERE organisation_id=$1
    AND ($2::text IS NULL OR action=$2)
    AND ($3::text IS NULL OR action ILIKE $3 OR resource_type ILIKE $3 OR COALESCE(resource_id,'') ILIKE $3 OR metadata::text ILIKE $3)
    ORDER BY created_at DESC LIMIT $4`,[a.core.organisation_id,q.action??null,like,q.limit])).rows;
  const users=await fetchCoreUsers(a.core.organisation_id);
  const names=new Map(users.map((u:any)=>[u.id,(u.first_name+' '+u.last_name).trim()]));
  return rows.map((r:any)=>({
    ...r,
    performed_by:names.get(r.actor_os_user_id)||r.actor_os_user_id||'System',
    performed_on:r.metadata?.performedOn||r.metadata?.name||r.metadata?.studentName||r.resource_id||r.resource_type,
    performed_at:r.created_at
  }));
});
app.get('/api/system/request-logs',async request=>{
  const a=await authorize(request,db,config,'system.logs.view');
  const q=z.object({q:z.string().max(120).optional(),status:z.coerce.number().int().optional(),method:z.string().max(12).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
  const like=q.q?'%'+q.q+'%':null;
  const rows=(await db.query(`SELECT * FROM system_request_logs WHERE organisation_id=$1
    AND ($2::int IS NULL OR status_code=$2) AND ($3::text IS NULL OR method=$3)
    AND ($4::text IS NULL OR path ILIKE $4 OR request_id ILIKE $4)
    ORDER BY created_at DESC LIMIT $5`,[a.core.organisation_id,q.status??null,q.method??null,like,q.limit])).rows;
  const users=await fetchCoreUsers(a.core.organisation_id);
  const names=new Map(users.map((u:any)=>[u.id,(u.first_name+' '+u.last_name).trim()]));
  return rows.map((r:any)=>({
    ...r,
    performed_by:names.get(r.actor_os_user_id)||r.actor_os_user_id||'Public / System',
    performed_on:r.path,
    performed_at:r.created_at
  }));
});
app.get('/api/system/change-logs',async request=>{
  const a=await authorize(request,db,config,'system.logs.view');
  const q=z.object({q:z.string().max(120).optional(),resourceType:z.string().max(120).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
  const like=q.q?'%'+q.q+'%':null;
  const rows=(await db.query(`SELECT * FROM school_change_logs WHERE organisation_id=$1
    AND ($2::text IS NULL OR resource_type=$2)
    AND ($3::text IS NULL OR action ILIKE $3 OR resource_type ILIKE $3 OR COALESCE(performed_on,'') ILIKE $3 OR old_value::text ILIKE $3 OR new_value::text ILIKE $3)
    ORDER BY created_at DESC LIMIT $4`,[a.core.organisation_id,q.resourceType??null,like,q.limit])).rows;
  const users=await fetchCoreUsers(a.core.organisation_id);
  const names=new Map(users.map((u:any)=>[u.id,(u.first_name+' '+u.last_name).trim()]));
  return rows.map((r:any)=>({
    ...r,
    performed_by:names.get(r.actor_os_user_id)||r.actor_os_user_id||'System',
    performed_at:r.created_at
  }));
});
app.get('/api/system/errors',async request=>{
  const a=await authorize(request,db,config,'system.logs.view');
  const q=z.object({state:z.enum(['open','resolved','all']).default('open'),q:z.string().max(120).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
  const like=q.q?'%'+q.q+'%':null;
  return (await db.query(`SELECT * FROM system_errors WHERE (organisation_id=$1 OR organisation_id IS NULL)
    AND ($2='all' OR ($2='open' AND resolved_at IS NULL) OR ($2='resolved' AND resolved_at IS NOT NULL))
    AND ($3::text IS NULL OR message ILIKE $3 OR COALESCE(error_code,'') ILIKE $3 OR COALESCE(path,'') ILIKE $3 OR COALESCE(request_id,'') ILIKE $3)
    ORDER BY created_at DESC LIMIT $4`,[a.core.organisation_id,q.state,like,q.limit])).rows;
});
app.patch('/api/system/errors/:id',async request=>{
  const a=await authorize(request,db,config,'system.errors.manage');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({resolved:z.boolean(),resolutionNote:z.string().max(4000).optional()}).parse(request.body);
  const row=await one<any>(db,`UPDATE system_errors SET resolved_at=CASE WHEN $1 THEN now() ELSE NULL END,
    resolved_by_os_user_id=CASE WHEN $1 THEN $2::uuid ELSE NULL END,resolution_note=$3
    WHERE id=$4::uuid AND (organisation_id=$5::uuid OR organisation_id IS NULL) RETURNING *`,
    [b.resolved,a.core.id,b.resolutionNote??null,id,a.core.organisation_id]);
  await audit(a.core.organisation_id,a.core.id,b.resolved?'system_error.resolved':'system_error.reopened','system_error',id,{resolutionNote:b.resolutionNote??null});
  return row;
});

await registerFinanceLeaveRoutes(app,{
  db,config,authorize,maybeOne,one,tx,fail,audit,fetchCoreUsers,coreServiceHeaders,deliverCommunication,
  postFinanceJournal,postStudentPaymentLedger,postStudentFeeReceivable,reverseFinanceJournal,
  clearCoreUsersCache:(organisationId:string)=>coreUsersCache.delete(organisationId)
});

await registerAccountingRoutes(app,{
  db,config,authorize,one,maybeOne,tx,fail,audit,postFinanceJournal,updateStudentFeeStatus,postStudentPaymentLedger,postStudentFeeReceivable,reverseFinanceJournal,notifyContact
});

app.setErrorHandler(async(error:any,request,reply)=>{
  let status=Number(error.statusCode)||(error?.name==='ZodError'?400:500);
  if(error.code==='23505')status=409;
  if(error.code==='23503')status=409;
  if(error.code==='42P08')status=500;

  const validationMessage=error?.name==='ZodError'&&Array.isArray(error?.issues)
    ?error.issues.slice(0,6).map((issue:any)=>{
      const field=Array.isArray(issue.path)&&issue.path.length?issue.path.join('.'):'input';
      return field+': '+String(issue.message||'Invalid value');
    }).join('; ')
    :null;

  const message=error.code==='23505'
    ?'A record with the same unique value already exists'
    :error.code==='23503'
      ?'This record is still in use and cannot be deleted'
      :error.code==='42P08'
        ?'The database could not safely process this action. The error has been logged for review.'
        :validationMessage
          ?validationMessage
          :(error.message||'Unexpected school service error');

  const shouldPersist=status>=500||status===429;
  let errorId:string|undefined;
  if(shouldPersist){
    try{
      const actor=await requestActor(request);
      const row=await one<any>(db,`INSERT INTO system_errors(
        organisation_id,actor_os_user_id,request_id,method,path,status_code,error_code,message,details
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[
        actor.organisationId,actor.userId,String(request.id),request.method,String(request.url).split('?')[0],status,
        error.code??error.name??null,String(error.message||message).slice(0,8000),
        JSON.stringify({validation:error.validation??error.issues??null,stack:config.NODE_ENV==='production'?null:String(error.stack||'').slice(0,12000)})
      ]);
      errorId=row.id;
    }catch(logError){request.log.error({logError},'Could not persist application error')}
    request.log.error({err:error,errorId,status},'School request failed');
  }else{
    request.log.warn({status,code:error.code??error.name??null,path:String(request.url).split('?')[0]},'School request rejected');
  }
  reply.code(status>=400&&status<600?status:500).send({error:{message,errorId}});
});

let shutting=false;
let communicationRetryTimer:ReturnType<typeof setInterval>|undefined;
async function runCommunicationRetries(){
  try{
    const result=await retryCommunicationOutbox(db,config,config.COMMUNICATION_RETRY_BATCH_SIZE);
    if(result.attempted||result.sent||result.failed){
      app.log.info({communicationRetry:result},'Communication retry worker completed');
    }
  }catch(error){
    app.log.error({error},'Communication retry worker failed');
  }
}
async function shutdown(){
  if(shutting)return;
  shutting=true;
  if(communicationRetryTimer)clearInterval(communicationRetryTimer);
  await app.close();
  await db.end();
}
process.once('SIGTERM',()=>void shutdown().finally(()=>process.exit(0)));
process.once('SIGINT',()=>void shutdown().finally(()=>process.exit(0)));

await provisionDemoTeachers();

await app.listen({host:config.HOST,port:config.PORT});
console.log(`Revolt-X School listening on ${config.HOST}:${config.PORT}`);
void runCommunicationRetries();
communicationRetryTimer=setInterval(()=>void runCommunicationRetries(),config.COMMUNICATION_RETRY_INTERVAL_MS);
communicationRetryTimer.unref();
