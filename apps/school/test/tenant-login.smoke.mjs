import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {createSchoolTenantPages} from '../dist/tenant-pages.js';
import {schoolCookieValue,schoolTenantDocument} from '../dist/tenant-ui.js';
import {loginFrontend,adminLoginFrontend} from '../dist/login-ui.js';
import {authorize} from '../dist/auth.js';

const pg=new PGlite(),alpha='11111111-1111-4111-8111-111111111111',beta='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333';
const db={query:async(sql,params)=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0}}};
const config={NODE_ENV:'test',CORE_OS_URL:'https://core.invalid'};
test.before(async()=>{
  await pg.exec(`CREATE TABLE school_profiles(organisation_id uuid PRIMARY KEY,tenant_slug text,school_name text);
    CREATE TABLE school_sessions(token_hash text PRIMARY KEY,organisation_id uuid,core_context jsonb,expires_at timestamptz,last_used_at timestamptz,revoked_at timestamptz);
    CREATE TABLE school_security_settings(organisation_id uuid PRIMARY KEY,idle_timeout_minutes int);
    CREATE TABLE school_memberships(organisation_id uuid,os_user_id uuid,role text,status text);
    CREATE TABLE school_capabilities(key text,sort_order int);`);
  await pg.query("INSERT INTO school_profiles VALUES($1,'alpha','Alpha School'),($2,'beta','Beta School')",[alpha,beta]);
  await pg.query("INSERT INTO school_memberships VALUES($1,$3,'school_admin','active'),($2,$3,'school_admin','active')",[alpha,beta,user]);
});
test.after(()=>pg.close());
test.beforeEach(()=>pg.exec('TRUNCATE school_sessions;'));

async function fixture(t){
  const app=Fastify();t.after(()=>app.close());
  const pages=createSchoolTenantPages({db,config,schoolFrontend:'<body><main>School workspace</main></body>',
    requestSessionToken:r=>String(r.headers.authorization||'').replace(/^Bearer\s+/,'')||schoolCookieValue(r.headers.cookie,'rx_school_session'),
    resolveTenantSchool:async slug=>{const row=(await pg.query('SELECT * FROM school_profiles WHERE lower(tenant_slug)=lower($1) OR organisation_id::text=$1',[slug])).rows[0];if(!row)throw Object.assign(Error('School code was not found'),{statusCode:404});return row}
  });
  app.setErrorHandler((e,_r,p)=>p.code(e.statusCode||500).send({error:{message:e.message}}));
  app.get('/s/:school/login',(r,p)=>pages.schoolLoginDocument(r,p,loginFrontend));
  app.get('/s/:school/admin-login',(r,p)=>pages.schoolLoginDocument(r,p,adminLoginFrontend,true));
  app.get('/login',(r,p)=>pages.schoolLoginDocument(r,p,loginFrontend));
  app.get('/admin-login',(r,p)=>pages.schoolLoginDocument(r,p,adminLoginFrontend,true));
  app.get('/',(r,p)=>pages.openSchoolDocument(r,p,'/'));
  app.post('/api/auth/logout',pages.signOutSchoolSession);
  app.get('/api/context',async r=>{const access=await authorize(r,db,config);return{school:access.core.organisation_slug,user:access.core.id}});
  return app;
}
async function issue(slug='alpha',{admin=false,expired=false}={}){
  const token='rxs_'+slug+'_'+Math.random(),org=slug==='alpha'?alpha:beta;
  const core={id:user,email:'shared@example.test',organisation_id:org,organisation_slug:slug,organisation_name:slug,permissions:[],dedicated_admin:admin};
  await pg.query(`INSERT INTO school_sessions VALUES($1,$2,$3,now()+interval '8 hours',now()-make_interval(mins=>$4),NULL)`,[createHash('sha256').update(token).digest('hex'),org,JSON.stringify(core),expired?60:0]);
  return token;
}

test('a fresh browser gets only its school login, with no directory or browser-storage prerequisite',async t=>{
  const app=await fixture(t),r=await app.inject('/s/alpha/login');
  assert.equal(r.statusCode,200);assert.match(r.body,/data-school-id="alpha" data-school-name="Alpha School"/);
  assert.doesNotMatch(r.body,/<select|Select your school|\/api\/auth\/schools/);assert.match(r.headers['cache-control'],/no-store/);
  assert.match(r.headers['set-cookie'],/^rx_school_login=/);assert.equal((await app.inject('/s/missing/login')).statusCode,404);
  const plain=await app.inject('/login');assert.doesNotMatch(plain.body,/<select/);assert.match(plain.body,/shared School address/);
});

