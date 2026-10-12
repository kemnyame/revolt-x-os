import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { mobileExperienceFrontend, mobileExperienceScript } from '../dist/mobile-experience.js';
import { mobileWorkflowScript } from '../dist/mobile-workflows.js';
import { schoolSessionScript } from '../dist/session-ui.js';

const storage=initial=>{const map=new Map(Object.entries(initial||{}));return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}};
const capabilities=['academic.view','reports.view','assessment.view','assessment.create','assessment.score','attendance.view','attendance.mark','homework.view','homework.create','homework.publish'];
const teacherContext={core:{id:'teacher-1',first_name:'Ama',last_name:'Mensah'},school:{school_name:'Test School'},capabilities};
const classes=[{classroom_id:'class-1',classroom_name:'Basic 5',subject_id:'subject-1',subject_name:'Mathematics',student_count:2},{classroom_id:'class-1',classroom_name:'Basic 5',subject_id:null,is_class_teacher:true},{classroom_id:'class-2',classroom_name:'Basic 6',subject_id:'subject-2',subject_name:'English'}];
const term={id:'term-1',name:'First Term',status:'active',academic_year_id:'year-1'};
const students=[{student_id:'student-1',first_name:'Kofi',last_name:'Asare',admission_no:'S001',score:null,attendance_status:'unmarked'},{student_id:'student-2',first_name:'Akua',last_name:'Addo',admission_no:'S002',score:null,attendance_status:'unmarked'}];
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,headers:{get:()=>null},clone(){return this}});
const waitFor=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5))}assert.fail('Mobile screen did not finish rendering')};

function harness(role='teacher',handler){
 const {document,window}=parseHTML(mobileExperienceFrontend(role));
 window.scrollTo=()=>{};window.HTMLElement.prototype.reportValidity=()=>true;
 // Linkedom omits the native select setter; reproduce its browser selection semantics.
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){const options=[...this.querySelectorAll('option')];return(options.find(o=>o.hasAttribute('selected'))||options[0])?.value||''},set(value){this.querySelectorAll('option').forEach(o=>o.toggleAttribute('selected',o.value===String(value)))}});
 const writes=[];
 const fetch=async(path,options={})=>{
  const method=options.method||'GET';if(method!=='GET')writes.push({path,body:options.body?JSON.parse(options.body):null,options});
  if(handler){const result=await handler(path,options);if(result)return result}
  if(path==='/api/teacher/context')return response(teacherContext);
  if(path==='/api/teacher/classes')return response(classes);
  if(path==='/api/terms')return response([term]);
  if(path==='/api/teacher/dashboard')return response({assignedClasses:2,pendingAssessments:1});
  if(path.startsWith('/api/assessments?'))return response([{id:'assessment-1',name:'End-of-Term Exam',assessment_type:'exam',max_score:100,student_count:2,scored_students:0}]);
  if(path==='/api/assessments/assessment-1/scores'&&method==='GET')return response({assessment:{id:'assessment-1',name:'End-of-Term Exam',max_score:100},students:structuredClone(students)});
  if(path.startsWith('/api/attendance?'))return response(structuredClone(students));
  if(method!=='GET')return response({saved:2});
  if(path==='/api/homework')return response([]);
  if(path==='/api/parent/me')return response({guardian:{first_name:'Esi'},school:{school_name:'Test School'},students:[{id:'student-1',first_name:'Kofi',last_name:'Asare',classroom_name:'Basic 5',admission_no:'S001'},{id:'student-2',first_name:'Akua',last_name:'Addo',classroom_name:'Basic 6',admission_no:'S002'}]});
  if(path.includes('/dashboard'))return response({student:{first_name:'Kofi'},fees:{outstanding:45},attendance:{present:10},homework:[]});
  if(path.endsWith('/fees'))return response({items:[{id:'fee-1',fee_name:'Tuition',due:50,paid:50,balance:0,status:'paid'}],payments:[]});
  if(path.endsWith('/payment-requests'))return response([{id:'request-1',fee_name:'Tuition',amount:50,status:'paid'}]);
  if(path.endsWith('academic-statement-requests'))return response([]);
  return response([]);
 };
 window.fetch=fetch;
 const context=vm.createContext({window,document,navigator:{onLine:true},fetch,sessionStorage:storage({[role==='teacher'?'rx_teacher_token':'rx_parent_token']:'rxs_test'}),localStorage:storage(),location:{origin:'https://school.example',href:'https://school.example/mobile/'+role,pathname:'/mobile/'+role,search:'',replace(){}},URL,URLSearchParams,Set,setTimeout,clearTimeout,addEventListener:()=>{},FileReader:class{}});
 vm.runInContext(mobileWorkflowScript+mobileExperienceScript,context);
 const click=id=>document.getElementById(id).click();
 const submit=id=>document.getElementById(id).onsubmit({preventDefault(){}});
 const change=(id,value)=>{const input=document.getElementById(id);input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));if(input.onchange)input.onchange.call(input)};
 return{document,window,context,writes,click,submit,change};
}

