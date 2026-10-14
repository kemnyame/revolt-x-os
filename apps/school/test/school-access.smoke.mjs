import test, {beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { registerSchoolAccessRoutes, schoolAuthValidationMessage, schoolIdentifier, ensureSchoolLoginMembership, revokeSchoolUserSessions, withSchoolAuthThrottle } from '../dist/school-access.js';
import { recordPortalLoginFailure, assertPortalLoginAllowed } from '../dist/reliability.js';
import { authorize } from '../dist/auth.js';
import { createHash } from 'node:crypto';
import { authenticateCoreSchoolLogin } from '../dist/core-school-login.js';

const pg=new PGlite();
await pg.exec(`CREATE TABLE portal_login_throttle(portal text,throttle_key text,failures int,window_started_at timestamptz,blocked_until timestamptz,last_failure_at timestamptz,updated_at timestamptz,PRIMARY KEY(portal,throttle_key));
 CREATE TABLE school_sessions(id serial,token_hash text,os_user_id uuid,organisation_id uuid,revoked_at timestamptz,expires_at timestamptz,last_used_at timestamptz DEFAULT now(),core_context jsonb);
 CREATE TABLE school_memberships(organisation_id uuid,os_user_id uuid,role text,status text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(organisation_id,os_user_id));
 CREATE TABLE school_roles(organisation_id uuid,key text,name text,description text,portal_mode text,can_teach boolean,is_system boolean,is_active boolean);
 CREATE TABLE school_profiles(organisation_id uuid,tenant_slug text,school_name text);
 CREATE TABLE school_security_settings(organisation_id uuid,idle_timeout_minutes int);`);
const db={query:async(sql,params)=>{const result=await pg.query(sql,params);return{rows:result.rows,rowCount:result.rows.length||result.affectedRows||0}}};
const user='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222';
const config={NODE_ENV:'test',CORE_OS_URL:'https://core.example.test',CORE_SERVICE_KEY:'test-only-service-key'};
beforeEach(()=>pg.exec('TRUNCATE portal_login_throttle,school_sessions,school_memberships,school_roles,school_security_settings;'));
after(()=>pg.close());

test('service startup failures do not consume the staff password failure allowance',async()=>{
  let time=0;
  const request={ip:'192.0.2.10',body:{schoolId:'alpha',staffId:'STF-000001',password:'FixtureOnly123!'}};
  await assert.rejects(withSchoolAuthThrottle(db,'school_staff',request,()=>authenticateCoreSchoolLogin(config,'staff',request.body,{
    fetchCore:async()=>new Response('Service starting',{status:429}),now:()=>time,wait:async ms=>{time+=ms}
  })),{statusCode:429});
  assert.equal((await db.query('SELECT count(*) count FROM portal_login_throttle')).rows[0].count,0);
  await assert.rejects(withSchoolAuthThrottle(db,'school_staff',request,()=>authenticateCoreSchoolLogin(config,'staff',request.body,{
    fetchCore:async()=>new Response(JSON.stringify({error:{code:'INVALID_CREDENTIALS',message:'Invalid school, Staff ID or password'}}),{status:401}),wait:async()=>{}
  })),{statusCode:401});
  const failures=(await db.query('SELECT failures FROM portal_login_throttle')).rows;
  assert.equal(failures.length,2);assert.ok(failures.every(row=>row.failures===1));
});
const response=(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
async function appFor(t,fetchCore,passwordChangedAudit){
  const app=Fastify();t.after(()=>app.close());
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof z.ZodError?400:error.statusCode||500).send({error:{message:error instanceof z.ZodError?schoolAuthValidationMessage(error.issues):error.message}}));
  registerSchoolAccessRoutes(app,{db,config,fetchCore,passwordChangedAudit,requireCoreServiceRequest:request=>{if(request.headers['x-revolt-service-key']!==config.CORE_SERVICE_KEY)throw Object.assign(new Error('Service credential required'),{statusCode:401})}});
  return app;
}

