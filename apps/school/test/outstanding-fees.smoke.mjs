import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import Fastify from 'fastify';
import {parseHTML} from 'linkedom';
import {operationsFixture,id,fail} from './helpers/operations-fixture.mjs';
import {registerOutstandingFees} from '../dist/outstanding-fees.js';
import {schoolAppScript,schoolFrontend} from '../dist/ui.js';
let f,app;
const school=id(1),other=id(2),year=id(30),old=id(31),term=id(32),cls=id(40),grade=id(41),fee=id(50),waived=id(51);
before(async()=>{
 f=await operationsFixture();const db=f.db;app=Fastify();app.setErrorHandler((e,_r,p)=>p.code(e.statusCode||500).send({error:{message:e.message}}));
 await registerOutstandingFees(app,{...f,authorize:async r=>{if(r.headers['x-role']==='teacher')throw fail(403,'Finance access required');return{core:{organisation_id:r.headers['x-role']==='other'?other:school,id:id(10)}}}});
 await db.query("INSERT INTO academic_years(id,organisation_id,name,start_date,end_date,status) VALUES($1,$3,'2026/27','2026-09-01','2027-08-31','active'),($2,$3,'2025/26','2025-09-01','2026-08-31','closed')",[year,old,school]);
 await db.query("INSERT INTO terms(id,organisation_id,academic_year_id,term_no,name,start_date,end_date,status) VALUES($1,$2,$3,1,'First Term','2026-09-01','2026-12-20','active')",[term,school,year]);
 await db.query("INSERT INTO grade_levels(id,organisation_id,code,name,stage,level_order) VALUES($1,$2,'P1','Class 1','primary',1)",[grade,school]);
 await db.query("INSERT INTO classrooms(id,organisation_id,academic_year_id,grade_level_id,name) VALUES($1,$2,$3,$4,'Class 1')",[cls,school,year,grade]);
 await db.query("INSERT INTO fee_items(id,organisation_id,academic_year_id,term_id,name,amount) VALUES($1,$3,$4,$5,'Tuition',100),($2,$3,$4,$5,'Waived transport',100)",[fee,waived,school,year,term]);
 for(let n=0;n<16;n++){
  const sid=id(100+n),sf=id(200+n);await db.query("INSERT INTO students(id,organisation_id,admission_no,first_name,last_name) VALUES($1,$2,$3,'Learner',$4)",[sid,school,'S-'+n,String(n)]);
  await db.query('INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id) VALUES($1,$2,$3,$4)',[school,sid,year,cls]);
  await db.query('INSERT INTO student_fees(id,organisation_id,student_id,fee_item_id,amount_due,discount) VALUES($1,$2,$3,$4,100,10)',[sf,school,sid,fee]);
  await db.query("INSERT INTO student_fees(organisation_id,student_id,fee_item_id,amount_due,status) VALUES($1,$2,$3,100,'waived')",[school,sid,waived]);
 }
 await db.query("INSERT INTO payments(organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id) VALUES($1,$2,$3,20,'cash','PARTIAL',$4),($1,$5,$6,90,'cash','FULL',$4)",[school,id(100),id(200),id(10),id(101),id(201)]);
 await db.query("INSERT INTO payments(organisation_id,student_id,student_fee_id,amount,payment_method,reference,received_by_os_user_id,voided_at) VALUES($1,$2,$3,80,'cash','REVERSED',$4,now())",[school,id(100),id(200),id(10)]);
 await db.query("INSERT INTO student_account_credits(organisation_id,student_id,original_amount,balance,status,created_by_os_user_id) VALUES($1,$2,100,100,'open',$4),($1,$3,15,15,'open',$4)",[school,id(102),id(103),id(10)]);
});
after(async()=>{await app?.close();await f?.pg.close()});
test('all students owing are counted beyond the first page and balance calculations ignore waived/reversed amounts',async()=>{
 const r=await app.inject('/api/fees/outstanding?pageSize=5');assert.equal(r.statusCode,200,r.body);const x=r.json();assert.equal(x.summary.students,14);assert.equal(x.rows.length,5);assert.equal(x.pages,3);assert.equal(Number(x.summary.amount_owing),1225);
 const last=(await app.inject('/api/fees/outstanding?pageSize=5&page=3')).json();assert.equal(last.rows.length,4);
 const partial=(await app.inject('/api/fees/outstanding?studentId='+id(100))).json().rows[0];assert.equal(Number(partial.amount_owing),70);assert.equal(Number(partial.paid),20);assert.equal(partial.fees.length,1);
 const credit=(await app.inject('/api/fees/outstanding?studentId='+id(103))).json().rows[0];assert.equal(Number(credit.unpaid_fees),90);assert.equal(Number(credit.available_credit),15);assert.equal(Number(credit.amount_owing),75);
 for(const sid of [id(101),id(102)])assert.equal((await app.inject('/api/fees/outstanding?studentId='+sid)).json().rows.length,0);
});
test('class, term, name and ID filters apply to the complete debtor list',async()=>{
 for(const query of ['classroomId='+cls,'termId='+term,'academicYearId='+year])assert.equal((await app.inject('/api/fees/outstanding?'+query)).json().summary.students,14);
 const search=(await app.inject('/api/fees/outstanding?q=Learner%2015')).json();assert.equal(search.rows.length,1);assert.equal(search.rows[0].admission_no,'S-15');
 assert.equal((await app.inject('/api/fees/outstanding?academicYearId='+old)).json().summary.students,0);
});
test('CSV and PDF export every matching student, while school and role boundaries protect balances',async()=>{
 const csv=await app.inject('/api/fees/outstanding?format=csv&pageSize=5');assert.equal(csv.statusCode,200,csv.body);assert.equal(csv.body.split('\r\n').length,15);assert.match(csv.body,/fee details/);assert.match(csv.body,/Tuition/);
 const pdf=await app.inject('/api/fees/outstanding?format=pdf');assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');
 const other=await app.inject({url:'/api/fees/outstanding',headers:{'x-role':'other'}});assert.equal(other.json().summary.students,0);
 const teacher=await app.inject({url:'/api/fees/outstanding',headers:{'x-role':'teacher'}});assert.equal(teacher.statusCode,403);
});

