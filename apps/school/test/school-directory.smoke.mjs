import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerSchoolDirectory} from '../dist/school-directory.js';

const local={id:'alpha',name:'Alpha School',organisationId:'org-alpha'};
const config={CORE_OS_URL:'https://core.example.test',CORE_SERVICE_KEY:'fixture-service-key'};
async function fixture(t,{rows=[local],fetchCore,now}={}){
  const app=Fastify();t.after(()=>app.close());
  registerSchoolDirectory(app,{db:{query:async()=>({rows})},config,fetchCore,now});
  return app;
}

test('existing schools return immediately while a single Core refresh is still pending',async t=>{
  let finish,calls=0;
  const app=await fixture(t,{fetchCore:()=>{calls++;return new Promise(resolve=>{finish=resolve})}});
  const responses=await Promise.all(Array.from({length:6},()=>app.inject('/api/auth/schools')));
  assert.equal(calls,1);assert.ok(responses.every(r=>r.statusCode===200));
  assert.deepEqual(responses[0].json(),[{...local,licenceStatus:null}]);assert.match(responses[0].headers['cache-control'],/no-store/);
  finish(new Response(JSON.stringify([{id:'beta',name:'Beta',organisationId:'org-beta'}])));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual((await app.inject('/api/auth/schools')).json().map(s=>s.id),['alpha','beta']);
});

test('malformed Core payloads and startup failures cannot remove local schools or break the response',async t=>{
  for(const body of ['<html>Starting</html>',JSON.stringify({error:'Starting'}),JSON.stringify([null,{},local,{id:'invalid-metadata',organisationId:{},licenceStatus:123}])]){
    const app=await fixture(t,{fetchCore:async()=>new Response(body)});
    const r=await app.inject('/api/auth/schools');assert.equal(r.statusCode,200);assert.equal(r.json()[0].id,'alpha');
  }
});

test('a new empty School deployment discovers its schools from Core and deduplicates organisation IDs',async t=>{
  const app=await fixture(t,{rows:[],fetchCore:async()=>new Response(JSON.stringify([local,{...local,id:'ALPHA',name:'Alpha Updated'},null]))});
  const r=await app.inject('/api/auth/schools');assert.equal(r.statusCode,200);assert.equal(r.json().length,1);
});

test('a failed refresh is shared, backs off, and can recover later',async t=>{
  let time=0,calls=0;
  const app=await fixture(t,{now:()=>time,fetchCore:async()=>{calls++;return calls===1?new Response('Starting',{status:429}):new Response(JSON.stringify([{id:'beta',name:'Beta',organisationId:'org-beta'}]))}});
  await app.inject('/api/auth/schools');await new Promise(resolve=>setImmediate(resolve));
  await app.inject('/api/auth/schools');assert.equal(calls,1);
  time=30001;await app.inject('/api/auth/schools');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);assert.equal((await app.inject('/api/auth/schools')).json().length,2);
});
