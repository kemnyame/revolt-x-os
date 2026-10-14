import {userRoutes} from './users.js';
import {readFileSync,readdirSync} from 'node:fs';
import bcrypt from 'bcryptjs';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {z} from 'zod';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import type {Db} from '../db/index.js';
import {loadConfig} from '../config.js';
import {saasRoutes} from './saas.js';
import {internalSchoolRoutes} from './internal-school.js';
import {registerCommercialSchoolReporting} from './school-reporting.js';
import {schoolAccessStatus,csvReport} from './commercial-reporting.js';
import {bootstrapSchoolStaffPasswords} from '../auth/school-password-policy.js';
import {applyOwnerPasswordPolicy} from '../auth/owner-password-policy.js';
import {authRoutes} from '../auth/routes.js';

const pg=new PGlite(),provider='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows as any[],rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'test-secret-with-at-least-thirty-two-characters',SCHOOL_APP_URL:'https://school.example.test',SCHOOL_SERVICE_KEY:'s'.repeat(32)});
const app=Fastify();let planId:string,fetchMock:ReturnType<typeof vi.spyOn>;
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
app.decorateRequest('auth',null);
app.addHook('onRequest',async request=>{(request as any).auth={organisationId:request.headers['x-test-provider']||provider,userId:actor,sessionId:null,permissions:['commercial.read','commercial.manage','commercial.billing','users.read','users.manage']}});
app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof z.ZodError?400:(error as any).statusCode||500).send({error:{message:error.message}}));
beforeAll(async()=>{
  const dir=new URL('../../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())await pg.exec(readFileSync(new URL(file,dir),'utf8'));
  await saasRoutes(app,{db,config});await internalSchoolRoutes(app,{db,config});await userRoutes(app,{db});await authRoutes(app,{db,config});registerCommercialSchoolReporting(app,{db,config});await app.ready();
  planId=(await client.query("SELECT id FROM saas_pricing_plans WHERE plan_key='basic' LIMIT 1")).rows[0].id;
},60000);
beforeEach(async()=>{
  await pg.exec('TRUNCATE organisations,users CASCADE;');
  await pg.exec('TRUNCATE auth_configuration_state;');
  // Cascading truncation also clears global roles; restore the production owner role.
  await pg.exec("INSERT INTO roles(organisation_id,key,name,is_system) VALUES(NULL,'owner','Organisation Owner',true);");
  await client.query("INSERT INTO organisations(id,name,slug) VALUES($1,'OEM','oem'),($2,'Other OEM','other-oem')",[provider,other]);
  await client.query("INSERT INTO users(id,email,password_hash,first_name,last_name) VALUES($1,'oem@example.test','test-hash','OEM','Operator')",[actor]);
  fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>json({provisioned:true,revoked:3}));
});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{await app.close();await pg.close()});
const school=(suffix='alpha')=>({name:'School '+suffix,slug:suffix,adminFirstName:'School',adminLastName:'Administrator',adminEmail:suffix+'@example.test',planId,billingFrequency:'monthly'});
const send=(method:'GET'|'POST',url:string,payload?:any,providerId=provider)=>app.inject({method,url,payload,headers:{'x-test-provider':providerId}});
async function issue(suffix='alpha',amount=100){const r=await send('POST','/v1/commercial-control/school-orders',{school:school(suffix),amount});expect(r.statusCode,r.body).toBe(201);return r.json()}
async function pay(invoice:any,amount=100,extra:any={}){return send('POST','/v1/commercial-control/school-orders/'+invoice.id+'/payments',{amount,paymentMethod:'bank_transfer',...extra})}
async function create(invoice:any){return send('POST','/v1/commercial-control/schools',{invoiceNumber:invoice.invoice_no})}
async function paidSchool(suffix='alpha'){const invoice=await issue(suffix);expect((await pay(invoice)).statusCode).toBe(201);const r=await create(invoice);expect(r.statusCode,r.body).toBe(201);return{invoice,result:r.json()}}
const internal=(path:string,payload:any)=>app.inject({method:'POST',url:'/v1/internal/school/'+path,payload,headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY}});

