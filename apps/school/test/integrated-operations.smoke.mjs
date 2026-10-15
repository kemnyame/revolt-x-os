import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import Fastify from 'fastify';
import {z} from 'zod';
import {operationsFixture,id,fail} from './helpers/operations-fixture.mjs';
import {registerHrPayrollRoutes} from '../dist/hr-payroll-routes.js';
import {registerOperationsReports,operationReportCatalogue,reportCsv} from '../dist/operations-reports.js';
import {registerTimetableAgentRoutes} from '../dist/timetable-routes.js';
import {planTimetable,timetableConflicts} from '../dist/timetable-agent.js';
import {activateYearPeriod,activateTermPeriod,attendanceByClass,registerTeachingPeriodGuard} from '../dist/academic-periods.js';
import {registerSchoolClassCatalogue} from '../dist/class-catalogue.js';
import {registerTeacherOversight} from '../dist/teacher-oversight.js';
import {payrollAccrualLines} from '../dist/payroll-workflow.js';

const school=id(1),other=id(2),year=id(30),nextYear=id(31),term=id(32),second=id(33),third=id(34),futureTerm=id(35);
const classA=id(40),classB=id(41),historyClass=id(42),subjectA=id(45),subjectB=id(46),grade=id(50);
const actors={admin:{id:id(10),role:'school_admin'},hr:{id:id(11),role:'registrar'},finance:{id:id(12),role:'accountant'},teacher:{id:id(13),role:'teacher'},otherTeacher:{id:id(14),role:'teacher'},outsider:{id:id(20),role:'school_admin',org:other}};
let f,app,run,item,componentIds={},postJournal;
const users=Object.entries(actors).map(([name,a])=>({id:a.id,first_name:name,last_name:'Fixture',employee_number:'STAFF-'+name}));
const headers=who=>({'x-actor':who});
async function request(method,url,payload,who='admin'){const r=await app.inject({method,url,headers:headers(who),...(payload===undefined?{}:{payload})});return r}
async function expect(method,url,payload,who,status=200){const r=await request(method,url,payload,who);assert.equal(r.statusCode,status,url+': '+r.body);return r.json()}

