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

const pg=new PGlite(),provider='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows as any[],rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'test-secret-with-at-least-thirty-two-characters',SCHOOL_APP_URL:'https://school.example.test',SCHOOL_SERVICE_KEY:'s'.repeat(32)});
const app=Fastify();let planId:string,fetchMock:ReturnType<typeof vi.spyOn>;
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
app.decorateRequest('auth',null);
app.addHook('onRequest',async request=>{(request as any).auth={organisationId:request.headers['x-test-provider']||provider,userId:actor,sessionId:null,permissions:['commercial.read','commercial.manage','commercial.billing']}});
app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof z.ZodError?400:(error as any).statusCode||500).send({error:{message:error.message}}));
beforeAll(async()=>{
  const dir=new URL('../../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())await pg.exec(readFileSync(new URL(file,dir),'utf8'));
  await saasRoutes(app,{db,config});await internalSchoolRoutes(app,{db,config});registerCommercialSchoolReporting(app,{db,config});await app.ready();
  planId=(await client.query("SELECT id FROM saas_pricing_plans WHERE plan_key='basic' LIMIT 1")).rows[0].id;
},60000);
beforeEach(async()=>{
  await pg.exec('TRUNCATE organisations,users CASCADE;');
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
    const user=(await client.query('SELECT * FROM users WHERE id=$1',[result.administrator.id])).rows[0];expect(await bcrypt.compare(result.administrator.temporaryPassword,user.password_hash)).toBe(true);expect(user.must_change_password).toBe(true);
    expect(result.adminLoginUrl).toBe('https://school.example.test/s/alpha/admin-login');
    const history=await send('GET','/v1/commercial-control/schools/'+result.organisation.id);expect(history.json().invoices[0].invoice_no).toBe(invoice.invoice_no);expect(history.json().payments).toHaveLength(1);
    expect((await create(invoice)).statusCode).toBe(409);expect((await client.query("SELECT count(*) count FROM organisations WHERE slug='alpha'")).rows[0].count).toBe(1);
    const audit=await client.query('SELECT after_state::text state FROM audit_logs');expect(audit.rows.some(x=>x.state?.includes(result.administrator.temporaryPassword))).toBe(false);
    for(const schoolId of ['ALPHA',result.organisation.id]){const r=await internal('authenticate-admin',{schoolId,email:'alpha@example.test',password:result.administrator.temporaryPassword});expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({organisation_slug:'alpha',must_change_password:true,dedicated_admin:true})}
    const change=await internal('change-staff-password',{schoolId:result.organisation.id,userId:user.id,newPassword:'PersonalSecurePass123'});expect(change.statusCode,change.body).toBe(200);
    expect((await internal('authenticate-admin',{schoolId:'alpha',email:user.email,password:result.administrator.temporaryPassword})).statusCode).toBe(401);
    const login=await internal('authenticate-admin',{schoolId:'alpha',email:user.email,password:'PersonalSecurePass123'});expect(login.statusCode,login.body).toBe(200);expect(login.json().must_change_password).toBe(false);
  });
  it('rolls back a paid invoice claim on slug conflict and keeps provisioning failure retryable',async()=>{
    const invoice=await issue();await pay(invoice);await client.query("INSERT INTO organisations(name,slug) VALUES('Collision','alpha')");expect((await create(invoice)).statusCode).toBe(409);
    expect((await client.query('SELECT claimed_school_id FROM saas_school_orders WHERE id=$1',[invoice.id])).rows[0].claimed_school_id).toBeNull();await client.query("DELETE FROM organisations WHERE slug='alpha'");
    fetchMock.mockResolvedValue(json({error:{message:'School starting'}},503));const r=await create(invoice);expect(r.statusCode,r.body).toBe(201);expect(r.json().provisioning.status).toBe('failed');
    fetchMock.mockImplementation(async()=>json({provisioned:true,revoked:0}));const retry=await send('POST','/v1/commercial-control/schools/'+r.json().organisation.id+'/provision',{});expect(retry.statusCode,retry.body).toBe(200);expect((await create(invoice)).statusCode).toBe(409);
  });
  it('preserves an existing account password and prevents invoicing an inactive administrator',async()=>{
    await client.query("INSERT INTO users(email,password_hash,first_name,last_name,status) VALUES('alpha@example.test','existing-hash','Existing','Admin','disabled')");
    expect((await send('POST','/v1/commercial-control/school-orders',{school:school(),amount:100})).statusCode).toBe(409);
    await client.query("UPDATE users SET status='active' WHERE email='alpha@example.test'");const {result}=await paidSchool();expect(result.administrator.existingUser).toBe(true);expect(result.administrator.temporaryPassword).toBeNull();expect((await client.query("SELECT password_hash FROM users WHERE email='alpha@example.test'")).rows[0].password_hash).toBe('existing-hash');
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
