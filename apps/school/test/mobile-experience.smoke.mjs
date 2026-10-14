import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { mobileExperienceFrontend, mobileExperienceScript } from '../dist/mobile-experience.js';
import { mobileWorkflowScript } from '../dist/mobile-workflows.js';
import { schoolSessionScript } from '../dist/session-ui.js';
import { schoolSignInStartupScript } from '../dist/sign-in-startup.js';
import { virtualClock } from './virtual-clock.mjs';

const storage=initial=>{const map=new Map(Object.entries(initial||{}));return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}};
const capabilities=['academic.view','reports.view','assessment.view','assessment.create','assessment.score','attendance.view','attendance.mark','homework.view','homework.create','homework.publish'];
const teacherContext={core:{id:'teacher-1',first_name:'Ama',last_name:'Mensah'},school:{school_name:'Test School'},capabilities};
const classes=[{classroom_id:'class-1',classroom_name:'Basic 5',subject_id:'subject-1',subject_name:'Mathematics',student_count:2},{classroom_id:'class-1',classroom_name:'Basic 5',subject_id:null,is_class_teacher:true},{classroom_id:'class-2',classroom_name:'Basic 6',subject_id:'subject-2',subject_name:'English'}];
const term={id:'term-1',name:'First Term',status:'active',academic_year_id:'year-1'};
const students=[{student_id:'student-1',first_name:'Kofi',last_name:'Asare',admission_no:'S001',score:null,attendance_status:'unmarked'},{student_id:'student-2',first_name:'Akua',last_name:'Addo',admission_no:'S002',score:null,attendance_status:'unmarked'}];
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,headers:{get:()=>null},clone(){return this}});
const waitFor=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5))}assert.fail('Mobile screen did not finish rendering')};

function harness(role='teacher',handler,options={}){
 const {document,window}=parseHTML(mobileExperienceFrontend(role));
 window.scrollTo=()=>{};window.HTMLElement.prototype.reportValidity=()=>true;
 // Linkedom omits the native select setter; reproduce its browser selection semantics.
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){const options=[...this.querySelectorAll('option')];return(options.find(o=>o.hasAttribute('selected'))||options[0])?.value||''},set(value){this.querySelectorAll('option').forEach(o=>o.toggleAttribute('selected',o.value===String(value)))}});
 const writes=[];
 const fetch=async(path,options={})=>{
  const method=options.method||'GET';if(method!=='GET')writes.push({path,body:options.body?JSON.parse(options.body):null,options});
  if(handler){const result=await handler(path,options);if(result)return result}
  if(path==='/api/system/core-status')return response({core:{healthy:true,status:200,url:'https://core.example.test'}});
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
 const context=vm.createContext({window,document,navigator:{onLine:true},fetch,sessionStorage:storage(options.sessions??{[role==='teacher'?'rx_teacher_token':'rx_parent_token']:'rxs_test'}),localStorage:storage(options.saved),location:{origin:'https://school.example',href:'https://school.example/mobile/'+role,pathname:'/mobile/'+role,search:options.search||'',replace(){}},URL,URLSearchParams,Set,AbortController,Date:options.clock?.Date||Date,setTimeout:options.clock?.setTimeout||setTimeout,clearTimeout:options.clock?.clearTimeout||clearTimeout,addEventListener:()=>{},FileReader:class{}});
 vm.runInContext(schoolSignInStartupScript+mobileWorkflowScript+mobileExperienceScript,context);
 const click=id=>document.getElementById(id).click();
 const submit=id=>document.getElementById(id).onsubmit({preventDefault(){}});
 const change=(id,value)=>{const input=document.getElementById(id);input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));if(input.onchange)input.onchange.call(input)};
 return{document,window,context,writes,click,submit,change};
}