test('repeated logout and fresh sessions return to the same school and preserve administrator login type',async t=>{
  const app=await fixture(t);
  for(const admin of [false,true])for(let round=0;round<3;round++){
    const token=await issue('alpha',{admin}),headers={cookie:'rx_school_session='+token,'x-revolt-school':'alpha'};
    assert.equal((await app.inject({url:'/?school=alpha',headers})).statusCode,200);
    const signout=await app.inject({method:'POST',url:'/api/auth/logout',headers});assert.equal(signout.statusCode,200);
    const target=signout.json().loginUrl;assert.ok(target.startsWith('/s/alpha/'+(admin?'admin-login?admin='+user:'login?next=')));
    const login=await app.inject(target);assert.equal(login.statusCode,200);assert.match(login.body,/data-school-id="alpha"/);
    const stale=await app.inject({url:'/?school=alpha',headers});assert.equal(stale.statusCode,302);assert.ok(stale.headers.location.startsWith('/s/alpha/'));
  }
});

test('idle expiry and refresh return to the bound school without dropping into a school directory',async t=>{
  const app=await fixture(t),token=await issue('alpha',{admin:true,expired:true});
  const r=await app.inject({url:'/?school=alpha',headers:{cookie:'rx_school_session='+token}});
  assert.equal(r.statusCode,302);assert.equal(r.headers.location,'/s/alpha/admin-login?admin='+user+'&expired=1');
  const login=await app.inject(r.headers.location);assert.equal(login.statusCode,200);assert.doesNotMatch(login.body,/<select/);
});

test('a cookie from another school cannot open this school or override its bearer session',async t=>{
  const app=await fixture(t),a=await issue('alpha'),b=await issue('beta');
  const document=await app.inject({url:'/?school=alpha',headers:{cookie:'rx_school_session='+b}});
  assert.equal(document.statusCode,302);assert.ok(document.headers.location.startsWith('/s/alpha/login'));
  const wrong=await app.inject({url:'/api/context',headers:{cookie:'rx_school_session='+b,'x-revolt-school':'alpha'}});assert.equal(wrong.statusCode,401);
  const correct=await app.inject({url:'/api/context',headers:{cookie:'rx_school_session='+b,authorization:'Bearer '+a,'x-revolt-school':'alpha'}});
  assert.equal(correct.statusCode,200,correct.body);assert.equal(correct.json().school,'alpha');
});

test('generic links recover the previous public school address and reject external or malformed hints',async t=>{
  const app=await fixture(t);
  const cookie='rx_school_login='+encodeURIComponent('/s/alpha/admin-login?admin='+user);
  const r=await app.inject({url:'/admin-login',headers:{cookie}});assert.equal(r.headers.location,'/s/alpha/admin-login?admin='+user);
  for(const hint of ['https://attacker.test/login','/s/%E0%A4%A/login','//attacker.test/login']){
    const response=await app.inject({url:'/login',headers:{cookie:'rx_school_login='+encodeURIComponent(hint)}});
    assert.equal(response.statusCode,200);assert.equal(response.headers.location,undefined);
  }
});

test('generic login recovers old active or expired sessions without the newer return cookie',async t=>{
  const app=await fixture(t);
  for(const admin of [false,true])for(const expired of [false,true]){
    const token=await issue('alpha',{admin,expired});
    const response=await app.inject({url:'/login',headers:{cookie:'rx_school_session='+token}});
    assert.equal(response.statusCode,302);assert.equal(response.headers.location,'/s/alpha/'+(admin?'admin-login?admin='+user:'login'));
  }
});

test('an administrator page without a bound account ID is remembered as Admin Login',async t=>{
  const app=await fixture(t),page=await app.inject('/s/alpha/admin-login');
  const cookie=page.headers['set-cookie'].split(';')[0];
  assert.ok(decodeURIComponent(cookie).endsWith('/s/alpha/admin-login'));
  assert.equal((await app.inject({url:'/login',headers:{cookie}})).headers.location,'/s/alpha/admin-login');
});

test('an explicit school always wins and a generic admin page never binds a staff member as the administrator',async t=>{
  const app=await fixture(t),token=await issue('alpha');
  const headers={cookie:'rx_school_session='+token+'; rx_school_login='+encodeURIComponent('/s/beta/login')};
  assert.equal((await app.inject({url:'/login',headers})).headers.location,'/s/alpha/login');
  assert.equal((await app.inject({url:'/login?school=beta',headers})).headers.location,'/s/beta/login');
  assert.equal((await app.inject({url:'/admin-login',headers})).headers.location,'/s/alpha/admin-login');
});

test('logging out an older session writes the public school return cookie before clearing authentication',async t=>{
  const app=await fixture(t),token=await issue('alpha',{admin:true});
  const response=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:'rx_school_session='+token}});
  const cookies=response.headers['set-cookie'];assert.ok(Array.isArray(cookies));
  assert.ok(cookies.some(c=>c.startsWith('rx_school_login=')&&decodeURIComponent(c).includes('/s/alpha/admin-login?admin='+user)));
  assert.ok(cookies.some(c=>c.startsWith('rx_school_session=')&&c.includes('Max-Age=0')));
});

test('school names are safely escaped when server-rendered into login pages',()=>{
  const html=schoolTenantDocument('<body><main></main></body>',{tenant_slug:'alpha',school_name:'School " onload="alert(1) <script>'});
  assert.doesNotMatch(html,/data-school-name="School " onload=/);assert.match(html,/&quot;/);assert.match(html,/&lt;script&gt;/);
});