test('reset accepts omitted and blank school IDs, uses the verified school and expires the cookie',async t=>{
  const sent=[],app=await appFor(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return response({reset:true,email:'admin@example.test',userId:user,organisationId:org,organisationSlug:'alpha'})});
  for(const schoolId of [undefined,'','   ']) {
    const r=await app.inject({method:'POST',url:'/api/auth/admin-password-reset',payload:{token:'t'.repeat(43),newPassword:'NewSecurePass123',schoolId}});
    assert.equal(r.statusCode,200,r.body);assert.equal(r.json().adminLoginUrl,'/s/alpha/admin-login?admin='+user);assert.equal('schoolId' in sent.at(-1),false);assert.equal(sent.at(-1).purpose,'school_admin');assert.match(r.headers['set-cookie'],/Max-Age=0/);
  }
});

test('invalid reset input is actionable and never reaches Core',async t=>{
  const app=await appFor(t,()=>assert.fail('Invalid input must not reach Core'));
  const badToken=await app.inject({method:'POST',url:'/api/auth/admin-password-reset',payload:{token:'',newPassword:'NewSecurePass123'}});
  assert.equal(badToken.statusCode,400);assert.match(badToken.json().error.message,/link is incomplete or invalid/);assert.doesNotMatch(badToken.body,/Too small/);
  assert.equal(schoolAuthValidationMessage(schoolIdentifier.safeParse('').error.issues),'Select your school before signing in.');
});

test('expired reset and unavailable Core leave local sessions unchanged',async t=>{
  await db.query('INSERT INTO school_sessions(token_hash,os_user_id) VALUES($1,$2)',['old',user]);
  let unavailable=false;
  const app=await appFor(t,async()=>{if(unavailable)throw new Error('network unavailable');return response({error:{message:'Reset link is invalid or has expired'}},401)});
  const payload={token:'t'.repeat(43),newPassword:'NewSecurePass123'};
  assert.equal((await app.inject({method:'POST',url:'/api/auth/admin-password-reset',payload})).statusCode,401);
  unavailable=true;assert.equal((await app.inject({method:'POST',url:'/api/auth/admin-password-reset',payload})).statusCode,503);
  assert.equal((await db.query('SELECT revoked_at FROM school_sessions')).rows[0].revoked_at,null);
});

