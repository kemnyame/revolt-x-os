import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateCoreSchoolLogin } from '../dist/core-school-login.js';

const config={CORE_OS_URL:'https://core.example.test/',CORE_SERVICE_KEY:'test-only-service-key'};
const credentials={schoolId:'alpha',staffId:'STF-000001',password:'FixturePassword123! '};
const account={id:'fixture-user',organisation_id:'fixture-school',membership_id:'fixture-membership',must_change_password:true};
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
function recoveryClock(){let time=0;return{now:()=>time,wait:async ms=>{time+=ms}}}

test('staff sign-in recovers from startup throttling and an unavailable gateway without changing the supplied credentials',async()=>{
  const calls=[],pauses=[],replies=[new Response('Service is starting',{status:429}),response({message:'Gateway unavailable'},503),response(account)];
  const result=await authenticateCoreSchoolLogin(config,'staff',credentials,{
    fetchCore:async(url,options)=>{calls.push({url,options});return replies.shift()},wait:async milliseconds=>pauses.push(milliseconds)
  });
  assert.deepEqual(result,account);assert.equal(calls.length,3);assert.deepEqual(pauses,[750,1500]);
  for(const call of calls){assert.equal(call.url,'https://core.example.test/v1/internal/school/authenticate-staff');assert.deepEqual(JSON.parse(call.options.body),credentials);assert.equal(call.options.headers['x-revolt-service-key'],config.CORE_SERVICE_KEY);assert.ok(call.options.signal instanceof AbortSignal)}
});

test('wrong passwords and disabled staff are returned immediately and are never retried',async()=>{
  for(const status of [401,403]){
    let calls=0;const message=status===401?'Invalid school, Staff ID or password':'This staff account is not active';
    await assert.rejects(authenticateCoreSchoolLogin(config,'staff',credentials,{
      fetchCore:async()=>{calls++;return response({error:{code:status===401?'INVALID_CREDENTIALS':'ACCOUNT_INACTIVE',message}},status)},wait:()=>assert.fail('Credential failures must not be retried')
    }),{statusCode:status,message});assert.equal(calls,1);
  }
});

test('persistent service throttling reports a busy service rather than invalid staff credentials',async()=>{
  let calls=0;
  await assert.rejects(authenticateCoreSchoolLogin(config,'staff',credentials,{
    ...recoveryClock(),fetchCore:async()=>{calls++;return response({message:'Rate limit exceeded'},429)}
  }),error=>error.statusCode===429&&error.code==='SCHOOL_SIGN_IN_BUSY'&&error.retryAfterSeconds===5&&!/Invalid school|password/i.test(error.message));
  assert.ok(calls>4,'Fast failures must not exhaust recovery before a cold start finishes');
});

test('long Retry-After pauses are respected within the recovery deadline',async()=>{
  let calls=0;const clock=recoveryClock();
  await assert.rejects(authenticateCoreSchoolLogin(config,'staff',credentials,{
    ...clock,fetchCore:async()=>{calls++;return response({message:'Rate limit exceeded'},429,{'retry-after':'30'})}
  }),{statusCode:429,retryAfterSeconds:30});assert.equal(calls,2);assert.equal(clock.now(),30000);
});

test('short Retry-After pauses are respected during startup recovery',async()=>{
  let calls=0;const pauses=[];
  const result=await authenticateCoreSchoolLogin(config,'staff',credentials,{
    fetchCore:async()=>++calls===1?response({},503,{'retry-after':'2'}):response(account),wait:async ms=>pauses.push(ms)
  });assert.equal(result.id,account.id);assert.deepEqual(pauses,[2000]);
});

test('connection failures and incomplete successful responses do not become credential errors',async()=>{
  for(const fetchCore of [async()=>{throw Error('network unavailable')},async()=>response({starting:true}),async()=>new Response('<html>Starting</html>')]){
    await assert.rejects(authenticateCoreSchoolLogin(config,'staff',credentials,{fetchCore,...recoveryClock()}),{statusCode:503,code:'SCHOOL_SIGN_IN_UNAVAILABLE'});
  }
});

test('a service that recovers after twenty seconds completes the original sign-in',async()=>{
  const clock=recoveryClock();let calls=0;
  const result=await authenticateCoreSchoolLogin(config,'staff',credentials,{
    ...clock,fetchCore:async()=>{calls++;return clock.now()<20000?new Response('Starting',{status:429}):response(account)}
  });assert.deepEqual(result,account);assert.ok(calls>4);assert.ok(clock.now()>=20000&&clock.now()<55000);
});

test('startup retries stop at the request deadline',async()=>{
  let time=0,calls=0;
  await assert.rejects(authenticateCoreSchoolLogin(config,'staff',credentials,{
    now:()=>time,fetchCore:async()=>{calls++;time+=55_000;throw Error('timed out')},wait:()=>assert.fail('Expired requests must not wait')
  }),{statusCode:503});assert.equal(calls,1);
});

test('missing or rejected service credentials are configuration errors rather than wrong staff passwords',async()=>{
  await assert.rejects(authenticateCoreSchoolLogin({...config,CORE_SERVICE_KEY:undefined},'staff',credentials,{fetchCore:()=>assert.fail()}),{statusCode:503});
  await assert.rejects(authenticateCoreSchoolLogin(config,'staff',credentials,{
    fetchCore:async()=>response({error:{code:'UNAUTHORIZED',message:'Invalid School service credential'}},401),wait:()=>assert.fail()
  }),{statusCode:503,code:'SCHOOL_SIGN_IN_UNAVAILABLE'});
});

test('administrator login uses the same recovery and preserves its specific administrator identity',async()=>{
  const body={schoolId:'alpha',adminUserId:'primary-admin',email:'primary@example.test',password:'FixtureAdmin123!'};
  const result=await authenticateCoreSchoolLogin(config,'admin',body,{fetchCore:async(url,options)=>{
    assert.equal(url,'https://core.example.test/v1/internal/school/authenticate-admin');assert.deepEqual(JSON.parse(options.body),body);return response(account)
  }});assert.deepEqual(result,account);
});

test('a confirmed outage rejects direct login without forwarding credentials and automatically permits a recovered Core',async()=>{
  const incident='Central sign-in is unavailable. Contact your system provider.';
  const marked={...config,CORE_SIGN_IN_OUTAGE_MESSAGE:incident};
  for(const kind of ['staff','admin']){
    const calls=[];
    await assert.rejects(authenticateCoreSchoolLogin(marked,kind,credentials,{fetchCore:async(url,options)=>{calls.push({url,options});return response({status:'unavailable'},503)},wait:()=>assert.fail('Confirmed outages must not be retried')}),{statusCode:503,code:'SCHOOL_SIGN_IN_OUTAGE',message:incident});
    assert.equal(calls.length,1);assert.equal(calls[0].url,'https://core.example.test/health/ready');assert.equal(calls[0].options.body,undefined);assert.equal(calls[0].options.headers,undefined);
  }
  const result=await authenticateCoreSchoolLogin(marked,'staff',credentials,{fetchCore:async url=>url.endsWith('/health/ready')?response({status:'ready'}):response(account)});
  assert.deepEqual(result,account);
});
