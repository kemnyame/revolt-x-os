import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loginFrontend, adminLoginFrontend, adminPasswordResetFrontend, passwordChangeFrontend } from '../dist/login-ui.js';
import { virtualClock } from './virtual-clock.mjs';

async function browser(html, {path='/admin-login',search='',saved='',schools=[{id:'alpha',name:'Alpha',organisationId:'org-alpha'}],directory,respond,startup}={}) {
  const clock=virtualClock();
  const elements=new Map(),storage=new Map([['rx_school_id',saved]]),sessions=new Map([['rx_school_token','old'],['rx_teacher_token','old']]),calls=[],redirects=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,focus(){},appendChild(){}});return elements.get(id)};
  const context={document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>({})},URL,URLSearchParams,
    location:{pathname:path,search,origin:'https://school.example.test',href:'https://school.example.test'+path+search,replace:url=>redirects.push(url)},history:{replaceState(){}},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    sessionStorage:{getItem:key=>sessions.get(key),removeItem:key=>sessions.delete(key),setItem:(key,value)=>sessions.set(key,value)},
    Date:clock.Date,AbortController,clearTimeout:clock.clearTimeout,setTimeout:clock.setTimeout,fetch:async(url,options)=>{
      calls.push({url,body:options?.body?JSON.parse(options.body):undefined});
      if(url==='/api/auth/schools')return directory?directory(url,options,clock):{ok:true,json:async()=>schools};
      if(url==='/api/system/core-status'||String(url).startsWith('https://core.example.test/'))return startup?startup(url,options):{ok:true,json:async()=>({core:{healthy:true,status:200,url:'https://core.example.test'}})};
      return respond?respond(url,options):{ok:true,json:async()=>({reset:true,schoolId:'alpha',adminLoginUrl:'/s/alpha/admin-login'})};
    }};
  context.window=context;
  const script=html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];assert.ok(script);
  vm.runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  return{element,calls,redirects,storage,sessions,clock};
}

async function settled(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate())}

for(const [name,html] of [['staff',loginFrontend],['administrator',adminLoginFrontend]]){
  test(name+' school directory recovers from a dropped connection, startup HTML and temporary database failure',async()=>{
    let attempts=0;
    const b=await browser(html,{path:'/s/alpha/login',directory:()=>{
      attempts++;if(attempts===1)throw Error('Connection dropped');
      if(attempts===2)return{ok:true,status:200,json:async()=>null};
      if(attempts===3)return{ok:false,status:503,json:async()=>({error:{message:'Database starting'}})};
      return{ok:true,status:200,json:async()=>[{id:'alpha',name:'Alpha'}]};
    }});
    b.element('password').value='KeepEnteredPassword123!';
    await settled(()=>!b.element('signin').disabled);
    assert.equal(b.element('schoolId').value,'alpha');assert.equal(attempts,4);assert.equal(b.element('password').value,'KeepEnteredPassword123!');
  });
}

test('a failed school directory can be retried on the same form without losing entered credentials',async()=>{
  let available=false;
  const b=await browser(loginFrontend,{path:'/s/alpha/login',directory:()=>({ok:available,status:available?200:503,json:async()=>available?[{id:'alpha',name:'Alpha'}]:null})});
  b.element('staffId').value='STF-000001';b.element('password').value='KeepEnteredPassword123!';
  await settled(()=>b.element('retrySignIn').hidden===false);
  assert.equal(b.element('signin').disabled,true);assert.ok(b.clock.now()<=90000);
  available=true;await b.element('retrySignIn').onclick();
  assert.equal(b.element('signin').disabled,false);assert.equal(b.element('password').value,'KeepEnteredPassword123!');assert.equal(b.element('staffId').value,'STF-000001');
});

test('administrator link recovers from startup throttling before permitting its exact account to sign in',async()=>{
  const uid='11111111-1111-4111-8111-111111111111';let attempts=0;
  const b=await browser(adminLoginFrontend,{path:'/s/alpha/admin-login',search:'?admin='+uid,respond:()=>{
    attempts++;return attempts<3?{ok:false,status:429,json:async()=>null}:{ok:true,status:200,json:async()=>({administrator:{id:uid,email:'primary@example.test',name:'Primary'},school:{id:'alpha',name:'Alpha'}})};
  }});
  b.element('password').value='KeepEnteredPassword123!';await settled(()=>!b.element('signin').disabled);
  assert.equal(attempts,3);assert.equal(b.element('email').value,'primary@example.test');assert.equal(b.element('schoolId').value,'alpha');assert.equal(b.element('password').value,'KeepEnteredPassword123!');
});