describe('paid school setup and primary administrator access',()=>{
  it('issues randomized invoices without creating a school, and rejects missing, foreign, unpaid and partially paid invoices',async()=>{
    const a=await issue(),b=await issue('beta');expect(a.invoice_no).toMatch(/^RX-[A-F0-9]{24}$/);expect(b.invoice_no).not.toBe(a.invoice_no);
    expect((await client.query('SELECT count(*) count FROM organisations')).rows[0].count).toBe(2);
    expect((await send('POST','/v1/commercial-control/schools',{})).statusCode).toBe(400);
    expect((await send('POST','/v1/commercial-control/schools',{invoiceNumber:'RX-UNKNOWN'})).statusCode).toBe(404);
    expect((await send('POST','/v1/commercial-control/schools',{invoiceNumber:a.invoice_no},other)).statusCode).toBe(404);
    expect((await create(a)).statusCode).toBe(409);expect((await pay(a,25)).json().invoice.status).toBe('part_paid');expect((await create(a)).statusCode).toBe(409);
    expect((await client.query('SELECT count(*) count FROM organisations')).rows[0].count).toBe(2);expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires ledger-backed payment, rejects void invoices and protects the paid school details',async()=>{
    const invoice=await issue();await client.query("UPDATE saas_school_orders SET status='paid',amount_paid=total WHERE id=$1",[invoice.id]);expect((await create(invoice)).statusCode).toBe(409);
    await client.query("UPDATE saas_school_orders SET status='void',amount_paid=0 WHERE id=$1",[invoice.id]);expect((await pay(invoice)).statusCode).toBe(409);expect((await create(invoice)).statusCode).toBe(409);
    expect((await send('POST','/v1/commercial-control/schools',{invoiceNumber:invoice.invoice_no,name:'Different school'})).statusCode).toBe(400);
  });
  it('deduplicates retried payments and rejects changed references, overpayment and invalid amounts',async()=>{
    const invoice=await issue('alpha',0.30),idempotencyKey='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const first=await pay(invoice,0.10,{idempotencyKey,providerReference:'BANK-001'});expect(first.statusCode,first.body).toBe(201);
    const retry=await pay(invoice,0.10,{idempotencyKey,providerReference:'BANK-001'});expect(retry.statusCode).toBe(200);expect(retry.json().duplicate).toBe(true);
    expect((await pay(invoice,0.11,{providerReference:'BANK-001'})).statusCode).toBe(409);
    expect((await pay(invoice,0.21)).statusCode).toBe(409);expect((await pay(invoice,0)).statusCode).toBe(400);expect((await pay(invoice,0.001)).statusCode).toBe(400);
    expect((await pay(invoice,0.20,{providerReference:'BANK-002'})).json().invoice.status).toBe('paid');
    expect((await pay(invoice,0.20,{providerReference:'BANK-002'})).statusCode).toBe(200);
    expect((await client.query('SELECT count(*) count FROM saas_school_order_payments')).rows[0].count).toBe(2);
  });
  it('creates one school from its paid invoice, transfers its payment history and generates a working temporary administrator password',async()=>{
    const {invoice,result}=await paidSchool();expect(result.invoiceNumber).toBe(invoice.invoice_no);expect(result.provisioning.status).toBe('completed');
    expect(result.administrator).toMatchObject({email:'alpha@example.test',existingUser:false,mustChangePassword:true});expect(result.administrator.temporaryPassword).toMatch(/^SchAdm!A1[0-9a-f]{32}$/);
    const user=(await client.query('SELECT * FROM users WHERE id=$1',[result.administrator.id])).rows[0];expect(await bcrypt.compare(result.administrator.temporaryPassword,user.password_hash)).toBe(false);expect(await bcrypt.compare(result.administrator.temporaryPassword,(await client.query('SELECT password_hash FROM school_credentials WHERE user_id=$1 AND organisation_id=$2',[user.id,result.organisation.id])).rows[0].password_hash)).toBe(true);expect(user.must_change_password).toBe(true);
    expect(result.adminLoginUrl).toBe('https://school.example.test/s/alpha/admin-login?admin='+user.id);
    expect(await bootstrapSchoolStaffPasswords(db,'LegacyDefaultPass123')).toBe(0);
    expect(await bcrypt.compare(result.administrator.temporaryPassword,(await client.query('SELECT password_hash FROM school_credentials WHERE user_id=$1 AND organisation_id=$2',[user.id,result.organisation.id])).rows[0].password_hash)).toBe(true);
    const history=await send('GET','/v1/commercial-control/schools/'+result.organisation.id);expect(history.json().invoices[0].invoice_no).toBe(invoice.invoice_no);expect(history.json().payments).toHaveLength(1);
    expect((await create(invoice)).statusCode).toBe(409);expect((await client.query("SELECT count(*) count FROM organisations WHERE slug='alpha'")).rows[0].count).toBe(1);
    const audit=await client.query('SELECT after_state::text state FROM audit_logs');expect(audit.rows.some(x=>x.state?.includes(result.administrator.temporaryPassword))).toBe(false);
    for(const schoolId of ['ALPHA',result.organisation.id]){const r=await internal('authenticate-admin',{schoolId,email:'alpha@example.test',password:result.administrator.temporaryPassword});expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({organisation_slug:'alpha',must_change_password:true,dedicated_admin:true})}
    const change=await internal('change-staff-password',{schoolId:result.organisation.id,userId:user.id,newPassword:'PersonalSecurePass123'});expect(change.statusCode,change.body).toBe(200);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:result.administrator.email,password:result.administrator.temporaryPassword})).statusCode).toBe(401);
    const login=await internal('authenticate-admin',{schoolId:'alpha',email:result.administrator.email,password:'PersonalSecurePass123'});expect(login.statusCode,login.body).toBe(200);expect(login.json().must_change_password).toBe(false);
  },15000);
  it('rolls back a paid invoice claim on slug conflict and keeps provisioning failure retryable',async()=>{
    const invoice=await issue();await pay(invoice);await client.query("INSERT INTO organisations(name,slug) VALUES('Collision','alpha')");expect((await create(invoice)).statusCode).toBe(409);
    expect((await client.query('SELECT claimed_school_id FROM saas_school_orders WHERE id=$1',[invoice.id])).rows[0].claimed_school_id).toBeNull();await client.query("DELETE FROM organisations WHERE slug='alpha'");
    fetchMock.mockResolvedValue(json({error:{message:'School starting'}},503));const r=await create(invoice);expect(r.statusCode,r.body).toBe(201);expect(r.json().provisioning.status).toBe('failed');
    fetchMock.mockImplementation(async()=>json({provisioned:true,revoked:0}));const retry=await send('POST','/v1/commercial-control/schools/'+r.json().organisation.id+'/provision',{});expect(retry.statusCode,retry.body).toBe(200);expect((await create(invoice)).statusCode).toBe(409);
  });
  it('creates an independent school administrator even when the same email belongs to an inactive OS account',async()=>{
    const os=(await client.query("INSERT INTO users(email,password_hash,first_name,last_name,status) VALUES('alpha@example.test','existing-hash','Existing','Admin','disabled') RETURNING id")).rows[0];
    const {result}=await paidSchool();expect(result.administrator.existingUser).toBe(false);expect(result.administrator.id).not.toBe(os.id);
    expect(result.administrator.temporaryPassword).toMatch(/^SchAdm!A1[0-9a-f]{32}$/);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:'alpha@example.test',password:result.administrator.temporaryPassword})).statusCode).toBe(200);
    expect(await bootstrapSchoolStaffPasswords(db,'LegacyDefaultPass123')).toBe(0);
    expect((await client.query('SELECT password_hash,status,first_name FROM users WHERE id=$1',[os.id])).rows[0]).toMatchObject({password_hash:'existing-hash',status:'disabled',first_name:'Existing'});
  });
  it('legacy staff initialization runs once and never restores disabled users, suspended memberships or changed passwords',async()=>{
    const {result}=await paidSchool();
    for(const [email,status,membership,mustChange] of [['legacy','invited','invited',true],['disabled','disabled','active',true],['suspended','active','suspended',true],['changed','active','active',false]] as const){
      const u=(await client.query('INSERT INTO users(email,password_hash,first_name,last_name,status,must_change_password) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[email+'@example.test','deliberate-password-hash',email,'Staff',status,mustChange])).rows[0];
      await client.query('INSERT INTO organisation_memberships(organisation_id,user_id,status,employee_number) VALUES($1,$2,$3,$4)',[result.organisation.id,u.id,membership,email]);
    }
    expect(await bootstrapSchoolStaffPasswords(db,'LegacyDefaultPass123')).toBe(1);expect(await bootstrapSchoolStaffPasswords(db,'DifferentDefaultPass123')).toBe(0);
    const users=(await client.query("SELECT u.*,sa.status school_status,m.status membership_status,sc.password_hash school_password_hash FROM users u JOIN organisation_memberships m ON m.user_id=u.id JOIN school_accounts sa ON sa.organisation_id=m.organisation_id AND sa.user_id=u.id JOIN school_credentials sc ON sc.user_id=u.id AND sc.organisation_id=m.organisation_id WHERE u.email IN('legacy@example.test','disabled@example.test','suspended@example.test','changed@example.test')")).rows;
    const legacy=users.find(x=>x.email==='legacy@example.test');expect(legacy.school_status).toBe('active');expect(legacy.status).toBe('invited');expect(await bcrypt.compare('LegacyDefaultPass123',legacy.school_password_hash)).toBe(true);expect(legacy.password_hash).toBe('deliberate-password-hash');
    for(const email of ['disabled','suspended','changed'])expect(users.find(x=>x.email===email+'@example.test').password_hash).toBe('deliberate-password-hash');
    expect(users.find(x=>x.email==='disabled@example.test').status).toBe('disabled');expect(users.find(x=>x.email==='suspended@example.test').membership_status).toBe('suspended');
  });
});

