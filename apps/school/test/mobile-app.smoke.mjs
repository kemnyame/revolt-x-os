import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import Fastify from 'fastify';
import { registerSchoolMobile, schoolServiceWorker, schoolMobileScript } from '../dist/mobile-app.js';
import { schoolFrontend } from '../dist/ui.js';
import { teacherFrontend } from '../dist/teacher-ui.js';
import { parentFrontend } from '../dist/parent-ui.js';
import { studentFrontend } from '../dist/student-ui.js';
import { loginFrontend, adminLoginFrontend, adminPasswordResetFrontend } from '../dist/login-ui.js';
import { admissionsFrontend } from '../dist/admissions-ui.js';

test('mobile entry and install assets are served with correct content types and working targets',async()=>{
 const app=Fastify();await registerSchoolMobile(app);
 try{
  const home=await app.inject('/mobile');assert.equal(home.statusCode,200);
  assert.match(home.headers['content-type'],/text\/html/);assert.equal(home.headers['cache-control'],'no-store');
  const targets=[...home.body.matchAll(/data-mobile-role href="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual([...new Set(targets)],['/login','/parent','/student','/admin-login','/admissions']);
  const manifestResponse=await app.inject('/school.webmanifest');
  assert.match(manifestResponse.headers['content-type'],/application\/manifest\+json/);
  const manifest=manifestResponse.json();assert.equal(manifest.start_url,'/mobile');assert.equal(manifest.display,'standalone');
  assert.equal((await app.inject(manifest.start_url)).statusCode,200);
  for(const item of manifest.icons){
   const response=await app.inject(item.src);assert.equal(response.statusCode,200);assert.match(response.headers['content-type'],/image\/png/);
   assert.equal(response.rawPayload.subarray(1,4).toString(),'PNG');
   const size=Number(item.sizes.split('x')[0]);assert.equal(response.rawPayload.readUInt32BE(16),size);assert.equal(response.rawPayload.readUInt32BE(20),size);
  }
  const css=await app.inject('/school-mobile.css');assert.equal(css.statusCode,200);assert.match(css.headers['content-type'],/text\/css/);
  const js=await app.inject('/school-mobile.js');assert.equal(js.statusCode,200);assert.doesNotThrow(()=>new Function(js.body));
  const worker=await app.inject('/school-sw.js');assert.equal(worker.statusCode,200);assert.equal(worker.headers['cache-control'],'no-cache');assert.equal(worker.headers['service-worker-allowed'],'/');
 }finally{await app.close()}
});

test('all existing School portals retain install metadata and a mobile viewport',()=>{
 for(const html of [schoolFrontend,teacherFrontend,parentFrontend,studentFrontend,loginFrontend,adminLoginFrontend,adminPasswordResetFrontend,admissionsFrontend]){
  assert.match(html,/<link rel="manifest" href="\/school.webmanifest">/);
  assert.match(html,/viewport-fit=cover/);
  assert.match(html,/<script src="\/school-mobile.js\?v=[a-f0-9]+" defer>/);
 }
 assert.doesNotThrow(()=>new Function(schoolMobileScript));
});

function workerHarness(fetch){
 const handlers={};vm.runInNewContext(schoolServiceWorker,{self:{location:{origin:'https://school.example'},addEventListener:(name,handler)=>handlers[name]=handler,skipWaiting:()=>{},clients:{claim:()=>Promise.resolve()}},URL,Response,fetch});
 return request=>{let response;handlers.fetch({request,respondWith:p=>response=p});return response};
}

test('worker leaves authenticated API calls, mutations, external pages and assets untouched',()=>{
 const dispatch=workerHarness(()=>{throw Error('must not intercept')});
 for(const [url,method,mode] of [
  ['https://school.example/api/dashboard','GET','navigate'],
  ['https://school.example/api/payments','POST','same-origin'],
  ['https://school.example/change-password','POST','navigate'],
  ['https://checkout.example/pay','GET','navigate'],
  ['https://school.example/school-app.js','GET','same-origin']
 ])assert.equal(dispatch({url,method,mode}),undefined);
});

test('worker serves only fresh navigation and preserves authentication errors',async()=>{
 const response=new Response('expired session',{status:401});let forwarded;
 const dispatch=workerHarness(async request=>{forwarded=request;return response});
 const request={url:'https://school.example/teacher',method:'GET',mode:'navigate'};
 assert.equal(await dispatch(request),response);assert.equal(forwarded,request);
});

test('offline navigation shows a generic reconnect screen without any saved school data',async()=>{
 const dispatch=workerHarness(async()=>{throw new TypeError('network unavailable')});
 const response=await dispatch({url:'https://school.example/parent?school=private-school',method:'GET',mode:'navigate'});
 assert.equal(response.status,503);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const body=await response.text();assert.match(body,/Try again/);assert.match(body,/No offline changes or payments have been queued/);assert.doesNotMatch(body,/private-school/);
});