test('staff web login resolves a saved school UUID and replaces the expired teacher session after successful sign-in',async()=>{
  const b=await browser(loginFrontend,{path:'/login',saved:'ORG-ALPHA',respond:()=>({ok:true,json:async()=>({accessToken:'fixture-fresh-session',school:{id:'alpha'},user:{firstName:'Ama'},redirectTo:'/teacher'})})});
  assert.equal(b.element('schoolId').value,'alpha');b.sessions.set('rx_school_session_expires_at','expired');
  b.element('staffId').value='  STF-000001  ';b.element('password').value='FixtureStaffPass123!';
  await b.element('signin').onclick();
  assert.deepEqual(b.calls.at(-1).body,{schoolId:'alpha',staffId:'STF-000001',password:'FixtureStaffPass123!'});
  assert.equal(b.sessions.get('rx_teacher_token'),'fixture-fresh-session');assert.equal(b.sessions.has('rx_school_session_expires_at'),false);
  assert.deepEqual(b.redirects,['/teacher']);
});

test('staff web login preserves credentials after a service failure, prevents duplicate submission and can retry',async()=>{
  let finish,attempts=0;
  const b=await browser(loginFrontend,{path:'/s/alpha/login',respond:async()=>{
    attempts++;if(attempts===1)return new Promise(resolve=>{finish=()=>resolve({ok:false,status:503,json:async()=>({error:{message:'The sign-in service is starting or unavailable. Please try again in a moment.'}})})});
    return{ok:true,json:async()=>({accessToken:'fixture-session',school:{id:'alpha'},requiresPasswordChange:true,passwordChangeUrl:'/change-password',user:{firstName:'Ama'},redirectTo:'/teacher'})};
  }});
  b.element('staffId').value='STF-000001';b.element('password').value='FixtureTemporary123!';
  const pending=b.element('signin').onclick();await b.element('signin').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);assert.match(b.element('status').textContent,/may take a moment/);
  finish();await pending;
  assert.equal(b.element('staffId').value,'STF-000001');assert.equal(b.element('password').value,'FixtureTemporary123!');assert.equal(b.element('signin').disabled,false);assert.deepEqual(b.redirects,[]);
  assert.match(b.element('status').textContent,/sign-in service is starting/);assert.doesNotMatch(b.element('status').textContent,/Invalid school/);
  await b.element('signin').onclick();assert.deepEqual(b.redirects,['/change-password']);
});

test('web login starts a sleeping service before submitting the staff password to School',async()=>{
  let probes=0;
  const b=await browser(loginFrontend,{path:'/s/alpha/login',startup:(url,options)=>{
    if(url==='/api/system/core-status')return{ok:true,json:async()=>({core:{url:'https://core.example.test',healthy:++probes>1,status:probes>1?200:429}})};
    assert.equal(options.credentials,'omit');assert.equal(options.body,undefined);return{ok:false,status:0,json:()=>assert.fail()};
  },respond:()=>({ok:true,json:async()=>({accessToken:'fixture-session',school:{id:'alpha'},user:{firstName:'Ama'},redirectTo:'/teacher'})})});
  b.element('staffId').value='STF-000001';b.element('password').value='FixtureStaffPass123!';await b.element('signin').onclick();
  const auth=b.calls.findIndex(call=>call.url==='/api/auth/staff-id-login'),ping=b.calls.findIndex(call=>call.url==='https://core.example.test/health/live');
  assert.ok(ping>0&&auth>ping);assert.deepEqual(b.calls[auth].body,{schoolId:'alpha',staffId:'STF-000001',password:'FixtureStaffPass123!'});assert.deepEqual(b.redirects,['/teacher']);
});

test('web login keeps entered credentials and never posts a password when startup remains unavailable',async()=>{
  const b=await browser(loginFrontend,{path:'/s/alpha/login',startup:()=>({ok:true,json:async()=>({core:{url:'https://core.example.test',healthy:false,status:429}})})});
  b.element('staffId').value='STF-000001';b.element('password').value='FixtureStaffPass123!';await b.element('signin').onclick();
  assert.equal(b.calls.some(call=>call.url==='/api/auth/staff-id-login'),false);assert.equal(b.element('password').value,'FixtureStaffPass123!');assert.equal(b.element('signin').disabled,false);assert.match(b.element('status').textContent,/entries are still here/);
});