describe('school-specific payment and administrator reports',()=>{
  it('loads all invoices and payments for the selected school and excludes other schools and providers',async()=>{
    const {result}=await paidSchool(),beta=await paidSchool('beta');
    await client.query(`INSERT INTO saas_invoices(provider_organisation_id,customer_organisation_id,invoice_no,status,currency,subtotal,total,amount_paid,created_by)
      SELECT $1,$2,'HISTORY-'||n,'paid','GHS',1,1,1,$3 FROM generate_series(1,35) n`,[provider,result.organisation.id,actor]);
    await client.query(`INSERT INTO saas_subscription_payments(provider_organisation_id,customer_organisation_id,invoice_id,amount,currency,payment_method,recorded_by)
      SELECT $1,$2,id,1,'GHS','cash',$3 FROM saas_invoices WHERE customer_organisation_id=$2 AND invoice_no LIKE 'HISTORY-%'`,[provider,result.organisation.id,actor]);
    const r=await send('GET','/v1/commercial-control/support/school-billing?schoolId='+result.organisation.id);expect(r.statusCode,r.body).toBe(200);expect(r.json().invoices).toHaveLength(36);expect(r.json().payments).toHaveLength(36);expect(r.json().payments.every((x:any)=>x.customer_organisation_id===result.organisation.id)).toBe(true);
    expect((await send('GET','/v1/commercial-control/support/school-billing?schoolId='+beta.result.organisation.id,undefined,other)).statusCode).toBe(404);
    expect((await send('GET','/v1/commercial-control/support/school-billing')).statusCode).toBe(400);
  });
  it('requires a school and a valid reporting period, and forwards UTC date filters before loading logs',async()=>{
    const {result}=await paidSchool();fetchMock.mockClear();
    expect((await send('GET','/v1/commercial-control/support/admin-activity')).statusCode).toBe(400);
    expect((await send('GET','/v1/commercial-control/support/admin-activity?schoolId='+result.organisation.id+'&from=2026-10-11&to=2026-10-01')).statusCode).toBe(400);
    expect((await send('GET','/v1/commercial-control/support/admin-activity?schoolId='+result.organisation.id+'&from=2026-02-30')).statusCode).toBe(400);expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(json({rows:[{actor_os_user_id:actor,action:'staff.created',created_at:'2026-10-11T23:59:00Z'}],total:1}));
    const r=await send('GET','/v1/commercial-control/support/admin-activity?schoolId='+result.organisation.id+'&from=2026-10-01&to=2026-10-11');expect(r.statusCode,r.body).toBe(200);expect(r.json()[0]).toMatchObject({school_name:'School alpha',school_id:result.organisation.id,actor_email:'oem@example.test'});
    const url=new URL(String(fetchMock.mock.calls[0]![0]));expect(url.searchParams.get('organisationId')).toBe(result.organisation.id);expect(url.searchParams.get('to')).toBe('2026-10-11');
  });
  it('spools named school logs for the period and reports outages or incomplete exports honestly',async()=>{
    const {result}=await paidSchool(),path='/v1/commercial-control/support/admin-activity?schoolId='+result.organisation.id+'&format=csv&from=2026-10-01&to=2026-10-11';
    fetchMock.mockResolvedValue(json({rows:[{actor_os_user_id:actor,action:'fees.paid',created_at:'2026-10-11T12:00:00Z'}],total:1}));const r=await send('GET',path);expect(r.statusCode,r.body).toBe(200);expect(r.headers['content-type']).toContain('text/csv');expect(r.body).toContain('"School alpha"');expect(r.body).toContain('"OEM Operator"');expect(r.headers['content-disposition']).toContain('2026-10-01-2026-10-11.csv');
    fetchMock.mockResolvedValue(json({rows:[{}],total:10001}));expect((await send('GET',path)).statusCode).toBe(413);
    fetchMock.mockRejectedValue(new Error('Network unavailable'));expect((await send('GET',path)).statusCode).toBe(503);
    expect(csvReport([{name:'=1+1,\"quoted\"'}],[{key:'name',label:'School'}])).toContain('"\'=1+1,""quoted"""');
  });
  it('classifies suspended organisations, expired licences and archived schools as disabled',()=>{
    const row={organisation_status:'active',customer_status:'active',licence_status:'active',current_period_end:'2099-01-01'};expect(schoolAccessStatus(row)).toBe('active');
    for(const update of [{organisation_status:'suspended'},{customer_status:'archived'},{licence_status:'suspended'},{current_period_end:'2000-01-01'}])expect(schoolAccessStatus({...row,...update})).toBe('disabled');
  });
});

