import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { probeSchoolSignInService, schoolSignInStartupScript } from '../dist/sign-in-startup.js';

const base='https://core.example.test';
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const status=healthy=>response({core:{url:base,healthy,status:healthy?200:429}});

function client(handler){
  let time=0;const calls=[];
  const window={fetch:async(url,options)=>{calls.push({url,options});return handler(url,options,calls.length)}};
  vm.runInNewContext(schoolSignInStartupScript,{window,URL,location:{origin:'https://school.example.test'},Date:{now:()=>time},setTimeout:(fn,delay)=>{time+=delay;queueMicrotask(fn);return 0},clearTimeout(){}});
  return{ready:window.RevoltSchoolSignIn.ensureReady,calls,advance:ms=>{time+=ms}};
}

test('429 gateway responses do not report a running sign-in service',async()=>{
  const result=await probeSchoolSignInService({CORE_OS_URL:base},async()=>new Response('Rate limited',{status:429}));
  assert.equal(result.status,429);assert.equal(result.reachable,false);assert.equal(result.healthy,false);
});

test('only a valid Core health response is ready, while startup HTML and connection failures remain unavailable',async()=>{
  const ready=await probeSchoolSignInService({CORE_OS_URL:base},async()=>new Response(JSON.stringify({status:'ok'})));
  assert.equal(ready.healthy,true);
  for(const fetchCore of [async()=>new Response('<html>Starting</html>'),async()=>new Response(JSON.stringify({status:'unavailable'}),{status:503}),async()=>{throw Error('connection refused')}]){
    const result=await probeSchoolSignInService({CORE_OS_URL:base},fetchCore);assert.equal(result.reachable,false);assert.equal(result.healthy,false);
  }
});

test('an already healthy bridge proceeds without any cross-origin startup request',async()=>{
  const c=client(()=>status(true));await c.ready();assert.equal(c.calls.length,1);assert.equal(c.calls[0].url,'/api/system/core-status');
});

test('a sleeping Core is woken by a public opaque GET and verified through the original School bridge',async()=>{
  let probes=0;const messages=[];
  const c=client(url=>{
    if(url==='/api/system/core-status')return status(++probes>1);
    assert.equal(url,base+'/health/live');return{ok:false,status:0,json:()=>assert.fail('Opaque public responses must not be read')};
  });
  await c.ready(message=>messages.push(message));
  assert.deepEqual(c.calls.map(call=>call.url),['/api/system/core-status',base+'/health/live','/api/system/core-status']);
  const ping=c.calls[1].options;assert.equal(ping.method,'GET');assert.equal(ping.mode,'no-cors');assert.equal(ping.credentials,'omit');assert.equal(ping.body,undefined);assert.equal(ping.headers,undefined);assert.equal(ping.redirect,'error');
  assert.match(messages[0],/Starting sign-in/);assert.equal(messages.at(-1),'Signing in…');
});

test('public Core availability alone cannot authorize password submission while School still cannot connect',async()=>{
  const c=client(url=>url==='/api/system/core-status'?status(false):response({status:'ok'}));
  await assert.rejects(c.ready(),error=>error.status===503&&/entries are still here/.test(error.message));
  assert.equal(c.calls.filter(call=>call.url===base+'/health/live').length,6);assert.ok(c.calls.every(call=>call.options.method==='GET'));
});

test('concurrent sign-in readiness checks share one request and release their state when finished',async()=>{
  let finish;
  const c=client(()=>new Promise(resolve=>{finish=()=>resolve(status(true))}));
  const a=c.ready(),b=c.ready();assert.equal(a,b);assert.equal(c.calls.length,1);finish();await Promise.all([a,b]);
  const next=c.ready();assert.equal(c.calls.length,2);finish();await next;
});

test('a failed startup can be retried without stale pending state',async()=>{
  let available=false;
  const c=client(url=>url==='/api/system/core-status'?status(available):response(null,429));
  await assert.rejects(c.ready(),error=>error.status===503);available=true;await c.ready();assert.equal(c.calls.at(-1).url,'/api/system/core-status');
});

test('startup never fetches insecure, credential-bearing or incomplete public addresses',async()=>{
  for(const url of [undefined,'http://core.example.test','https://user:password@core.example.test','https://core.example.test/?token=private']){
    const c=client(()=>response({core:{url,healthy:false,status:429}}));await assert.rejects(c.ready(),error=>error.status===503);assert.equal(c.calls.length,1);
  }
});

test('startup stops when its overall deadline is exhausted',async()=>{
  let c;
  c=client(url=>{if(url!== '/api/system/core-status')c.advance(90000);return status(false)});
  await assert.rejects(c.ready(),error=>error.status===503);assert.equal(c.calls.length,2);
});