before(async()=>{
 f=await operationsFixture();const {db}=f;
 const schoolRoleProfile=async(_db,org,role)=>(await db.query('SELECT * FROM school_roles WHERE organisation_id=$1 AND key=$2',[org,role])).rows[0];
 const effectiveCapabilities=async(_db,org,role)=>(await db.query('SELECT capability_key FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND allowed=true',[org,role])).rows.map(x=>x.capability_key);
 const authorize=async(req,_db,_config,capability)=>{const actor=actors[req.headers['x-actor']||'admin'];if(!actor)throw fail(401,'Sign in');const org=actor.org||school;if(capability&&actor.role!=='school_admin'&&!(await effectiveCapabilities(db,org,actor.role)).includes(capability))throw fail(403,'Access denied');return{core:{organisation_id:org,id:actor.id},role:actor.role}};
 const server=await readFile(new URL('../dist/server.js',import.meta.url),'utf8'),context={one:f.one,maybeOne:f.maybeOne,fail,randomBytes};
 const start=server.indexOf('async function postFinanceJournal('),end=server.indexOf('async function reverseFinanceJournal(',start);assert.ok(start>0&&end>start);vm.runInNewContext(server.slice(start,end),context);postJournal=context.postFinanceJournal;
 app=Fastify();app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof z.ZodError?400:e.statusCode||(e.code==='23P01'?409:500)).send({error:{message:e.message}}));
 const deps={...f,authorize,schoolRoleProfile,effectiveCapabilities,schoolLicence:async()=>({status:'legacy',modules:[]}),postFinanceJournal:postJournal,fetchCoreUsers:async org=>users.filter(u=>(actors[Object.keys(actors).find(k=>actors[k].id===u.id)]?.org||school)===org),activeTerm:async()=>f.maybeOne(db,"SELECT * FROM terms WHERE organisation_id=$1 AND status='active'",[school]),effectiveClassTeacher:async(org,cid)=>((await db.query('SELECT class_teacher_os_user_id FROM classrooms WHERE organisation_id=$1 AND id=$2',[org,cid])).rows[0]||{}).class_teacher_os_user_id};
 await registerTeachingPeriodGuard(app,deps);
 await registerHrPayrollRoutes(app,deps);await registerOperationsReports(app,deps);await registerTimetableAgentRoutes(app,deps);await registerSchoolClassCatalogue(app,deps);await registerTeacherOversight(app,deps);
 app.post('/api/assessments',async()=>({accepted:true}));app.post('/api/assessments/:id/scores',async()=>({accepted:true}));
 for(const a of Object.values(actors))await db.query('INSERT INTO school_memberships(organisation_id,os_user_id,role) VALUES($1,$2,$3)',[a.org||school,a.id,a.role]);
 await db.query("INSERT INTO academic_years(id,organisation_id,name,start_date,end_date,status) VALUES($1,$3,'2026/27','2026-09-01','2027-08-31','active'),($2,$3,'2027/28','2027-09-01','2028-08-31','draft')",[year,nextYear,school]);
 for(const [n,tid] of [term,second,third].entries())await db.query('INSERT INTO terms(id,organisation_id,academic_year_id,term_no,name,start_date,end_date,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tid,school,year,n+1,['First Term','Second Term','Third Term'][n],'2026-09-01','2027-08-31',n===0?'active':'planned']);
 for(let n=1;n<=3;n++)await db.query("INSERT INTO terms(id,organisation_id,academic_year_id,term_no,name,start_date,end_date) VALUES($1,$2,$3,$4,$5,'2027-09-01','2028-08-31')",[n===1?futureTerm:id(35+n),school,nextYear,n,'Term '+n]);
 await db.query("INSERT INTO grade_levels(id,organisation_id,code,name,stage,level_order) VALUES($1,$2,'CL1','Class 1','primary',1)",[grade,school]);
 await db.query("INSERT INTO classrooms(id,organisation_id,academic_year_id,grade_level_id,name,class_teacher_os_user_id) VALUES($1,$4,$5,$6,'Class 1',$7),($2,$4,$5,$6,'Class 2',$8),($3,$4,$9,$6,'Future Class',NULL)",[classA,classB,historyClass,school,year,grade,actors.teacher.id,actors.otherTeacher.id,nextYear]);
 await db.query("INSERT INTO subjects(id,organisation_id,code,name) VALUES($1,$3,'MATH','Mathematics'),($2,$3,'ENG','English')",[subjectA,subjectB,school]);
 for(const [cid,sid,teacher] of [[classA,subjectA,actors.teacher.id],[classA,subjectB,actors.finance.id],[classB,subjectA,actors.otherTeacher.id]]){
   await db.query('INSERT INTO class_subjects(organisation_id,academic_year_id,classroom_id,subject_id,weekly_periods,credit_hours) VALUES($1,$2,$3,$4,2,1)',[school,year,cid,sid]);
   if(teacher!==actors.finance.id)await db.query('INSERT INTO teacher_assignments(organisation_id,academic_year_id,classroom_id,subject_id,teacher_os_user_id) VALUES($1,$2,$3,$4,$5)',[school,year,cid,sid,teacher]);
 }
 // Finance is not a teacher; English is assigned to the second teacher instead.
 await db.query('INSERT INTO teacher_assignments(organisation_id,academic_year_id,classroom_id,subject_id,teacher_os_user_id) VALUES($1,$2,$3,$4,$5)',[school,year,classA,subjectB,actors.otherTeacher.id]);
 for(let n=0;n<12;n++){const sid=id(100+n),cid=n===11?classB:classA;await db.query("INSERT INTO students(id,organisation_id,admission_no,first_name,last_name) VALUES($1,$2,$3,'Learner',$4)",[sid,school,'ST-'+n,String(n)]);await db.query('INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id) VALUES($1,$2,$3,$4)',[school,sid,year,cid])}
 await db.query("INSERT INTO attendance_records(organisation_id,classroom_id,student_id,attendance_date,status,marked_by_os_user_id) VALUES($1,$2,$3,current_date,'present',$4)",[school,classA,id(100),actors.teacher.id]);
 await db.query("INSERT INTO payroll_grades(id,organisation_id,code,name,base_salary) VALUES($1,$2,'G1','Teaching and Support',1000)",[id(60),school]);
 for(const a of Object.values(actors).filter(a=>!a.org))await db.query('INSERT INTO staff_payroll_profiles(organisation_id,os_user_id,grade_id) VALUES($1,$2,$3)',[school,a.id,id(60)]);
 for(const c of (await db.query('SELECT * FROM payroll_components WHERE organisation_id=$1',[school])).rows)componentIds[c.code]=c.id;
 await db.query('INSERT INTO payroll_grade_components(organisation_id,grade_id,component_id,value_override) VALUES($1,$2,$3,200),($1,$2,$4,100),($1,$2,$5,NULL)',[school,id(60),componentIds.ALLOW,componentIds.PAYE,componentIds.SSNIT]);
 await db.query('INSERT INTO staff_payroll_component_assignments(organisation_id,os_user_id,component_id,value_override) VALUES($1,$2,$3,50)',[school,actors.teacher.id,componentIds.LOAN]);
});
after(async()=>{await app?.close();await f?.pg.close()});