describe('administrator reset to its specific login',()=>{
  it('runs a deliberately changed owner override once and revokes old sessions without repeating it at startup',async()=>{
    const {result}=await paidSchool(),uid=result.administrator.id;
    const m=(await client.query("INSERT INTO organisation_memberships(organisation_id,user_id,employee_number) VALUES($1,$2,'OWNER') RETURNING id",[provider,uid])).rows[0];
    await client.query("INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id) SELECT $1,id,'organisation',$2 FROM roles WHERE key='owner'",[m.id,provider]);
    await client.query("INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[uid,provider,'a'.repeat(64)]);
    const revoke=vi.fn(async()=>{});expect(await applyOwnerPasswordPolicy(db,'OldConfiguredPass123',revoke)).toBe(0);expect(revoke).not.toHaveBeenCalled();
    expect(await applyOwnerPasswordPolicy(db,'ChangedConfiguredPass123',revoke)).toBe(1);expect(revoke).toHaveBeenCalledWith(uid);expect((await client.query('SELECT revoked_at FROM sessions')).rows[0].revoked_at).not.toBeNull();
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash('PersonalResetPass123',12),uid]);
    expect(await applyOwnerPasswordPolicy(db,'ChangedConfiguredPass123',revoke)).toBe(0);expect(revoke).toHaveBeenCalledTimes(1);expect(await bcrypt.compare('PersonalResetPass123',(await client.query('SELECT password_hash FROM users WHERE id=$1',[uid])).rows[0].password_hash)).toBe(true);
  });
  it('resets the school administrator, resolves its exact account without a school parameter and preserves the password after restart',async()=>{
    const {result}=await paidSchool(),uid=result.administrator.id;
    const owner=(await client.query("INSERT INTO organisation_memberships(organisation_id,user_id,employee_number,joined_at) VALUES($1,$2,'OWNER',now()-interval '10 days') RETURNING id",[provider,uid])).rows[0];
    await client.query("INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id) SELECT $1,id,'organisation',$2 FROM roles WHERE key='owner' AND organisation_id IS NULL",[owner.id,provider]);
    expect(await applyOwnerPasswordPolicy(db,'LegacyOwnerPass123')).toBe(0);
    const invite=await send('POST','/v1/commercial-control/schools/'+result.organisation.id+'/admin-invite',{});expect(invite.statusCode,invite.body).toBe(200);
    const link=new URL(invite.json().resetUrl),token=link.searchParams.get('token');expect(invite.json().adminLoginUrl).toBe(result.adminLoginUrl);
    const record=(await client.query('SELECT organisation_id,purpose FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL',[uid])).rows[0];expect(record).toMatchObject({organisation_id:result.organisation.id,purpose:'school_admin'});
    const reset=await send('POST','/v1/auth/password-reset/confirm',{token,password:'PersonalResetPass123',purpose:'school_admin'});expect(reset.statusCode,reset.body).toBe(200);expect(reset.json()).toMatchObject({userId:uid,email:'alpha@example.test',organisationSlug:'alpha'});
    expect(await applyOwnerPasswordPolicy(db,'LegacyOwnerPass123')).toBe(0);expect(await bootstrapSchoolStaffPasswords(db,'LegacyStaffPass123')).toBe(0);
    const context=await app.inject({url:'/v1/internal/school/admin-login-context?schoolId=alpha&adminUserId='+uid,headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY}});expect(context.statusCode,context.body).toBe(200);expect(context.json()).toMatchObject({id:uid,email:'alpha@example.test',organisation_slug:'alpha'});
    const signIn=await internal('authenticate-admin',{schoolId:'alpha',adminUserId:uid,email:context.json().email,password:'PersonalResetPass123'});expect(signIn.statusCode,signIn.body).toBe(200);expect(signIn.json().must_change_password).toBe(false);
    expect((await internal('authenticate-admin',{schoolId:'alpha',adminUserId:actor,email:context.json().email,password:'PersonalResetPass123'})).statusCode).toBe(401);
    expect((await internal('authenticate-admin',{schoolId:'alpha',adminUserId:uid,email:context.json().email,password:result.administrator.temporaryPassword})).statusCode).toBe(401);
    expect((await send('POST','/v1/auth/password-reset/confirm',{token,password:'DifferentSecurePass123',purpose:'school_admin'})).statusCode).toBe(401);
  },15000);
  it('rejects moving a reset link to another school even when the same administrator owns both schools',async()=>{
    const alpha=await paidSchool(),invoice=await issue('beta');await client.query("UPDATE saas_school_orders SET school_details=jsonb_set(school_details,'{adminEmail}',to_jsonb('alpha@example.test'::text)) WHERE id=$1",[invoice.id]);await pay(invoice);const beta=await create(invoice);expect(beta.statusCode,beta.body).toBe(201);
    const invite=await send('POST','/v1/commercial-control/schools/'+alpha.result.organisation.id+'/admin-invite',{}),token=new URL(invite.json().resetUrl).searchParams.get('token');
    const wrong=await send('POST','/v1/auth/password-reset/confirm',{token,password:'PersonalResetPass123',purpose:'school_admin',schoolId:'beta'});expect(wrong.statusCode).toBe(401);
    const right=await send('POST','/v1/auth/password-reset/confirm',{token,password:'PersonalResetPass123',purpose:'school_admin',schoolId:'alpha'});expect(right.statusCode,right.body).toBe(200);
  });
  it('stale primary administrator links cannot authenticate a replaced administrator or generate its reset',async()=>{
    const {result}=await paidSchool(),uid=result.administrator.id;
    await client.query("UPDATE organisations SET settings=jsonb_set(settings,'{primaryAdminUserId}',to_jsonb($1::text)) WHERE id=$2",[actor,result.organisation.id]);
    const context=await app.inject({url:'/v1/internal/school/admin-login-context?schoolId=alpha&adminUserId='+uid,headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY}});expect(context.statusCode).toBe(404);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:'alpha@example.test',password:result.administrator.temporaryPassword})).statusCode).toBe(401);
    expect((await send('POST','/v1/commercial-control/schools/'+result.organisation.id+'/admin-invite',{})).statusCode).toBe(404);
  });
});