test('dedicated teacher UI exposes direct tasks and only assigned class subjects',async()=>{
 const h=harness();await waitFor(()=>h.document.querySelector('[data-go="scores"]'));
 h.document.querySelector('[data-go="scores"]').click();await waitFor(()=>h.document.getElementById('mScoreClass'));
 h.change('mScoreClass','class-1');
 const subjects=[...h.document.getElementById('mScoreSubject').querySelectorAll('option')].map(o=>o.value);
 assert.deepEqual(subjects,['','subject-1']);assert.doesNotMatch(h.document.body.innerHTML,/Administrator email|Student Portal|Commercial Control/);
});

async function openMarks(h){
 await waitFor(()=>h.document.querySelector('[data-go="scores"]'));
 h.document.querySelector('[data-go="scores"]').click();await waitFor(()=>h.document.getElementById('mScoreClass'));
 h.change('mScoreClass','class-1');h.change('mScoreSubject','subject-1');await h.submit('mScoreChoose');
 await waitFor(()=>h.document.querySelector('[data-assessment]'));h.document.querySelector('[data-assessment]').click();
 await waitFor(()=>h.document.getElementById('mLearnerMark'));
}

test('learner-by-learner marks retain zero, preserve failed saves, prevent duplicate saves and reset after success',async()=>{
 let attempts=0,finish;
 const h=harness('teacher',async(path,opt)=>{
  if(path==='/api/assessments/assessment-1/scores'&&opt.method==='POST'){
   attempts++;if(attempts===1)return response({error:{message:'School could not save the marks'}},503);
   return new Promise(resolve=>finish=()=>resolve(response({saved:1})));
  }
 });
 await openMarks(h);h.change('mLearnerMark','0');h.click('mNextLearner');
 assert.match(h.document.body.textContent,/Akua Addo/);assert.equal(h.document.getElementById('mLearnerMark').value,'');
 h.click('mReviewScores');h.click('mSaveScores');await waitFor(()=>h.document.getElementById('mSheet').textContent.includes('could not save'));
 assert.equal(h.writes[0].body.scores[0].score,0);assert.equal(h.writes[0].body.scores.length,1);assert.ok(h.document.getElementById('mLearnerMark'));
 h.click('mSaveScores');await waitFor(()=>finish);assert.equal(h.document.getElementById('mSaveScores').disabled,true);
 h.click('mSaveScores');assert.equal(attempts,2);finish();
 await waitFor(()=>h.document.getElementById('mScoreClass'));
 assert.equal(h.document.getElementById('mScoreClass').value,'');assert.equal(h.document.getElementById('mLearnerMark'),null);assert.match(h.document.body.textContent,/Marks saved successfully/);
});

test('invalid marks block saving without clearing the entered value',async()=>{
 const h=harness();await openMarks(h);h.change('mLearnerMark','101');h.click('mReviewScores');
 assert.match(h.document.getElementById('mError').textContent,/0 to 100/);assert.equal(h.document.getElementById('mLearnerMark').value,'101');assert.equal(h.writes.length,0);
});