test('every operational report executes against the complete migrated schema',async()=>{
 for(const key of Object.keys(operationReportCatalogue)){const r=await expect('GET','/api/operations-reports/'+key,undefined,'admin');assert.ok(Array.isArray(r.rows),key)}
 const page=await expect('GET','/api/operations-reports/students?pageSize=5&page=2&classroomId='+classA,undefined,'admin');assert.equal(page.total,11);assert.equal(page.rows.length,5);assert.equal(page.pages,3);
 const search=await expect('GET','/api/operations-reports/students?q=Learner%2010',undefined,'admin');assert.equal(search.total,1);
 const cross=await expect('GET','/api/operations-reports/students',undefined,'outsider');assert.equal(cross.total,0);
 const csv=await request('GET','/api/operations-reports/students?format=csv');assert.equal(csv.statusCode,200,csv.body);assert.equal(csv.body.split('\r\n').length,13);
 const pdf=await request('GET','/api/operations-reports/students?format=pdf');assert.equal(pdf.statusCode,200,pdf.body);assert.ok(pdf.rawPayload.subarray(0,4).equals(Buffer.from('%PDF')));
});

test('teacher reports remain class scoped and cannot expose payroll or another class',async()=>{
 const kinds=await expect('GET','/api/operations-reports',undefined,'teacher');assert.ok(!kinds.some(k=>k.key==='payroll'));
 await expect('GET','/api/operations-reports/payroll',undefined,'teacher',403);
 const students=await expect('GET','/api/operations-reports/students',undefined,'teacher');assert.equal(students.total,11);
 const forbidden=await expect('GET','/api/operations-reports/students?classroomId='+classB,undefined,'teacher');assert.equal(forbidden.total,0);
});

test('teachers cannot reopen historical or planned periods through dropdowns or explicit writes',async()=>{
 const classes=await expect('GET','/api/classes?includeAllYears=true',undefined,'teacher');assert.equal(classes.length,2);assert.ok(classes.every(c=>c.academic_year_id===year));
 const future=await expect('GET','/api/classes?academicYearId='+nextYear,undefined,'teacher');assert.equal(future.length,0);
 await expect('POST','/api/assessments',{academicYearId:nextYear,termId:futureTerm,classroomId:historyClass},'teacher',423);
 await expect('POST','/api/assessments',{academicYearId:year,termId:second,classroomId:classA},'teacher',423);
 await expect('POST','/api/assessments',{academicYearId:year,termId:term,classroomId:classA},'teacher');
});