describe('OS owner with administrator accounts across several schools',()=>{
  it('school creation, reassignment, first-login change and reset never overwrite the OS or another school password',async()=>{
    const osPassword='OwnerOsOriginalPass123';await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(osPassword,12),actor]);
    const owner=(await client.query("INSERT INTO organisation_memberships(organisation_id,user_id,status,joined_at) VALUES($1,$2,'active',now()-interval '10 days') RETURNING id",[provider,actor])).rows[0];
    await client.query("INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id) SELECT $1,id,'organisation',$2 FROM roles WHERE key='owner'",[owner.id,provider]);
    await client.query("INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[actor,provider,'o'.repeat(64)]);
    const before=(await client.query('SELECT password_hash,updated_at FROM users WHERE id=$1',[actor])).rows[0];
    const results:any[]=[];
    for(const name of ['alpha','beta']){
      const invoice=await issue(name);await client.query("UPDATE saas_school_orders SET school_details=jsonb_set(school_details,'{adminEmail}',to_jsonb('oem@example.test'::text)) WHERE id=$1",[invoice.id]);await pay(invoice);const response=await create(invoice);expect(response.statusCode,response.body).toBe(201);results.push(response.json());
    }
    const alpha=results[0],beta=results[1],betaPassword=beta.administrator.temporaryPassword;
    expect(alpha.administrator.temporaryPassword).not.toBe(betaPassword);expect(alpha.administrator.mustChangePassword).toBe(true);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:'oem@example.test',password:alpha.administrator.temporaryPassword})).statusCode).toBe(200);
    expect((await internal('change-staff-password',{schoolId:'alpha',userId:alpha.administrator.id,newPassword:'AlphaFirstPersonal123'})).statusCode).toBe(200);
    const assigned=await send('POST','/v1/commercial-control/schools/'+alpha.organisation.id+'/admin',{email:'oem@example.test',firstName:'OEM',lastName:'Owner',password:'AlphaReassignedPass123'});expect(assigned.statusCode,assigned.body).toBe(200);
    const invite=await send('POST','/v1/commercial-control/schools/'+alpha.organisation.id+'/admin-invite',{}),token=new URL(invite.json().resetUrl).searchParams.get('token');
    const reset=await send('POST','/v1/auth/password-reset/confirm',{token,password:'AlphaResetPersonal123',purpose:'school_admin'});expect(reset.statusCode,reset.body).toBe(200);
    const after=(await client.query('SELECT password_hash FROM users WHERE id=$1',[actor])).rows[0];expect(after.password_hash).toBe(before.password_hash);
    expect((await client.query('SELECT revoked_at FROM sessions WHERE organisation_id=$1',[provider])).rows[0].revoked_at).toBeNull();
    const login=await send('POST','/v1/auth/login',{email:'oem@example.test',password:osPassword});expect(login.statusCode,login.body).toBe(200);expect(login.json().organisationId).toBe(provider);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:'oem@example.test',password:'AlphaResetPersonal123'})).statusCode).toBe(200);
    expect((await internal('authenticate-admin',{schoolId:'beta',email:'oem@example.test',password:betaPassword})).statusCode).toBe(200);
    expect((await internal('authenticate-admin',{schoolId:'beta',email:'oem@example.test',password:'AlphaResetPersonal123'})).statusCode).toBe(401);
    expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('/revoke-user-sessions')).every(([,init])=>JSON.parse(init!.body as string).organisationId===alpha.organisation.id)).toBe(true);
  },25000);
  it('selects an active OS workspace when an older membership is suspended',async()=>{
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash('ActiveOwnerPass123',12),actor]);
    await client.query("INSERT INTO organisation_memberships(organisation_id,user_id,status,joined_at) VALUES($1,$3,'suspended',now()-interval '10 days'),($2,$3,'active',now())",[other,provider,actor]);
    const result=await send('POST','/v1/auth/login',{email:'oem@example.test',password:'ActiveOwnerPass123'});expect(result.statusCode,result.body).toBe(200);expect(result.json().organisationId).toBe(provider);
    expect((await send('POST','/v1/auth/login',{email:'oem@example.test',password:'ActiveOwnerPass123',organisationId:other})).statusCode).toBe(401);
  });
  it('requests OS recovery privately and keeps school tokens reusable',async()=>{
    const {result}=await paidSchool();
    const os=(await client.query("INSERT INTO users(email,password_hash,first_name,last_name,status) VALUES('alpha@example.test','os-original','OS','Operator','active') RETURNING id")).rows[0];
    await client.query("INSERT INTO organisation_memberships(organisation_id,user_id,employee_number) VALUES($1,$2,'OS-OPERATOR')",[provider,os.id]);
    const invite=await send('POST','/v1/commercial-control/schools/'+result.organisation.id+'/admin-invite',{}),schoolToken=new URL(invite.json().resetUrl).searchParams.get('token');
    fetchMock.mockResolvedValue(json({sent:true}));fetchMock.mockClear();
    const response=await send('POST','/v1/auth/password-reset/request',{email:'alpha@example.test'});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({accepted:true});expect(fetchMock).toHaveBeenCalledOnce();
    const body=JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);expect(body.email).toBe('alpha@example.test');expect(body.resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const unknown=await send('POST','/v1/auth/password-reset/request',{email:'unknown@example.test'});expect(unknown.json()).toEqual(response.json());expect(fetchMock).toHaveBeenCalledOnce();
    const reset=await send('POST','/v1/auth/password-reset/confirm',{token:body.resetToken,password:'NewOsPersonal123',purpose:'account'});expect(reset.statusCode,reset.body).toBe(200);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:'alpha@example.test',password:result.administrator.temporaryPassword})).statusCode).toBe(200);
    fetchMock.mockResolvedValue(json({revoked:0}));expect((await send('POST','/v1/auth/password-reset/confirm',{token:schoolToken,password:'NewSchoolPersonal123',purpose:'school_admin'})).statusCode).toBe(200);
  },15000);
});

