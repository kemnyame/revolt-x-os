import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {teacherFrontend} from '../dist/teacher-ui.js';
import {virtualClock} from './virtual-clock.mjs';

async function teacherBrowser(respond){
 const {document}=parseHTML(teacherFrontend),storage=new Map([['rx_teacher_token','rxs_fixture'],['rx_teacher_page','assessments']]),redirects=[],calls=[],clock=virtualClock();
 // linkedom exposes a getter-only select value; emulate browser selection.
 Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return(this.querySelector('option[selected]')||this.querySelector('option'))?.getAttribute('value')||''},set(value){this.querySelectorAll('option').forEach(o=>{o.removeAttribute('selected');if(o.getAttribute('value')===value)o.setAttribute('selected','')})}});
 const context={document,location:{pathname:'/teacher',search:'?school=alpha',origin:'https://school.example.test',href:'https://school.example.test/teacher?school=alpha',replace:url=>redirects.push(url)},
 URL,URLSearchParams,Headers,AbortController,...clock,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 localStorage:{getItem:()=>null},fetch:async(path,opt)=>{calls.push(path);const r=await respond(path,opt);return r instanceof Response?r:Response.json(r)},confirm:()=>true};
 context.window=context;const script=[...teacherFrontend.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('async function openWorkspace()'));
 assert.ok(script);vm.runInNewContext(script.replace('\nboot();','\nwindow.teacherTest={page:page,openWorkspace:openWorkspace,raw:raw};'),context);
 await context.teacherTest.openWorkspace();await new Promise(r=>setImmediate(r));return{context,document,calls,redirects,storage};
}
const classes=[{classroom_id:'class-a',classroom_name:'Class A',subject_id:'math',subject_name:'Math',assignment_type:'subject_teacher'},{classroom_id:'class-b',classroom_name:'Class B',subject_id:'english',subject_name:'English',assignment_type:'subject_teacher'}];
const ctx={core:{id:'teacher',first_name:'Test',last_name:'Teacher'},school:{school_name:'Alpha',tenant_slug:'alpha'},schoolRole:'teacher',roleProfile:{portal_mode:'teacher'},capabilities:['reports.view','academic.view','assessment.view'],license:{status:'legacy'}};
function response(path){if(path==='/api/teacher/context')return ctx;if(path==='/api/teacher/dashboard')return{assignedClasses:2,students:10,homework:0,assessments:2,attendanceByClass:[]};if(path.startsWith('/api/teacher/notifications'))return{alerts:[]};if(path==='/api/academic-years')return[{id:'year',status:'active'}];if(path==='/api/terms')return[{id:'term',academic_year_id:'year',status:'active'}];if(path==='/api/teacher/classes')return classes;if(path.startsWith('/api/assessments?'))return classes.map((c,i)=>({...c,id:'assessment-'+i,name:i?'Reading':'Fractions',max_score:20,assessment_type:'classwork'}));throw Error('Unexpected '+path)}

test('teacher login starts on the dashboard despite a saved page, and assessments filter by class and subject',async()=>{
 const b=await teacherBrowser(response);assert.match(b.document.getElementById('content').textContent,/My Dashboard/);
 await b.context.teacherTest.page('assessments');const table=()=>b.document.getElementById('assessmentRows').textContent;assert.match(table(),/Fractions/);assert.match(table(),/Reading/);
 const cls=b.document.getElementById('assessmentClass');cls.value='class-a';cls.onchange();assert.match(table(),/Fractions/);assert.doesNotMatch(table(),/Reading/);
 cls.value='';const sub=b.document.getElementById('assessmentSubject');sub.value='english';sub.onchange();assert.match(table(),/Reading/);assert.doesNotMatch(table(),/Fractions/);
 b.document.getElementById('newAssess').onclick();assert.ok(b.document.getElementById('taClass'));assert.ok(b.document.getElementById('taSubject'));assert.equal(b.document.getElementById('taPair'),null);
});

test('temporary teacher-context outages retry, while an expired session returns to the remembered school exactly once',async()=>{
 let attempts=0;const b=await teacherBrowser(path=>{if(path==='/api/teacher/context'&&++attempts<3)return new Response('Starting',{status:503});return response(path)});assert.equal(attempts,3);assert.equal(b.redirects.length,0);
 // Exercise a genuine 401 separately through the wrapped browser fetch.
 const expired=await teacherBrowser(path=>path==='/api/expired'?new Response('',{status:401}):response(path));await assert.rejects(expired.context.teacherTest.raw('/api/expired'),e=>e.status===401);assert.deepEqual(expired.redirects,['/s/alpha/login?next=%2Fteacher&expired=1']);assert.equal(expired.calls.filter(p=>p==='/api/expired').length,1);
});
