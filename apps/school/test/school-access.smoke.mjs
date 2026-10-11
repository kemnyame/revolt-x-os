import test, {beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { registerSchoolAccessRoutes, schoolAuthValidationMessage, schoolIdentifier, ensureSchoolLoginMembership, revokeSchoolUserSessions, withSchoolAuthThrottle } from '../dist/school-access.js';
import { recordPortalLoginFailure, assertPortalLoginAllowed } from '../dist/reliability.js';
import { authorize } from '../dist/auth.js';
import { createHash } from 'node:crypto';

const pg=new PGlite();
await pg.exec(`CREATE TABLE portal_login_throttle(portal text,throttle_key text,failures int,window_started_at timestamptz,blocked_until timestamptz,last_failure_at timestamptz,updated_at timestamptz,PRIMARY KEY(portal,throttle_key));
 CREATE TABLE school_sessions(id serial,token_hash text,os_user_id uuid,organisation_id uuid,revoked_at timestamptz,expires_at timestamptz,last_used_at timestamptz DEFAULT now(),core_context jsonb);
 CREATE TABLE school_memberships(organisation_id uuid,os_user_id uuid,role text,status text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(organisation_id,os_user_id));
 CREATE TABLE school_roles(organisation_id uuid,key text,name text,description text,portal_mode text,can_teach boolean,is_system boolean,is_active boolean);
 CREATE TABLE school_security_settings(organisation_id uuid,idle_timeout_minutes int);`);
const db={query:async(sql,params)=>{const result=await pg.query(sql,params);return{rows:result.rows,rowCount:result.rows.length||result.affectedRows||0}}};
const user='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222';
const config={NODE_ENV:'test',CORE_OS_URL:'https://core.example.test',CORE_SERVICE_KEY:'test-only-service-key'};
beforeEach(()=>pg.exec('TRUNCATE portal_login_throttle,school_sessions,school_memberships,school_roles,school_security_settings;'));
after(()=>pg.close());
const response=(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
async function appFor(t,fetchCore){
  const app=Fastify();t.after(()=>app.close());
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof z.ZodError?400:error.statusCode||500).send({error:{message:error instanceof z.ZodError?schoolAuthValidationMessage(error.issues):error.message}}));
  registerSchoolAccessRoutes(app,{db,config,fetchCore,requireCoreServiceRequest:request=>{if(request.headers['x-revolt-service-key']!==config.CORE_SERVICE_KEY)throw Object.assign(new Error('Service credential required'),{statusCode:401})}});
  return app;
}

test('reset accepts omitted and blank school IDs, uses the verified school and expires the cookie',async t=>{
  const sent=[],app=await appFor(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return response({reset:true,email:'admin@example.test',userId:user,organisationSlug:'alpha'})});
  for(const schoolId of [undefined,'','   ']) {
    const r=await app.inject({method:'POST',url:'/api/auth/admin-password-reset',payload:{token:'t'.repeat(43),newPassword:'NewSecurePass123',schoolId}});
    assert.equal(r.statusCode,200,r.body);assert.equal(r.json().adminLoginUrl,'/s/alpha/admin-login');assert.equal('schoolId' in sent.at(-1),false);assert.match(r.headers['set-cookie'],/Max-Age=0/);
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

test('concurrent failures are counted atomically and repeated sign-in failures are blocked',async()=>{
  await Promise.all(Array.from({length:10},()=>recordPortalLoginFailure(db,'staff','same',10,15)));
  assert.equal((await db.query('SELECT failures FROM portal_login_throttle')).rows[0].failures,10);
  await assert.rejects(assertPortalLoginAllowed(db,'staff','same'),{statusCode:429});
  let calls=0;const request={ip:'192.0.2.1',body:{schoolId:'alpha',staffId:'STF-1'}};
  for(let i=0;i<10;i++)await assert.rejects(withSchoolAuthThrottle(db,'school_staff',request,async()=>{calls++;throw Object.assign(new Error('Invalid credentials'),{statusCode:401})}),{statusCode:401});
  await assert.rejects(withSchoolAuthThrottle(db,'school_staff',request,async()=>{calls++}),{statusCode:429});assert.equal(calls,10);
});