it('school staff creation and temporary resets preserve the existing OS account and use the scoped Staff ID password',async()=>{
  const {result}=await paidSchool(),osHash=await bcrypt.hash('StaffOsOriginal123',12);await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[osHash,actor]);
  const created=await internal('users',{organisationId:result.organisation.id,actorUserId:result.administrator.id,email:'oem@example.test',firstName:'Existing',lastName:'Owner',roleKey:'owner',temporaryPassword:'StaffFirstTemporary123'});expect(created.statusCode,created.body).toBe(201);const membership=created.json();
  const reset=await internal('users/'+membership.id+'/password-reset',{organisationId:result.organisation.id,actorUserId:result.administrator.id,temporaryPassword:'StaffSecondTemporary123'});expect(reset.statusCode,reset.body).toBe(200);
  const signedIn=await internal('authenticate-staff',{schoolId:'alpha',staffId:membership.employee_number,password:'StaffSecondTemporary123'});expect(signedIn.statusCode,signedIn.body).toBe(200);expect(signedIn.json().must_change_password).toBe(true);
  expect((await internal('authenticate-staff',{schoolId:'alpha',staffId:membership.employee_number,password:'StaffOsOriginal123'})).statusCode).toBe(401);
  expect((await client.query('SELECT password_hash FROM users WHERE id=$1',[actor])).rows[0].password_hash).toBe(osHash);
  const change=await internal('change-staff-password',{schoolId:'alpha',userId:membership.user_id,newPassword:'StaffPersonalSchool123'});expect(change.statusCode,change.body).toBe(200);
  expect((await internal('authenticate-staff',{schoolId:'alpha',staffId:membership.employee_number,password:'StaffPersonalSchool123'})).statusCode).toBe(200);expect((await client.query('SELECT password_hash FROM users WHERE id=$1',[actor])).rows[0].password_hash).toBe(osHash);
},15000);