test('trusted revocation signs out every tenant while preserving only an explicitly retained session',async t=>{
  const keep='a'.repeat(64);
  await db.query('INSERT INTO school_sessions(token_hash,os_user_id,organisation_id) VALUES($1,$2,$3),($4,$2,$5)',['old',user,org,keep,'33333333-3333-4333-8333-333333333333']);
  const app=await appFor(t,()=>assert.fail());
  assert.equal((await app.inject({method:'POST',url:'/api/internal/revoke-user-sessions',payload:{userId:user}})).statusCode,401);
  const r=await app.inject({method:'POST',url:'/api/internal/revoke-user-sessions',headers:{'x-revolt-service-key':config.CORE_SERVICE_KEY},payload:{userId:user,keepSessionHash:keep}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().revoked,1);assert.equal(await revokeSchoolUserSessions(db,user),1);
});

test('staff and administrator sign-in cannot reactivate disabled memberships or roles',async()=>{
  await db.query("INSERT INTO school_roles(organisation_id,key,is_active) VALUES($1,'teacher',true),($1,'school_admin',true)",[org]);
  await db.query("INSERT INTO school_memberships VALUES($1,$2,'teacher','disabled',now())",[org,user]);
  for(const admin of [false,true])await assert.rejects(ensureSchoolLoginMembership(db,org,user,admin?'school_admin':'teacher',admin),{statusCode:403});
  assert.equal((await db.query('SELECT status FROM school_memberships')).rows[0].status,'disabled');
  await db.query("UPDATE school_memberships SET status='active'");await db.query("UPDATE school_roles SET is_active=false WHERE key='teacher'");
  await assert.rejects(ensureSchoolLoginMembership(db,org,user,'teacher'),{statusCode:403});
  await db.query('DELETE FROM school_memberships');await db.query("UPDATE school_roles SET is_active=true");
  assert.equal((await ensureSchoolLoginMembership(db,org,user,'teacher')).role,'teacher');
});

test('established sessions lose access immediately when the assigned role is disabled',async()=>{
  const token='rxs_test',core={id:user,organisation_id:org,permissions:[]};
  await db.query("INSERT INTO school_roles(organisation_id,key,is_active) VALUES($1,'teacher',false)",[org]);
  await db.query("INSERT INTO school_memberships VALUES($1,$2,'teacher','active',now())",[org,user]);
  await db.query("INSERT INTO school_sessions(token_hash,os_user_id,organisation_id,core_context,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),user,org,JSON.stringify(core)]);
  await assert.rejects(authorize({headers:{cookie:'rx_school_session='+token}},db,config),{statusCode:403});
});

test('first password change retains the actual authorized token despite a stale cookie or header',async()=>{
  const token='rxs_current',hash=createHash('sha256').update(token).digest('hex'),core={id:user,organisation_id:org,permissions:[],must_change_password:true};
  await db.query("INSERT INTO school_roles(organisation_id,key,is_active) VALUES($1,'teacher',true)",[org]);
  await db.query("INSERT INTO school_memberships VALUES($1,$2,'teacher','active',now())",[org,user]);
  await db.query("INSERT INTO school_sessions(token_hash,os_user_id,organisation_id,core_context,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[hash,user,org,JSON.stringify(core)]);
  for(const headers of [{cookie:'rx_school_session='+token,authorization:'Bearer rxs_stale'},{cookie:'rx_school_session=%E0%A4%A',authorization:'Bearer '+token}]) {
    const auth=await authorize({headers},db,config,undefined,{allowPasswordChange:true});assert.equal(auth.schoolToken,token);
    assert.equal(await revokeSchoolUserSessions(db,user,createHash('sha256').update(auth.schoolToken).digest('hex')),0);
  }
});

test('invalid or revoked School sessions never fall through to Core authentication',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('A School-local token must never be sent to Core'));
  await assert.rejects(authorize({headers:{authorization:'Bearer rxs_revoked'}},db,config),{statusCode:401,code:'SCHOOL_SESSION_EXPIRED'});
});

test('School responses expose the earlier idle or absolute session deadline and expired idle sessions reject access',async()=>{
  const token='rxs_deadline_test',hash=createHash('sha256').update(token).digest('hex'),core={id:user,organisation_id:org,permissions:[]};
  await db.query("INSERT INTO school_roles(organisation_id,key,is_active) VALUES($1,'teacher',true)",[org]);
  await db.query("INSERT INTO school_memberships VALUES($1,$2,'teacher','active',now())",[org,user]);
  await db.query('INSERT INTO school_security_settings VALUES($1,5)',[org]);
  await db.query("INSERT INTO school_sessions(token_hash,os_user_id,organisation_id,core_context,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[hash,user,org,JSON.stringify(core)]);
  const request={headers:{cookie:'rx_school_session='+token}};
  await authorize(request,db,config);
  let remaining=Date.parse(request.sessionExpiresAt)-Date.now();assert.ok(remaining>290000&&remaining<=301000);
  await db.query("UPDATE school_sessions SET expires_at=now()+interval '1 minute' WHERE token_hash=$1",[hash]);
  await authorize(request,db,config);remaining=Date.parse(request.sessionExpiresAt)-Date.now();assert.ok(remaining>50000&&remaining<=61000);
  await db.query("UPDATE school_sessions SET last_used_at=now()-interval '6 minutes' WHERE token_hash=$1",[hash]);
  await assert.rejects(authorize({headers:{cookie:'rx_school_session='+token}},db,config),{statusCode:401,code:'SCHOOL_SESSION_EXPIRED'});
});

test('concurrent failures are counted atomically and repeated sign-in failures are blocked',async()=>{
  await Promise.all(Array.from({length:10},()=>recordPortalLoginFailure(db,'staff','same',10,15)));
  assert.equal((await db.query('SELECT failures FROM portal_login_throttle')).rows[0].failures,10);
  await assert.rejects(assertPortalLoginAllowed(db,'staff','same'),{statusCode:429});
  let calls=0;const request={ip:'192.0.2.1',body:{schoolId:'alpha',staffId:'STF-1'}};
  for(let i=0;i<10;i++)await assert.rejects(withSchoolAuthThrottle(db,'school_staff',request,async()=>{calls++;throw Object.assign(new Error('Invalid credentials'),{statusCode:401})}),{statusCode:401});
  await assert.rejects(withSchoolAuthThrottle(db,'school_staff',request,async()=>{calls++}),{statusCode:429});assert.equal(calls,10);
});

async function firstLogin(dedicated_admin=true){
  const token='rxs_first_login',hash=createHash('sha256').update(token).digest('hex'),core={id:user,organisation_id:org,organisation_slug:'alpha',permissions:[],must_change_password:true,dedicated_admin};
  await db.query("INSERT INTO school_roles(organisation_id,key,is_active,portal_mode) VALUES($1,'teacher',true,'teacher')",[org]);
  await db.query("INSERT INTO school_memberships VALUES($1,$2,$3,'active',now())",[org,user,dedicated_admin?'school_admin':'teacher']);
  await db.query("INSERT INTO school_sessions(token_hash,os_user_id,organisation_id,core_context,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour'),('old-session',$2,$3,$4,now()+interval '1 hour')",[hash,user,org,JSON.stringify(core)]);
  return{token,hash};
}

test('primary administrator must change the temporary password then sign in again; every old session is revoked',async t=>{
  const {token}=await firstLogin(),sent=[];let audits=0;
  const app=await appFor(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return response({changed:true,staffId:'SCH-ADMIN-001'})},async()=>{audits++});
  await assert.rejects(authorize({headers:{cookie:'rx_school_session='+token}},db,config),{statusCode:403,code:'PASSWORD_CHANGE_REQUIRED'});
  const r=await app.inject({method:'POST',url:'/api/auth/change-password',headers:{cookie:'rx_school_session='+token},payload:{newPassword:'PersonalSecurePass123'}});
  assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json(),{changed:true,requiresSignIn:true,schoolId:'alpha',redirectTo:'/s/alpha/admin-login?admin='+user});assert.equal(audits,1);assert.equal('keepSessionHash' in sent[0],false);assert.equal(sent[0].schoolId,'alpha');assert.match(r.headers['set-cookie'],/Max-Age=0/);
  assert.equal((await db.query('SELECT count(*) count FROM school_sessions WHERE revoked_at IS NULL')).rows[0].count,0);
  await assert.rejects(authorize({headers:{cookie:'rx_school_session='+token}},db,config),{statusCode:401});
});