test('mobile teacher login resolves school UUIDs, keeps failed credentials, prevents duplicate requests and opens first password change',async()=>{
 let attempts=0,finish;
 const h=harness('teacher',async(path,opt)=>{
  if(path==='/api/auth/schools')return response([{id:'alpha',name:'Alpha School',organisationId:'org-alpha'},{id:'beta',name:'Beta School',organisationId:'org-beta'}]);
  if(path==='/api/auth/staff-id-login'){
   attempts++;if(attempts===1)return new Promise(resolve=>finish=()=>resolve(response({error:{code:'SCHOOL_SIGN_IN_UNAVAILABLE',message:'The sign-in service is starting or unavailable. Please try again in a moment.'}},503)));
   return response({accessToken:'rxs_fixture_fresh',school:{id:'alpha'},requiresPasswordChange:true});
  }
  if(path==='/api/auth/change-password')return response({changed:true,redirectTo:'/teacher'});
 },{sessions:{},search:'?school=ORG-ALPHA',saved:{rx_school_id:'beta'}});
 await waitFor(()=>h.document.getElementById('mLoginSchool')?.value==='alpha');
 h.change('mLoginStaff','  STF-000001  ');h.change('mLoginPassword','FixtureStaff123!');
 const pending=h.submit('mLoginForm');await h.submit('mLoginForm');await waitFor(()=>typeof finish==='function');assert.equal(attempts,1);assert.match(h.document.getElementById('mLoginSubmit').textContent,/Signing in/);
 finish();await pending;
 assert.equal(h.document.getElementById('mLoginSchool').value,'alpha');assert.equal(h.document.getElementById('mLoginStaff').value,'  STF-000001  ');assert.equal(h.document.getElementById('mLoginPassword').value,'FixtureStaff123!');
 assert.equal(h.document.getElementById('mLoginSubmit').disabled,false);assert.match(h.document.getElementById('mError').textContent,/sign-in service is starting/);
 assert.deepEqual(h.writes[0].body,{schoolId:'alpha',staffId:'STF-000001',password:'FixtureStaff123!'});
 await h.submit('mLoginForm');await waitFor(()=>h.document.getElementById('mPasswordForm'));
 assert.equal(h.context.sessionStorage.getItem('rx_teacher_token'),'rxs_fixture_fresh');assert.equal(h.context.localStorage.getItem('rx_school_id'),'alpha');
 h.change('mNewPassword','FixturePersonal123!');h.change('mConfirmPassword','FixturePersonal123!');await h.submit('mPasswordForm');
 await waitFor(()=>h.document.querySelector('[data-go="scores"]'));assert.deepEqual(h.writes.at(-1).body,{newPassword:'FixturePersonal123!'});
});

test('mobile resumes a required staff password change after the app is reopened',async()=>{
 let contexts=0;
 const h=harness('teacher',async(path)=>{
  if(path==='/api/teacher/context'&&++contexts===1)return response({error:{code:'PASSWORD_CHANGE_REQUIRED',message:'Password change required before opening the School workspace'}},403);
  if(path==='/api/auth/change-password')return response({changed:true});
 });
 await waitFor(()=>h.document.getElementById('mPasswordForm'));assert.equal(h.document.getElementById('mLoginForm'),null);
 assert.equal(h.context.sessionStorage.getItem('rx_teacher_token'),'rxs_test');
 h.change('mNewPassword','FixturePersonal123!');h.change('mConfirmPassword','FixturePersonal123!');await h.submit('mPasswordForm');
 await waitFor(()=>h.document.querySelector('[data-go="scores"]'));
});

test('unavailable schools cannot submit a mobile staff login',async()=>{
 const h=harness('teacher',async path=>path==='/api/auth/schools'?response([]):null,{sessions:{}});
 await waitFor(()=>h.document.getElementById('mError')?.textContent.includes('No schools'));
 assert.equal(h.document.getElementById('mLoginSubmit').disabled,true);await h.submit('mLoginForm');assert.equal(h.writes.length,0);
});

test('mobile teacher and parent directories recover without losing entries or posting credentials during loading',async()=>{
 for(const role of ['teacher','parent']){
  const clock=virtualClock();let attempts=0;
  const h=harness(role,async path=>{
   if(path!=='/api/auth/schools')return null;
   attempts++;if(attempts===1)throw Error('Dropped connection');
   return attempts===2?response({error:{message:'Service starting'}},503):response([{id:'alpha',name:'Alpha'}]);
  },{sessions:{},search:'?school=alpha',clock});
  await waitFor(()=>h.document.getElementById('mLoginForm'));
  if(role==='teacher'){h.change('mLoginStaff','STF-000001');h.change('mLoginPassword','KeepEnteredPassword123!')}
  else h.change('mLoginPhone','0240000000');
  await waitFor(()=>h.document.getElementById('mLoginSchool')?.value==='alpha');
  assert.equal(h.document.getElementById('mLoginSubmit').disabled,false);assert.equal(attempts,3);assert.equal(h.writes.length,0);
  if(role==='teacher')assert.equal(h.document.getElementById('mLoginPassword').value,'KeepEnteredPassword123!');
  else assert.equal(h.document.getElementById('mLoginPhone').value,'0240000000');
 }
});

test('mobile reloads an unavailable school list on the same form with staff credentials retained',async()=>{
 let available=false;const clock=virtualClock();
 const h=harness('teacher',async path=>path==='/api/auth/schools'?(available?response([{id:'alpha',name:'Alpha'}]):response({},503)):null,{sessions:{},search:'?school=alpha',clock});
 await waitFor(()=>h.document.getElementById('mLoginForm'));h.change('mLoginStaff','STF-000001');h.change('mLoginPassword','KeepEnteredPassword123!');
 await waitFor(()=>h.document.getElementById('mLoginReload')?.hidden===false);
 available=true;await h.click('mLoginReload');await waitFor(()=>h.document.getElementById('mLoginSubmit')?.disabled===false);
 assert.equal(h.document.getElementById('mLoginPassword').value,'KeepEnteredPassword123!');assert.equal(h.document.getElementById('mLoginStaff').value,'STF-000001');assert.equal(h.writes.length,0);
});