it('staff login accepts both assigned Staff ID forms and school UUIDs while keeping each school password isolated',async()=>{
  const alpha=(await paidSchool('alpha')).result,beta=(await paidSchool('beta')).result;
  async function add(result:any,password:string){
    const response=await internal('users',{organisationId:result.organisation.id,actorUserId:result.administrator.id,email:'fixture-shared-staff@example.test',firstName:'Test',lastName:'Teacher',roleKey:'owner',temporaryPassword:password});
    expect(response.statusCode,response.body).toBe(201);const membership=response.json();
    const activated=await internal('users/'+membership.id+'/password-reset',{organisationId:result.organisation.id,actorUserId:result.administrator.id,temporaryPassword:password});
    expect(activated.statusCode,activated.body).toBe(200);return membership;
  }
  const a=await add(alpha,'FixtureAlphaPass123!'),b=await add(beta,'FixtureBetaPass123!');
  expect(a.user_id).not.toBe(b.user_id);expect(a.employee_number).toBe(b.employee_number);
  for(const schoolId of [' alpha ','ALPHA',alpha.organisation.id])for(const staffId of [a.employee_number,' '+a.login_staff_id.toLowerCase()+' ']){
    const response=await internal('authenticate-staff',{schoolId,staffId,password:'FixtureAlphaPass123!'});
    expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({id:a.user_id,organisation_id:alpha.organisation.id,must_change_password:true});
  }
  expect((await internal('authenticate-staff',{schoolId:'beta',staffId:b.employee_number,password:'FixtureAlphaPass123!'})).statusCode).toBe(401);
  expect((await internal('authenticate-staff',{schoolId:'beta',staffId:a.login_staff_id,password:'FixtureBetaPass123!'})).statusCode).toBe(401);
  expect((await internal('authenticate-staff',{schoolId:'beta',staffId:b.login_staff_id,password:'FixtureBetaPass123!'})).statusCode).toBe(200);
  await client.query("UPDATE organisation_memberships SET status='suspended' WHERE id=$1",[a.id]);
  expect((await internal('authenticate-staff',{schoolId:'alpha',staffId:a.employee_number,password:'FixtureAlphaPass123!'})).statusCode).toBe(403);
  expect((await internal('authenticate-staff',{schoolId:'beta',staffId:b.employee_number,password:'FixtureBetaPass123!'})).statusCode).toBe(200);
},20000);

