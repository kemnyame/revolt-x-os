import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import Fastify from 'fastify';
import {parseHTML} from 'linkedom';
import {createHash} from 'node:crypto';
import {registerSchoolMobile,schoolMobileScript} from '../dist/mobile-app.js';
import {mobileSchoolResolver} from '../dist/mobile-binding.js';
import {schoolNavigationScript,mobileControlScript} from '../dist/mobile-navigation.js';

const alpha={tenant_slug:'alpha',school_name:'Alpha School'},beta={tenant_slug:'beta',school_name:'Beta School'};
async function mobileApp(t){
 const calls=[],resolve=mobileSchoolResolver({db:{query:async(sql,params)=>{calls.push(params[0]);return{rows:params[0]===createHash('sha256').update('rxs_old').digest('hex')?[{core_context:{organisation_slug:'alpha'}}]:[]}}},requestSessionToken:r=>String(r.headers.authorization||'').replace('Bearer ',''),resolveTenantSchool:async s=>{const school=[alpha,beta].find(x=>x.tenant_slug===s);if(!school)throw Object.assign(Error('Unknown school'),{statusCode:404});return school}});
 const app=Fastify();await registerSchoolMobile(app,{resolveSchool:resolve});t.after(()=>app.close());return{app,calls};
}
test('fresh school invitation supplies the Android handoff and a school-bound install manifest',async t=>{
 const {app}=await mobileApp(t),r=await app.inject('/mobile/setup?school=alpha');assert.equal(r.statusCode,200);assert.match(r.body,/intent:\/\/revolt-x-school/);assert.match(r.body,/package=com.revoltx.school/);assert.match(r.body,/href="\/school.webmanifest\?school=alpha"/);assert.match(r.headers['set-cookie'],/rx_mobile_school=alpha/);
 const manifest=(await app.inject('/school.webmanifest?school=alpha')).json();assert.equal(manifest.start_url,'/mobile?school=alpha');assert.equal(manifest.id,'/mobile?school=alpha');assert.ok(manifest.shortcuts.every(s=>s.url.endsWith('?school=alpha')));
 const b=(await app.inject('/school.webmanifest?school=beta')).json();assert.notEqual(manifest.id,b.id);assert.equal(b.start_url,'/mobile?school=beta');
});
test('app restart recovers school from its durable cookie or an older session and explicit invitations win',async t=>{
 const {app}=await mobileApp(t);
 const cookie=await app.inject({url:'/mobile',headers:{cookie:'rx_mobile_school=alpha'}});assert.equal(cookie.statusCode,302);assert.equal(cookie.headers.location,'/mobile?school=alpha');
 const legacy=await app.inject({url:'/mobile/teacher',headers:{authorization:'Bearer rxs_old'}});assert.equal(legacy.headers.location,'/mobile/teacher?school=alpha');
 const explicit=await app.inject({url:'/mobile/teacher?school=beta',headers:{cookie:'rx_mobile_school=alpha',authorization:'Bearer rxs_old'}});assert.equal(explicit.statusCode,200);assert.match(explicit.body,/data-school-id="beta"/);assert.match(explicit.headers['set-cookie'],/rx_mobile_school=beta/);
 const manifest=await app.inject({url:'/school.webmanifest',headers:{cookie:'rx_mobile_school=alpha'}});assert.match(manifest.headers['cache-control'],/no-store/);assert.equal(manifest.json().start_url,'/mobile?school=alpha');
});
test('opening an invitation persists mobile school identity before the first credential submission',()=>{
 const {document,window}=parseHTML('<body data-school-id="alpha"><main class="m-header"></main><a data-mobile-role href="/mobile/teacher">Teacher</a><link rel="manifest" href="/school.webmanifest"></body>'),saved=new Map(),events={};
 vm.runInNewContext(schoolMobileScript,{document,window,navigator:{onLine:true},location:{pathname:'/mobile',search:'?school=alpha',origin:'https://school.example'},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},sessionStorage:{getItem:()=>null},URL,URLSearchParams,addEventListener:(k,f)=>events[k]=f});
 assert.equal(saved.get('rx_mobile_school'),'alpha');assert.equal(document.querySelector('[data-mobile-role]').getAttribute('href'),'/mobile/teacher?school=alpha');assert.equal(document.querySelector('[rel=manifest]').getAttribute('href'),'/school.webmanifest?school=alpha');
});
function navigation(){
 const {document}=parseHTML('<body><main></main></body>'),handlers={},stack=[{external:true},{old:true}],restored=[];let index=1;
 const history={replaceState:s=>stack[index]=s,pushState:s=>{stack.splice(index+1);stack.push(s);index++},back:()=>{if(index>0){index--;handlers.popstate({state:stack[index]})}},go:n=>{index=Math.max(0,index+n)}};
 const context={window:{},document,history,location:{pathname:'/mobile/teacher',search:'?school=alpha'},addEventListener:(k,v)=>handlers[k]=v,Promise};
 vm.runInNewContext(schoolNavigationScript,context);context.window.rxSchoolHistory.bind({home:'home',restore:(p,a)=>restored.push([p,a])});return{...context,restored,stack,index:()=>index};
}
test('browser Back restores app screens, then asks before leaving Home',async()=>{
 const h=navigation(),nav=h.window.rxSchoolHistory;nav.visit('scores',null);nav.visit('score-entry',{assessmentId:'a'});h.history.back();await Promise.resolve();assert.equal(h.restored[0][0],'scores');h.history.back();await Promise.resolve();assert.equal(h.restored[1][0],'home');h.history.back();assert.ok(h.document.querySelector('[data-stay]'));assert.ok(h.index()>0);h.document.querySelector('[data-stay]').click();assert.equal(h.document.querySelector('[data-stay]'),null);
 h.history.back();h.document.querySelector('[data-leave]').click();assert.equal(h.index(),0);assert.deepEqual(h.stack[0],{external:true});
});
test('optimized touch controls can be toggled and retained without storing account data',()=>{
 const {document}=parseHTML('<body><header class="m-header"></header></body>'),saved=new Map();vm.runInNewContext(mobileControlScript,{document,localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}});const b=document.getElementById('rxOptimizeControls');assert.equal(b.textContent,'Optimize controls');b.click();assert.equal(b.getAttribute('aria-pressed'),'true');assert.equal(document.documentElement.getAttribute('data-mobile-controls'),'optimized');assert.deepEqual([...saved.keys()],['rx_mobile_controls']);b.click();assert.equal(b.getAttribute('aria-pressed'),'false');
});