test('attendance preserves explicit status on failure and clears the class register after successful save',async()=>{
 let fail=true;
 const h=harness('teacher',async(path,opt)=>path==='/api/attendance/mark'?response(fail?{error:{message:'Save unavailable'}}:{saved:1},fail?503:200):null);
 await waitFor(()=>h.document.querySelector('[data-go="attendance"]'));h.document.querySelector('[data-go="attendance"]').click();await waitFor(()=>h.document.getElementById('mAttendanceClass'));
 h.change('mAttendanceClass','class-1');await h.submit('mAttendanceChoose');await waitFor(()=>h.document.getElementById('mRegister'));
 const absent=h.document.querySelector('[data-att-student="student-1"][data-status="absent"]');absent.click();
 h.click('mReviewAttendance');h.click('mSaveAttendance');await waitFor(()=>h.document.getElementById('mSheet').textContent.includes('Save unavailable'));
 assert.equal(h.writes[0].body.records.length,1);assert.equal(h.writes[0].body.records[0].status,'absent');assert.equal(absent.getAttribute('aria-pressed'),'true');
 fail=false;h.click('mSaveAttendance');await waitFor(()=>h.document.getElementById('mAttendanceClass'));
 assert.equal(h.document.getElementById('mAttendanceClass').value,'');assert.equal(h.document.getElementById('mRegister'),null);assert.match(h.document.body.textContent,/Attendance saved/);
});

test('homework draft form closes only after its record is saved',async()=>{
 let fail=true;
 const h=harness('teacher',async(path,opt)=>path==='/api/homework'&&opt.method==='POST'?response(fail?{error:{message:'Draft save unavailable'}}:{id:'homework-1'},fail?503:201):null);
 await waitFor(()=>h.document.querySelector('[data-go="homework"]'));h.document.querySelector('[data-go="homework"]').click();await waitFor(()=>h.document.getElementById('mNewHomework'));h.click('mNewHomework');
 h.change('mRecordPair','class-1|subject-1');h.change('mRecordTitle','Fractions practice');h.change('mRecordInstructions','Complete questions 1 to 5.');await h.submit('mRecordForm');
 assert.equal(h.document.getElementById('mRecordTitle').value,'Fractions practice');assert.match(h.document.getElementById('mError').textContent,/Draft save unavailable/);
 fail=false;await h.submit('mRecordForm');await waitFor(()=>h.document.getElementById('mNewHomework'));assert.equal(h.document.getElementById('mRecordTitle'),null);assert.match(h.document.body.textContent,/Homework draft saved/);
});

test('parent UI switches linked children and does not offer paid fee actions',async()=>{
 const h=harness('parent');await waitFor(()=>h.document.getElementById('mSwitchChild'));h.click('mSwitchChild');
 h.document.querySelector('[data-child="student-2"]').click();await waitFor(()=>h.document.getElementById('mView').textContent.includes('Akua Addo'));
 h.document.querySelector('[data-go="fees"]').click();await waitFor(()=>h.document.getElementById('mView').textContent.includes('Assigned fees'));
 assert.equal(h.document.querySelector('[data-pay-fee]'),null);assert.equal(h.document.querySelector('[data-pay-request]'),null);assert.doesNotMatch(h.document.body.textContent,/Enter scores|Take attendance/);
});

test('mobile session expiry returns teachers and parents to their own mobile sign-in screens',async()=>{
 for(const role of ['teacher','parent']){
  let target;const window={fetch:async()=>response({error:{message:'Expired'}},401)};
  const context={window,URL,URLSearchParams,Date,setTimeout,clearTimeout,sessionStorage:storage({[role==='teacher'?'rx_teacher_token':'rx_parent_token']:'test'}),localStorage:storage({rx_school_id:'test-school'}),location:{origin:'https://school.example',href:'https://school.example/mobile/'+role,pathname:'/mobile/'+role,search:'',replace:url=>target=url}};
  vm.runInNewContext(schoolSessionScript(role),context);await assert.rejects(()=>window.fetch('/api/'+role+'/context'));
  assert.equal(target,'/mobile/'+role+'?school=test-school&expired=1');
 }
});

test('workflow guards preserve blank marks, existing scores and attendance status integrity',()=>{
 const window={};vm.runInNewContext(mobileWorkflowScript,{window});const f=window.RevoltMobileFlow;
 assert.equal(f.score('',100),null);assert.equal(f.score('0',100),0);assert.throws(()=>f.score('bad',100));
 assert.throws(()=>f.scorePayload([{student_id:'1',score:50,first_name:'Learner'}],{'1':{score:''}},100),/cannot be removed/);
 assert.throws(()=>f.attendancePayload([{student_id:'1'}],{'1':'unknown'},'class','2026-10-12'),/valid attendance/);
});