test('Class Teacher oversight includes subject teachers and excludes unrelated teachers',async()=>{
 const x=await expect('GET','/api/teacher/class-overview?classroomId='+classA,undefined,'teacher');assert.equal(x.subjects.length,2);assert.equal(x.students.length,11);
 await expect('GET','/api/teacher/class-overview?classroomId='+classA,undefined,'otherTeacher',403);
});

test('attendance today includes every class, including unmarked learners',async()=>{
 const rows=await attendanceByClass(f.db,school);assert.equal(rows.length,2);const a=rows.find(r=>r.classroom_id===classA);assert.equal(a.present,1);assert.equal(a.students,11);assert.equal(a.unmarked,10);
 assert.deepEqual((await attendanceByClass(f.db,school,[classB])).map(r=>r.classroom_id),[classB]);
});

test('HR prepares grade earnings and deductions with personal overrides and immutable GL snapshots',async()=>{
 run=await expect('POST','/api/payroll/runs',{year:2026,month:10},'hr',201);assert.equal(Number(run.gross_total),6000);assert.equal(Number(run.deductions_total),825);assert.equal(Number(run.net_total),5175);
 const detail=await expect('GET','/api/payroll/runs/'+run.id,undefined,'hr');assert.equal(detail.items.length,5);item=detail.items.find(i=>i.os_user_id===actors.teacher.id);assert.equal(Number(item.net_pay),995);assert.equal(item.salary_grade_name,'Teaching and Support');assert.equal(item.components.length,5);assert.ok(item.components.every(c=>c.posting_account_id));
 await expect('POST','/api/payroll/runs',{year:2026,month:10},'hr',409);
 const external=(await f.db.query("SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code='2110'",[other])).rows[0];
 await expect('POST','/api/payroll/components',{code:'INVALID_GL',name:'Foreign deduction',componentType:'deduction',postingAccountId:external.id},'hr',400);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM payroll_components WHERE organisation_id=$1 AND code='INVALID_GL'",[school])).rows[0].n,0);
});

test('Finance receives HR submission, approvals post each deduction GL once, and staff cannot process payments',async()=>{
 await expect('POST','/api/payroll/runs/'+run.id+'/publish',{},'hr',409);
 await expect('POST','/api/payroll/runs/'+run.id+'/pay',{},'finance',409);
 await expect('POST','/api/payroll/runs/'+run.id+'/approve',{},'teacher',403);
 await expect('POST','/api/payroll/runs/'+run.id+'/submit',{},'hr');await expect('POST','/api/payroll/runs/'+run.id+'/submit',{},'hr');
 const notice=(await f.db.query("SELECT count(*)::int n FROM staff_notifications WHERE recipient_os_user_id=$1 AND event_key='payroll.finance_review'",[actors.finance.id])).rows[0];assert.equal(notice.n,1);
 // Editing the component definition after submission cannot change this run's mapping.
 const loanGl=(await f.db.query("SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code='1130'",[school])).rows[0].id;
 await f.db.query('UPDATE payroll_components SET posting_account_id=$1 WHERE id=$2',[loanGl,componentIds.PAYE]);
 await expect('POST','/api/payroll/runs/'+run.id+'/approve',{},'finance');await expect('POST','/api/payroll/runs/'+run.id+'/approve',{},'finance');
 const lines=(await f.db.query("SELECT a.code,l.debit,l.credit FROM finance_journal_lines l JOIN finance_accounts a ON a.id=l.account_id JOIN finance_journal_entries e ON e.id=l.journal_entry_id WHERE e.organisation_id=$1 AND e.source_type='payroll_accrual' AND e.source_id=$2",[school,run.id])).rows;
 const credits=Object.fromEntries(lines.map(l=>[l.code,Number(l.credit)]));assert.equal(credits['2110'],500);assert.equal(credits['2120'],275);assert.equal(credits['1130'],50);assert.equal(credits['2050'],5175);assert.equal(lines.reduce((n,l)=>n+Number(l.debit)-Number(l.credit),0),0);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM finance_journal_entries WHERE source_id=$1 AND source_type='payroll_accrual'",[run.id])).rows[0].n,1);
});