test('mobile sign-in automatically wakes Core before sending a staff password to School',async()=>{
 let probes=0;const order=[];
 const h=harness('teacher',async(path,options)=>{
  order.push(path);
  if(path==='/api/auth/schools')return response([{id:'alpha',name:'Alpha'}]);
  if(path==='/api/system/core-status')return response({core:{url:'https://core.example.test',healthy:++probes>1,status:probes>1?200:429}});
  if(path==='https://core.example.test/health/live'){assert.equal(options.credentials,'omit');assert.equal(options.body,undefined);return{ok:false,status:0,json:()=>assert.fail()}}
  if(path==='/api/auth/staff-id-login')return response({accessToken:'rxs_fixture_fresh',school:{id:'alpha'}});
 },{sessions:{},search:'?school=alpha'});
 await waitFor(()=>h.document.getElementById('mLoginSchool')?.value==='alpha');h.change('mLoginStaff','STF-000001');h.change('mLoginPassword','FixtureStaffPass123!');await h.submit('mLoginForm');
 await waitFor(()=>h.document.querySelector('[data-go="scores"]'));
 assert.ok(order.indexOf('https://core.example.test/health/live')<order.indexOf('/api/auth/staff-id-login'));assert.equal(h.writes.length,1);
});

test('mobile preserves staff entries without posting a password if the original bridge never becomes ready',async()=>{
 const clock=virtualClock();
 const h=harness('teacher',async path=>{
  if(path==='/api/auth/schools')return response([{id:'alpha',name:'Alpha'}]);
  if(path==='/api/system/core-status')return response({core:{url:'https://core.example.test',healthy:false,status:429}});
  if(path==='https://core.example.test/health/live')return response(null,429);
 },{sessions:{},search:'?school=alpha',clock});
 await waitFor(()=>h.document.getElementById('mLoginSchool')?.value==='alpha');h.change('mLoginStaff','STF-000001');h.change('mLoginPassword','FixtureStaffPass123!');await h.submit('mLoginForm');
 assert.equal(h.writes.length,0);assert.equal(h.document.getElementById('mLoginStaff').value,'STF-000001');assert.equal(h.document.getElementById('mLoginPassword').value,'FixtureStaffPass123!');assert.equal(h.document.getElementById('mLoginSubmit').disabled,false);assert.match(h.document.getElementById('mError').textContent,/entries are still here/);
 assert.equal(clock.now(),90000);
});

test('mobile teacher sign-in recovers automatically after a dropped first connection and a minute of cold-start replies',async()=>{
 const clock=virtualClock();let probes=0;
 const h=harness('teacher',async(path)=>{
  if(path==='/api/auth/schools')return response([{id:'alpha',name:'Alpha'}]);
  if(path==='/api/system/core-status'){
   if(++probes===1)throw Error('connection dropped');
   return response({core:{url:'https://core.example.test',healthy:clock.now()>=60000,status:clock.now()>=60000?200:429}});
  }
  if(path==='https://core.example.test/health/live')return{ok:false,status:0,json:()=>assert.fail()};
  if(path==='/api/auth/staff-id-login')return response({accessToken:'rxs_fixture_fresh',school:{id:'alpha'}});
 },{sessions:{},search:'?school=alpha',clock});
 await waitFor(()=>h.document.getElementById('mLoginSchool')?.value==='alpha');h.change('mLoginStaff','STF-000001');h.change('mLoginPassword','FixtureStaffPass123!');
 await h.submit('mLoginForm');await waitFor(()=>h.document.querySelector('[data-go="scores"]'));
 assert.equal(clock.now(),60000);assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0].body,{schoolId:'alpha',staffId:'STF-000001',password:'FixtureStaffPass123!'});
});

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

test('Android back navigation protects unsaved marks and the class list stays in sync',async()=>{
 const h=harness();await openMarks(h);h.change('mLearnerMark','20');
 assert.equal(h.window.rxMobileBack(),true);assert.match(h.document.getElementById('mSheet').textContent,/unsaved entries/);
 h.click('mKeepEditing');assert.equal(h.document.getElementById('mLearnerMark').value,'20');
 h.click('mClassScores');const input=h.document.querySelector('[data-class-mark="student-1"]');input.value='25';input.oninput();h.click('mCloseSheet');
 assert.equal(h.document.getElementById('mLearnerMark').value,'25');
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