test('staff password change preserves the actual current session and routes to the role workspace',async t=>{
  const {token,hash}=await firstLogin(false),sent=[];
  const app=await appFor(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return response({changed:true})});
  const r=await app.inject({method:'POST',url:'/api/auth/change-password',headers:{cookie:'rx_school_session='+token,authorization:'Bearer rxs_stale'},payload:{newPassword:'PersonalSecurePass123'}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().redirectTo,'/teacher?school=alpha');assert.equal(sent[0].keepSessionHash,hash);
  const current=(await db.query('SELECT * FROM school_sessions WHERE revoked_at IS NULL')).rows;assert.equal(current.length,1);assert.equal(current[0].core_context.must_change_password,false);
});

test('failed password change preserves sessions and a local audit failure cannot hide a committed password change',async t=>{
  const {token}=await firstLogin();let failCore=true;
  const app=await appFor(t,async()=>response(failCore?{error:{message:'Core unavailable'}}:{changed:true},failCore?503:200),async()=>{throw new Error('Local audit unavailable')});
  const input={method:'POST',url:'/api/auth/change-password',headers:{cookie:'rx_school_session='+token},payload:{newPassword:'PersonalSecurePass123'}};
  assert.equal((await app.inject(input)).statusCode,503);assert.equal((await db.query('SELECT count(*) count FROM school_sessions WHERE revoked_at IS NULL')).rows[0].count,2);
  failCore=false;const r=await app.inject(input);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().requiresSignIn,true);
});