test('payment remains private until HR publishes, then each staff sees only their own paid payslip',async()=>{
 assert.deepEqual(await expect('GET','/api/payroll/me',undefined,'teacher'),[]);
 await expect('GET','/api/payroll/me/'+item.id+'/export',undefined,'teacher',404);
 const foreign=(await f.db.query("SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code='1010'",[other])).rows[0];await expect('POST','/api/payroll/runs/'+run.id+'/pay',{paymentAccountId:foreign.id},'finance',400);
 await expect('POST','/api/payroll/runs/'+run.id+'/pay',{paymentDate:'2026-10-15',reference:'FIXTURE-TRANSFER'},'finance');await expect('POST','/api/payroll/runs/'+run.id+'/pay',{},'finance');
 assert.deepEqual(await expect('GET','/api/payroll/me',undefined,'teacher'),[]);
 await expect('POST','/api/payroll/runs/'+run.id+'/publish',{},'finance',403);
 await expect('POST','/api/payroll/runs/'+run.id+'/publish',{},'hr');await expect('POST','/api/payroll/runs/'+run.id+'/publish',{},'hr');
 const payslips=await expect('GET','/api/payroll/me?year=2026&month=10',undefined,'teacher');assert.equal(payslips.length,1);assert.equal(payslips[0].id,item.id);assert.equal(payslips[0].components.length,5);
 assert.deepEqual(await expect('GET','/api/payroll/me?month=9',undefined,'teacher'),[]);
 await expect('GET','/api/payroll/me/'+item.id+'/export',undefined,'otherTeacher',404);await expect('GET','/api/payroll/me/'+item.id+'/export',undefined,'outsider',404);
 const pdf=await request('GET','/api/payroll/me/'+item.id+'/export',undefined,'teacher');assert.equal(pdf.statusCode,200);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');
 assert.equal((await f.db.query("SELECT count(*)::int n FROM finance_journal_entries WHERE source_id=$1 AND source_type='payroll_payment'",[run.id])).rows[0].n,1);
 const history=await expect('GET','/api/operations-reports/transactions',undefined,'finance');assert.ok(history.rows.some(r=>r.source_type==='payroll_payment'));assert.ok(history.rows.some(r=>r.source_type==='payroll_accrual'));
});

test('the planner verifies complete schedules and reports unavailable staff without saving partial results',()=>{
 const requirement={classroom_id:classA,subject_id:subjectA,teacher_os_user_id:actors.teacher.id,weekly_periods:5};
 const plan=planTimetable({requirements:[requirement,{...requirement,classroom_id:classB,subject_id:subjectB}],existing:[],breaks:[{start_time:'09:00',end_time:'09:20'}],unavailability:[{teacher_os_user_id:actors.teacher.id,day_of_week:1,start_time:'08:00',end_time:'12:00'}],settings:{school_day_start:'08:00',school_day_end:'12:00',default_period_minutes:40,max_teacher_periods_per_day:4},termId:term});
 assert.equal(plan.complete,true,JSON.stringify(plan.unscheduled));assert.equal(plan.suggestions.length,10);assert.equal(timetableConflicts(plan.suggestions).length,0);assert.ok(plan.suggestions.every(p=>p.day_of_week!==1));
 const impossible=planTimetable({requirements:[{...requirement,weekly_periods:30}],existing:[],breaks:[],unavailability:[],settings:{school_day_start:'08:00',school_day_end:'08:40',default_period_minutes:40},termId:term});assert.equal(impossible.complete,false);assert.ok(impossible.unscheduled.length);
 const manualConflict=planTimetable({requirements:[],existing:[{id:id(900),...requirement,day_of_week:1,start_time:'07:00',end_time:'07:40'}],breaks:[],unavailability:[],settings:{school_day_start:'08:00',school_day_end:'12:00'}});assert.equal(manualConflict.complete,false);
 assert.throws(()=>payrollAccrualLines({gross_total:10,deductions_total:2,net_total:8},[{name:'Missing GL',component_type:'deduction',amount:2,posting_account_id:null}],id(99),id(98)),/Map/);
 assert.ok(reportCsv(['text'],[{text:'=HYPERLINK("bad")'}]).includes("'=HYPERLINK"));
});