test('Finance Reports shows and exports the students owing report only with fees access',async()=>{
 const {document}=parseHTML(schoolFrontend);
 // linkedom exposes a getter-only select value. Model a normal browser selection.
 Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{
  configurable:true,
  get(){return (this.querySelector('option[selected]')||this.querySelector('option'))?.value||''},
  set(value){this.querySelectorAll('option').forEach(option=>option.toggleAttribute('selected',option.value===value))}
 });
 const requests=[];
 const browser={
  document,URL,URLSearchParams,Headers,AbortController,
  location:new URL('https://school.example.test/'),sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,
  async fetch(path){
   requests.push(path);
   if(path.startsWith('/api/fees/outstanding?')){
    const response=await app.inject(path);
    return new Response(response.rawPayload,{status:response.statusCode});
   }
   if(path==='/api/academic-years')return Response.json([{id:year,name:'2026/27'}]);
   if(path==='/api/terms')return Response.json([{id:term,name:'First Term',academic_year_id:year}]);
   if(path==='/api/classes?includeAllYears=true')return Response.json([{id:cls,name:'Class 1',academic_year_id:year}]);
   if(path.startsWith('/api/finance/reports/trial-balance'))return Response.json({rows:[{name:'Cash',debit:100}]});
   if(path==='/api/finance/taxes')return Response.json({types:[],obligations:[]});
   return Response.json([]);
  }
 };
 browser.window=browser;
 const startup=schoolAppScript.indexOf('// Start boot immediately.');
 assert.ok(startup>0);
 vm.runInNewContext(schoolAppScript.slice(0,startup)+
  'window.showFinance=function(profile){ctx=profile;return page("finance")};})();',browser);
 const profile={capabilities:['screen.finance.view','finance.reports.view','fees.view'],license:{status:'legacy'},profile:{currency:'GHS'}};
 const field=name=>document.getElementById(name);
 await browser.showFinance(profile);
 const select=field('financeReport');
 assert.ok(select?.querySelector('option[value="students-owing"]'));
 select.value='students-owing';
 await select.onchange();
 const output=field('financeReportOut');
 assert.match(output.textContent,/Students owing14/);
 assert.match(output.textContent,/GHS 1,225\.00/);
 assert.equal(output.querySelectorAll('tbody tr').length,10);
 assert.equal(field('financeReportActions').classList.contains('hide'),true);
 field('debtClass').value=cls;
 field('debtSearch').value='Learner 15';
 await field('debtLoad').onclick();
 assert.equal(output.querySelectorAll('tbody tr').length,1);
 assert.match(output.textContent,/S-15/);
 await field('debtCsv').onclick();
 const exported=new URL(requests.at(-1),browser.location).searchParams;
 assert.equal(exported.get('format'),'csv');
 assert.equal(exported.get('classroomId'),cls);
 assert.equal(exported.get('q'),'Learner 15');
 select.value='trial-balance';
 select.onchange();
 await field('runFinanceReport').onclick();
 assert.match(output.textContent,/Cash/);
 assert.equal(field('debtCsv'),null);
 await browser.showFinance({...profile,capabilities:profile.capabilities.filter(cap=>cap!=='fees.view')});
 assert.equal(field('financeReport').querySelector('option[value="students-owing"]'),null);
});