it('rejects duplicates only within a school and keeps profile edits, status and Staff ID aliases isolated',async()=>{
  const alpha=(await paidSchool('alpha')).result,beta=(await paidSchool('beta')).result;
  const add=(school:any)=>internal('users',{organisationId:school.organisation.id,actorUserId:school.administrator.id,email:'same@example.test',firstName:school.organisation.slug,lastName:'Teacher',roleKey:'owner',temporaryPassword:'InitialStaffPass123'});
  const a=(await add(alpha)).json(),b=(await add(beta)).json();expect(a.id).toBeTruthy();expect(b.id).toBeTruthy();expect(a.user_id).not.toBe(b.user_id);expect(a.employee_number).toBe(b.employee_number);
  const duplicate=await add(alpha);expect(duplicate.statusCode,duplicate.body).toBe(409);expect(duplicate.json().error.message).toContain('this school');
  const update=await app.inject({method:'PATCH',url:'/v1/internal/school/users/'+a.id,headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY},payload:{organisationId:alpha.organisation.id,actorUserId:alpha.administrator.id,firstName:'Changed only Alpha'}});expect(update.statusCode,update.body).toBe(200);
  const profiles=(await client.query("SELECT sa.organisation_id,sa.first_name FROM school_accounts sa WHERE email='same@example.test'")).rows;
  expect(profiles.find(x=>x.organisation_id===alpha.organisation.id).first_name).toBe('Changed only Alpha');expect(profiles.find(x=>x.organisation_id===beta.organisation.id).first_name).toBe('beta');
  // The same alias is valid in different schools, but may never identify two members in one school.
  await client.query("UPDATE organisation_memberships SET login_staff_id='LOCAL-STAFF' WHERE id=ANY($1::uuid[])",[[a.id,b.id]]);
  await expect(client.query('UPDATE organisation_memberships SET employee_number=$1 WHERE organisation_id=$2 AND user_id=$3',['LOCAL-STAFF',alpha.organisation.id,alpha.administrator.id])).rejects.toMatchObject({code:'23505'});
  const reset=(school:any,m:any)=>internal('users/'+m.id+'/password-reset',{organisationId:school.organisation.id,actorUserId:school.administrator.id,temporaryPassword:'IndependentStaff123'});
  expect((await reset(alpha,a)).statusCode).toBe(200);expect((await reset(beta,b)).statusCode).toBe(200);
  const suspended=await app.inject({method:'PATCH',url:'/v1/internal/school/users/'+a.id+'/status',headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY},payload:{organisationId:alpha.organisation.id,actorUserId:alpha.administrator.id,status:'suspended'}});expect(suspended.statusCode,suspended.body).toBe(200);
  expect((await internal('authenticate-staff',{schoolId:'alpha',staffId:'LOCAL-STAFF',password:'IndependentStaff123'})).statusCode).toBe(403);
  expect((await internal('authenticate-staff',{schoolId:'beta',staffId:'LOCAL-STAFF',password:'IndependentStaff123'})).statusCode).toBe(200);
},30000);

it('OS user administration also scopes school creation and profile updates to the current school',async()=>{
  const alpha=(await paidSchool('alpha')).result,beta=(await paidSchool('beta')).result;
  const add=async(school:any)=>{const r=await send('POST','/v1/users',{email:'staff@example.test',firstName:'School',lastName:school.organisation.slug,roleKey:'owner'},school.organisation.id);expect(r.statusCode,r.body).toBe(201);return r.json()};
  const a=await add(alpha),b=await add(beta);expect(a.employee_number).toBe(b.employee_number);expect(a.user_id).not.toBe(b.user_id);
  const change=await app.inject({method:'PATCH',url:'/v1/users/'+a.id,headers:{'x-test-provider':alpha.organisation.id},payload:{firstName:'Local change'}});expect(change.statusCode,change.body).toBe(200);expect(change.json().email).toBe('staff@example.test');
  const read=await send('GET','/v1/users',undefined,beta.organisation.id);expect(read.statusCode,read.body).toBe(200);expect(read.json().find((x:any)=>x.id===b.user_id).first_name).toBe('School');
},15000);