test('administrator link context verifies the exact account and canonical school before showing login details',async t=>{
  let wrong=false;const app=await appFor(t,async()=>response({id:wrong?'33333333-3333-4333-8333-333333333333':user,email:'admin@example.test',first_name:'Primary',last_name:'Admin',organisation_slug:'alpha',organisation_name:'Alpha School'}));
  const url='/api/auth/admin-login-context?schoolId=alpha&adminUserId='+user;
  const r=await app.inject({url});assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json(),{administrator:{id:user,email:'admin@example.test',name:'Primary Admin'},school:{id:'alpha',name:'Alpha School'}});assert.equal(r.headers['cache-control'],'no-store');
  wrong=true;assert.equal((await app.inject({url})).statusCode,503);assert.equal((await app.inject({url:'/api/auth/admin-login-context?schoolId=alpha&adminUserId=wrong'})).statusCode,400);
});



test('school-scoped revocation leaves the same user signed in to other schools',async t=>{
  const other='33333333-3333-4333-8333-333333333333';
  await db.query('INSERT INTO school_sessions(token_hash,os_user_id,organisation_id) VALUES($1,$2,$3),($4,$2,$5)',['alpha-old',user,org,'beta-current',other]);
  const app=await appFor(t,()=>assert.fail());
  const r=await app.inject({method:'POST',url:'/api/internal/revoke-user-sessions',headers:{'x-revolt-service-key':config.CORE_SERVICE_KEY},payload:{userId:user,organisationId:org}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().revoked,1);
  const remaining=(await db.query('SELECT token_hash FROM school_sessions WHERE revoked_at IS NULL')).rows;assert.deepEqual(remaining,[{token_hash:'beta-current'}]);
});

test('a school password change preserves sessions in other schools',async t=>{
  const {token}=await firstLogin(),other='33333333-3333-4333-8333-333333333333';
  await db.query("INSERT INTO school_sessions(token_hash,os_user_id,organisation_id,expires_at) VALUES('beta-current',$1,$2,now()+interval '1 hour')",[user,other]);
  const app=await appFor(t,async()=>response({changed:true}));
  const r=await app.inject({method:'POST',url:'/api/auth/change-password',headers:{cookie:'rx_school_session='+token},payload:{newPassword:'PersonalSecurePass123'}});
  assert.equal(r.statusCode,200,r.body);assert.deepEqual((await db.query('SELECT token_hash FROM school_sessions WHERE revoked_at IS NULL')).rows,[{token_hash:'beta-current'}]);
});

test('OS recovery email endpoint requires the trusted Core credential and hides delivery details',async t=>{
  const app=await appFor(t,()=>assert.fail()),payload={email:'admin@example.test',resetToken:'t'.repeat(43)};
  assert.equal((await app.inject({method:'POST',url:'/api/internal/os-password-reset-email',payload})).statusCode,401);
  const result=await app.inject({method:'POST',url:'/api/internal/os-password-reset-email',payload,headers:{'x-revolt-service-key':config.CORE_SERVICE_KEY}});
  assert.equal(result.statusCode,503);assert.equal(result.json().error.message,'OS recovery email delivery is unavailable');assert.ok(!result.body.includes(payload.resetToken));
});