for(const [name,html,path,authPath] of [['staff',loginFrontend,'/s/alpha/login','/api/auth/staff-id-login'],['administrator',adminLoginFrontend,'/s/alpha/admin-login','/api/auth/admin-login']]){
  test(name+' web sign-in survives a failed first connection and a minute of fast startup responses',async()=>{
    let b,probes=0;
    b=await browser(html,{path,startup:url=>{
      if(url==='/api/system/core-status'){
        if(++probes===1)throw Error('connection dropped');
        return{ok:true,json:async()=>({core:{url:'https://core.example.test',healthy:b.clock.now()>=60000,status:b.clock.now()>=60000?200:429}})};
      }
      return{ok:false,status:0,json:()=>assert.fail()};
    },respond:()=>({ok:true,json:async()=>({accessToken:'fixture-session',school:{id:'alpha'},user:{firstName:'Ama'},redirectTo:'/teacher'})})});
    b.element('staffId').value='STF-000001';b.element('email').value='fixture@example.test';b.element('password').value='FixtureStaffPass123!';
    await b.element('signin').onclick();
    assert.equal(b.clock.now(),60000);assert.equal(b.calls.filter(call=>call.url===authPath).length,1);assert.deepEqual(b.redirects,['/teacher']);
  });
}

for(const [name,html] of [['admin',adminLoginFrontend],['staff',loginFrontend]]) {
  test(name+' school selection resolves tenant paths, case and legacy organisation IDs',async()=>{
    for(const options of [{path:'/s/ALPHA/admin-login',search:'?school=other'},{search:'?school=ORG-ALPHA'},{saved:'ALPHA'}]) {
      const b=await browser(html,options);assert.equal(b.element('schoolId').value,'alpha');assert.equal(b.element('signin').disabled,false);
    }
  });
  test(name+' malformed or unknown links do not select a different saved school',async()=>{
    for(const options of [{path:'/s/%E0%A4%A/admin-login',saved:'alpha'},{search:'?school=missing',saved:'alpha'},{search:'?school=%25',saved:'alpha'}]) {
      const b=await browser(html,options);assert.equal(b.element('schoolId').value,'');assert.match(b.element('status').textContent,/unavailable/);
      await b.element('signin').onclick();assert.equal(b.calls.length,1);assert.match(b.element('status').textContent,/Select your school/);
    }
  });
  test(name+' empty directory prevents sign-in',async()=>{
    const b=await browser(html,{schools:[]});assert.equal(b.element('signin').disabled,true);assert.match(b.element('status').textContent,/No schools/);
    await b.element('signin').onclick();assert.equal(b.calls.length,1);
  });
}

test('reset without a school omits the optional identifier and clears stale sessions',async()=>{
  const token='a'.repeat(43),b=await browser(adminPasswordResetFrontend,{path:'/admin-password-reset',search:'?token='+token});
  b.element('newPassword').value=b.element('confirmPassword').value='NewSecurePass123';
  await b.element('save').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(b.calls[0].body,{token,newPassword:'NewSecurePass123'});
  assert.equal(b.sessions.size,0);assert.equal(b.storage.get('rx_school_id'),'alpha');assert.deepEqual(b.redirects,['/s/alpha/admin-login']);
});

test('tenant reset uses the path school and prevents duplicate submissions',async()=>{
  const b=await browser(adminPasswordResetFrontend,{path:'/s/ALPHA/admin-password-reset',search:'?token='+'b'.repeat(43)+'&school=other'});
  b.element('newPassword').value=b.element('confirmPassword').value='NewSecurePass123';
  await Promise.all([b.element('save').onclick(),b.element('save').onclick()]);
  assert.equal(b.calls.length,1);assert.equal(b.calls[0].body.schoolId,'ALPHA');
});

test('incomplete reset links cannot submit and rejected resets can be retried',async()=>{
  const invalid=await browser(adminPasswordResetFrontend,{search:'?token=short'});
  await invalid.element('save').onclick();assert.equal(invalid.calls.length,0);assert.match(invalid.element('status').textContent,/invalid/);
  const failed=await browser(adminPasswordResetFrontend,{search:'?token='+'c'.repeat(43),respond:()=>({ok:false,json:async()=>({error:{message:'Reset link has expired'}})})});
  failed.element('newPassword').value=failed.element('confirmPassword').value='NewSecurePass123';
  await failed.element('save').onclick();assert.equal(failed.element('save').disabled,false);assert.match(failed.element('status').textContent,/expired/);assert.equal(failed.sessions.size,2);
});