test('regeneration preserves manual lessons, rejects stale previews and rolls back infeasible changes',async()=>{
 await f.db.query("INSERT INTO timetable_entries(id,organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,schedule_source,is_locked) VALUES($1,$2,$3,$4,$5,$6,$7,1,'08:00','08:40','manual',true)",[id(300),school,year,term,classA,subjectA,actors.teacher.id]);
 const payload={academicYearId:year,termId:term,regenerateAuto:true};
 const preview=await expect('POST','/api/timetable/auto-schedule/preview',payload,'admin');assert.equal(preview.complete,true);assert.equal(preview.suggestions.length,5);
 await expect('POST','/api/timetable/auto-schedule/apply',{...payload,planFingerprint:preview.planFingerprint},'admin',201);
 const before=(await f.db.query('SELECT * FROM timetable_entries WHERE organisation_id=$1 ORDER BY id',[school])).rows;assert.equal(before.length,6);assert.ok(before.some(r=>r.id===id(300)));
 await expect('POST','/api/timetable/auto-schedule/apply',{...payload,planFingerprint:preview.planFingerprint},'admin',409);
 const next=await expect('POST','/api/timetable/auto-schedule/preview',payload,'admin');await expect('POST','/api/timetable/auto-schedule/apply',{...payload,planFingerprint:next.planFingerprint},'admin',201);assert.equal((await f.db.query('SELECT count(*)::int n FROM timetable_entries')).rows[0].n,6);
 await f.db.query('UPDATE class_subjects SET weekly_periods=20 WHERE organisation_id=$1',[school]);
 await expect('POST','/api/timetable/auto-schedule/apply',payload,'admin',409);assert.equal((await f.db.query('SELECT count(*)::int n FROM timetable_entries')).rows[0].n,6);
 await f.db.query('UPDATE class_subjects SET weekly_periods=2 WHERE organisation_id=$1',[school]);
 // Database protection covers partial overlaps and case/space variations in rooms.
 await assert.rejects(f.db.query("INSERT INTO timetable_entries(organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time) VALUES($1,$2,$3,$4,$5,$6,1,'08:20','09:00')",[school,year,term,classB,subjectA,actors.teacher.id]),e=>e.code==='23P01');
});

test('three terms advance in order and rollover closes the old year while activating First Term',async()=>{
 await assert.rejects(f.tx(f.db,c=>activateTermPeriod(c,school,third,actors.admin.id)),/in order/);
 await f.tx(f.db,c=>activateTermPeriod(c,school,second,actors.admin.id));assert.equal((await f.db.query('SELECT is_locked FROM terms WHERE id=$1',[term])).rows[0].is_locked,true);
 await assert.rejects(f.tx(f.db,c=>activateTermPeriod(c,school,term,actors.admin.id)),/reopen/);
 await f.tx(f.db,c=>activateTermPeriod(c,school,third,actors.admin.id));
 await f.tx(f.db,c=>activateYearPeriod(c,school,nextYear,actors.admin.id));
 const years=(await f.db.query('SELECT * FROM academic_years ORDER BY start_date')).rows;assert.equal(years[0].status,'closed');assert.equal(years[0].is_locked,true);assert.equal(years[1].status,'active');
 const terms=(await f.db.query('SELECT * FROM terms WHERE academic_year_id=$1 ORDER BY term_no',[nextYear])).rows;assert.deepEqual(terms.map(t=>t.status),['active','planned','planned']);
 await expect('POST','/api/assessments',{academicYearId:year,termId:term,classroomId:classA},'teacher',423);
});
