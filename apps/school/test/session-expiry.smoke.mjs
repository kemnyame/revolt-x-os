import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {schoolSessionScript,schoolSessionLoginPath} from '../dist/session-ui.js';

function browser(portal,respond,{saved={},school='alpha',search='?school=alpha'}={}){
  const storage=new Map(Object.entries({rx_school_token:'rxs_old',rx_teacher_token:'rxs_old',rx_parent_token:'parent-old',rx_student_token:'student-old',...saved})),calls=[],redirects=[],timers=new Map();
  let clock=Date.now(),id=0;
  class Clock extends Date{static now(){return clock}}
  const context={URL,URLSearchParams,Headers,Date:Clock,
    location:{origin:'https://school.example.test',href:'https://school.example.test/'+portal+search,pathname:'/'+portal,search,replace:url=>redirects.push(url)},
    localStorage:{getItem:key=>key==='rx_school_id'?school:null},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:key=>timers.delete(key),
    fetch:async(url,options)=>{calls.push({url,options});return respond(url,options)}};
  context.window=context;vm.runInNewContext(schoolSessionScript(portal),context);
  return{storage,calls,redirects,fetch:context.fetch,advance:ms=>{clock+=ms;const callbacks=[...timers.values()];timers.clear();for(const fn of callbacks)fn()}};
}
const json=(body={},status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
const uid='11111111-1111-4111-8111-111111111111';

test('expired staff and teacher sessions clear both staff tokens and preserve their school and login type',async()=>{
  for(const portal of ['staff','teacher']){
    const b=browser(portal,()=>json({},401));await assert.rejects(b.fetch('/api/context'),{status:401});
    assert.deepEqual(b.redirects,['/s/alpha/login?next='+encodeURIComponent(portal==='teacher'?'/teacher':'/')+'&expired=1']);
    assert.equal(b.storage.has('rx_school_token'),false);assert.equal(b.storage.has('rx_teacher_token'),false);assert.equal(b.storage.get('rx_parent_token'),'parent-old');
  }
});
test('administrator expiry returns to the verified administrator-specific login',async()=>{
  const b=browser('staff',url=>url==='/api/context'?json({core:{organisation_slug:'alpha',dedicated_admin:true,id:uid}}):json({},401));
  await b.fetch('/api/context');await assert.rejects(b.fetch('/api/payroll/export'),{status:401});
  assert.deepEqual(b.redirects,['/s/alpha/admin-login?admin='+uid+'&expired=1']);
});
test('parent and student sessions return to their own school login without clearing staff credentials',async()=>{
  for(const portal of ['parent','student']){
    const b=browser(portal,()=>json({},401),{search:'?school=alpha&reference=old-payment'});
    await assert.rejects(b.fetch('/api/'+portal+'/report-card.pdf'),{status:401});
    assert.deepEqual(b.redirects,['/'+portal+'?school=alpha&expired=1']);assert.equal(b.storage.has('rx_'+portal+'_token'),false);assert.equal(b.storage.get('rx_school_token'),'rxs_old');
  }
});
test('session expiry during a download redirects and concurrent failures redirect only once',async()=>{
  const b=browser('staff',()=>json({},401));await Promise.allSettled([b.fetch('/api/payroll/export'),b.fetch('/api/reports.pdf')]);assert.equal(b.redirects.length,1);
});
test('public credential failures, access restrictions and service outages keep their own handling',async()=>{
  for(const [portal,url,status] of [['staff','/api/auth/admin-login',401],['staff','/api/test-access/status',401],['parent','/api/parent/login',401],['student','/api/student/login',401],['staff','/api/context',403],['teacher','/api/teacher/context',503],['staff','https://provider.example.test/api/report',401]]){
    const b=browser(portal,()=>json({},status));assert.equal((await b.fetch(url)).status,status);assert.equal(b.redirects.length,0);
  }
});
test('untrusted login hints cannot redirect users outside the School login pages',async()=>{
  for(const hint of ['https://other.example.test/login','//other.example.test/login','/api/auth/admin-login','/admissions']){
    const b=browser('staff',()=>json({},401),{saved:{rx_school_login_url:hint}});await assert.rejects(b.fetch('/api/context'));assert.equal(b.redirects[0],'/s/alpha/login?next=%2F&expired=1');
  }
});
test('server deadlines expire an idle School workspace and successful authenticated activity reschedules it',async()=>{
  let duration=10000;
  const b=browser('staff',()=>json({},200,{'x-revolt-session-expires-at':new Date(Date.now()+duration).toISOString()}));
  await b.fetch('/api/context');duration=30000;await b.fetch('/api/students');b.advance(11000);assert.equal(b.redirects.length,0);b.advance(20000);assert.equal(b.redirects.length,1);assert.equal(b.calls.length,2);
});
test('an already expired saved session returns to login without another protected request',async()=>{
  const b=browser('staff',()=>json(),{saved:{rx_school_session_expires_at:String(Date.now()-1000)}});
  await assert.rejects(b.fetch('/api/context'),{status:401});assert.equal(b.calls.length,0);assert.equal(b.redirects.length,1);
});
test('server document redirects preserve dedicated administrators and staff return paths',()=>{
  assert.equal(schoolSessionLoginPath({organisation_slug:'alpha',dedicated_admin:true,id:uid},'/',true),'/s/alpha/admin-login?admin='+uid+'&expired=1');
  assert.equal(schoolSessionLoginPath({organisation_slug:'alpha'},'/students/test',true),'/s/alpha/login?next=%2Fstudents%2Ftest&expired=1');
  assert.equal(schoolSessionLoginPath(null),'/login?next=%2F');
});