test('first administrator password change clears temporary sessions and returns to its school login',async()=>{
  const b=await browser(passwordChangeFrontend,{path:'/change-password',respond:()=>({ok:true,json:async()=>({changed:true,requiresSignIn:true,schoolId:'alpha',redirectTo:'/s/alpha/admin-login'})})});
  b.element('newPassword').value=b.element('confirmPassword').value='PersonalSecurePass123';await b.element('save').onclick();
  assert.deepEqual(b.calls[0].body,{newPassword:'PersonalSecurePass123'});assert.equal(b.sessions.size,0);assert.equal(b.storage.get('rx_school_id'),'alpha');assert.deepEqual(b.redirects,['/s/alpha/admin-login']);assert.match(b.element('status').textContent,/Sign in with your new password/);
});

test('staff password change continues to the assigned workspace',async()=>{
  const b=await browser(passwordChangeFrontend,{respond:()=>({ok:true,json:async()=>({changed:true,redirectTo:'/teacher'})})});
  b.element('newPassword').value=b.element('confirmPassword').value='PersonalSecurePass123';await b.element('save').onclick();assert.deepEqual(b.redirects,['/teacher']);
});

test('administrator-specific links lock the verified school and email and send the correct account ID at login',async()=>{
  const uid='11111111-1111-4111-8111-111111111111',b=await browser(adminLoginFrontend,{path:'/s/alpha/admin-login',search:'?admin='+uid,saved:'other',respond:url=>({ok:true,json:async()=>url.startsWith('/api/auth/admin-login-context')?{administrator:{id:uid,email:'primary@example.test',name:'Primary Admin'},school:{id:'alpha',name:'Alpha School'}}:{accessToken:'test-session',school:{id:'alpha'},user:{firstName:'Primary'},redirectTo:'/'}})});
  assert.equal(b.element('schoolId').value,'alpha');assert.equal(b.element('schoolId').disabled,true);assert.equal(b.element('email').readOnly,true);assert.equal(b.element('email').value,'primary@example.test');assert.equal(b.element('signin').disabled,false);
  b.element('email').value='wrong@example.test';b.element('password').value='PersonalResetPass123';await b.element('signin').onclick();assert.deepEqual(b.calls.at(-1).body,{schoolId:'alpha',email:'primary@example.test',password:'PersonalResetPass123',adminUserId:uid});
});
test('an expired or replaced administrator link blocks sign-in instead of falling back to another account',async()=>{
  const b=await browser(adminLoginFrontend,{path:'/s/alpha/admin-login',search:'?admin=11111111-1111-4111-8111-111111111111',respond:()=>({ok:false,status:404,json:async()=>({error:{message:'School administrator login link is no longer valid'}})})});
  assert.equal(b.element('signin').disabled,true);await b.element('signin').onclick();assert.equal(b.calls.length,1);assert.match(b.element('status').textContent,/no longer valid/);
});

test('expired administrator login explains expiry and a fresh sign-in replaces its old session deadline',async()=>{
  const uid='11111111-1111-4111-8111-111111111111',b=await browser(adminLoginFrontend,{path:'/s/alpha/admin-login',search:'?admin='+uid+'&expired=1',respond:url=>({ok:true,json:async()=>url.startsWith('/api/auth/admin-login-context')?{administrator:{id:uid,email:'primary@example.test',name:'Primary Admin'},school:{id:'alpha',name:'Alpha'}}:{accessToken:'fresh-session',school:{id:'alpha'},user:{id:uid},redirectTo:'/'}})});
  assert.equal(b.element('sessionExpired').hidden,false);b.sessions.set('rx_school_session_expires_at','old-expired-time');b.element('password').value='test-only-password';await b.element('signin').onclick();
  assert.equal(b.sessions.has('rx_school_session_expires_at'),false);assert.equal(b.sessions.get('rx_school_token'),'fresh-session');assert.equal(b.sessions.get('rx_school_login_url'),'/s/alpha/admin-login?admin='+uid);assert.deepEqual(b.redirects,['/']);
});

