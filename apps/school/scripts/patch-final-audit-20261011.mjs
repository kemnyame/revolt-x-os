import { readFile, writeFile } from 'node:fs/promises';

const serverPath=new URL('../src/server.ts',import.meta.url);
const uiPath=new URL('../src/ui.ts',import.meta.url);
const payrollPath=new URL('../src/hr-payroll-routes.ts',import.meta.url);

function replaceRequired(source,oldValue,newValue,label){
  if(source.includes(newValue))return source;
  if(!source.includes(oldValue))throw new Error('Final remediation patch could not find '+label);
  return source.replace(oldValue,newValue);
}

let ui=await readFile(uiPath,'utf8');

ui=replaceRequired(
  ui,
  "if(/published|approved|graded|paid|active|present|success|taught|enrolled|complete|released/.test(n))c=' success';else if(/submitted|under_review|processing|in_progress/.test(n))c=' submitted';",
  "if(/published|approved|graded|paid|active|present|success|taught|enrolled|complete|released|submitted/.test(n))c=' success';else if(/under_review|processing|in_progress/.test(n))c=' submitted';",
  'submitted status colour'
);

if(!ui.includes('data-pay-component-override')){
  const anchor="E('saveEmolument').onclick=async function(){var base=Number(E('hrBasic').value);";
  const injection=`components.filter(function(c){return c.is_active}).forEach(function(c){
     var checkbox=E('hrComponents').querySelector('[data-pay-component="'+c.id+'"]');if(!checkbox)return;
     var label=checkbox.closest('label'),assignedComponent=assigned.find(function(x){return x.component_id===c.id}),input=document.createElement('input');
     input.type='number';input.min='0';input.step='0.01';input.dataset.payComponentOverride=c.id;
     input.placeholder=c.code==='PAYE'?'Automatic PAYE for Sep-Dec 2026':(c.calculation_type==='percent_basic'?String(c.rate_percent||0)+'%':String(c.default_value||0));
     input.value=assignedComponent?(c.calculation_type==='percent_basic'?(assignedComponent.rate_override??''):(assignedComponent.value_override??'')):'';
     input.title=c.calculation_type==='percent_basic'?'Optional staff-specific percentage override':'Optional staff-specific amount override';
     input.style.marginLeft='auto';input.style.maxWidth='150px';label.appendChild(input)
   });
   ${anchor}`;
  ui=replaceRequired(ui,anchor,injection,'staff payroll override inputs');

  const oldSave="var cs=[];E('hrComponents').querySelectorAll('[data-pay-component]:checked').forEach(function(x){cs.push({componentId:x.dataset.payComponent,isActive:true})});";
  const newSave="var cs=[];E('hrComponents').querySelectorAll('[data-pay-component]:checked').forEach(function(x){var component=components.find(function(c){return c.id===x.dataset.payComponent}),override=E('hrComponents').querySelector('[data-pay-component-override=\"'+x.dataset.payComponent+'\"]'),rawOverride=override?override.value.trim():'',item={componentId:x.dataset.payComponent,isActive:true};if(rawOverride!==''){var numericOverride=Number(rawOverride);if(!Number.isFinite(numericOverride)||numericOverride<0)throw Error('Enter a valid non-negative payroll override');if(component&&component.calculation_type==='percent_basic')item.rateOverride=numericOverride;else item.valueOverride=numericOverride}cs.push(item)});";
  ui=replaceRequired(ui,oldSave,newSave,'staff payroll override save logic');
}

const oldPayslip="{key:'net_pay',label:'Net Pay',render:function(r){return'<b>'+docMoney(r.net_pay,'GHS')+'</b>'}},{key:'status',render:function(r){return badge(r.status)}}";
const newPayslip="{key:'net_pay',label:'Net Pay',render:function(r){return'<b>'+docMoney(r.net_pay,'GHS')+'</b>'}},{key:'components',label:'Earnings & deductions',render:function(r){return (r.components||[]).map(function(c){return'<span class=\"badge '+(c.component_type==='earning'?'success':'pending')+'\">'+esc(c.name)+': '+docMoney(c.amount,'GHS')+'</span>'}).join(' ')}},{key:'status',render:function(r){return badge(r.status)}}";
ui=replaceRequired(ui,oldPayslip,newPayslip,'staff payslip component detail');

await writeFile(uiPath,ui);

let payroll=await readFile(payrollPath,'utf8');
const oldAmount=`  function componentAmount(c:any,basic:number){
    if(c.calculation_type==='percent_basic')return Math.round((basic*Number(c.rate_override??c.rate_percent??0)/100)*100)/100;
    return Math.round(Number(c.value_override??c.default_value??0)*100)/100;
  }
`;
const newAmount=`  function roundMoney(value:number){return Math.round(value*100)/100}
  function componentAmount(c:any,basic:number){
    if(c.calculation_type==='percent_basic')return roundMoney(basic*Number(c.rate_override??c.rate_percent??0)/100);
    return roundMoney(Number(c.value_override??c.default_value??0));
  }
  function ghanaMonthlyPaye2026(chargeableIncome:number){
    let remaining=Math.max(0,Number(chargeableIncome||0)),tax=0;
    const bands:Array<[number,number]>=[[588,0],[80,.05],[100,.10],[2900,.175],[16000,.25],[30332,.30]];
    for(const [band,rate] of bands){if(remaining<=0)break;const taxable=Math.min(remaining,band);tax+=taxable*rate;remaining-=taxable}
    if(remaining>0)tax+=remaining*.35;
    return roundMoney(tax);
  }
  function payeAmount(c:any,chargeableIncome:number,year:number,month:number){
    if(c.value_override!=null)return roundMoney(Number(c.value_override));
    if(year===2026&&month>=9)return ghanaMonthlyPaye2026(chargeableIncome);
    throw fail(400,'Automatic Ghana PAYE is configured for September 2026 onward. Enter a staff PAYE amount override before creating payroll for another period.');
  }
`;
payroll=replaceRequired(payroll,oldAmount,newAmount,'Ghana PAYE calculation helpers');

const oldCalculation="        let earnings=0,deductions=0;const calculated=assigned.map((c:any)=>{const amount=componentAmount(c,basic);if(c.component_type==='earning')earnings+=amount;else deductions+=amount;return{...c,amount};});\n        const gross=Math.round((basic+earnings)*100)/100,net=Math.max(0,Math.round((gross-deductions)*100)/100);grossTotal+=gross;deductionTotal+=deductions;netTotal+=net;";
const newCalculation=`        let earnings=0,deductions=0,taxableEarnings=0;
        const payeComponents=assigned.filter((c:any)=>String(c.code||'').toUpperCase()==='PAYE');
        const calculated=assigned.filter((c:any)=>String(c.code||'').toUpperCase()!=='PAYE').map((c:any)=>{
          const amount=componentAmount(c,basic);
          if(c.component_type==='earning'){earnings+=amount;if(c.taxable)taxableEarnings+=amount}else deductions+=amount;
          return{...c,amount};
        });
        const gross=roundMoney(basic+earnings);
        const employeeSsnit=calculated.filter((c:any)=>c.component_type==='deduction'&&String(c.code||'').toUpperCase()==='SSNIT').reduce((sum:number,c:any)=>sum+Number(c.amount||0),0);
        const chargeableIncome=roundMoney(Math.max(0,basic+taxableEarnings-employeeSsnit));
        for(const c of payeComponents){const amount=payeAmount(c,chargeableIncome,b.year,b.month);deductions+=amount;calculated.push({...c,amount})}
        const net=Math.max(0,roundMoney(gross-deductions));grossTotal+=gross;deductionTotal+=deductions;netTotal+=net;`;
payroll=replaceRequired(payroll,oldCalculation,newCalculation,'automatic PAYE payroll calculation');
await writeFile(payrollPath,payroll);

let server=await readFile(serverPath,'utf8');
if(!server.includes('directAcademicLockRoutes')){
  const marker='async function audit(organisationId:string,userId:string,action:string,resourceType:string,resourceId?:string|null,metadata:any={}){';
  const hardening=`const directAcademicLockRoutes:Array<{pattern:RegExp;sql:string}>=[
  {pattern:/^\\/api\\/academic-years\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT is_locked locked FROM academic_years WHERE id=$1'},
  {pattern:/^\\/api\\/terms\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM terms t JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=$1'},
  {pattern:/^\\/api\\/classes\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT COALESCE(y.is_locked,false) locked FROM classrooms c JOIN academic_years y ON y.id=c.academic_year_id WHERE c.id=$1'},
  {pattern:/^\\/api\\/assessments\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM assessments r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/homework\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM homework_assignments r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/lesson-notes\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM lesson_notes r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/timetable\\/breaks\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM timetable_breaks r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/timetable\\/unavailability\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM timetable_teacher_unavailability r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/timetable\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM timetable_entries r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/teacher-assignments\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT (COALESCE(t.is_locked,false) OR COALESCE(y.is_locked,false)) locked FROM teacher_assignments r JOIN academic_years y ON y.id=r.academic_year_id LEFT JOIN terms t ON t.id=r.term_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/class-subjects\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT COALESCE(y.is_locked,false) locked FROM class_subjects r JOIN academic_years y ON y.id=r.academic_year_id WHERE r.id=$1'},
  {pattern:/^\\/api\\/enrolments\\/([0-9a-f-]{36})(?:\\/|$)/i,sql:'SELECT COALESCE(y.is_locked,false) locked FROM enrolments r JOIN academic_years y ON y.id=r.academic_year_id WHERE r.id=$1'}
];
app.addHook('preHandler',async request=>{
  if(['GET','HEAD','OPTIONS'].includes(request.method))return;
  const path=String(request.url||'').split('?')[0]||'';
  if(!path.startsWith('/api/')||path.startsWith('/api/auth/')||path.startsWith('/api/academic-periods/')||path.startsWith('/api/promotions/')||path.startsWith('/api/security/'))return;
  for(const rule of directAcademicLockRoutes){
    const match=path.match(rule.pattern);if(!match)continue;
    const row=await maybeOne<any>(db,rule.sql,[match[1]]);
    if(row?.locked)throw fail(423,'This academic period is closed and read-only. A School Administrator must reopen it before records can be changed.');
    break;
  }
});

${marker}`;
  server=replaceRequired(server,marker,hardening,'direct academic lock enforcement');
}
await writeFile(serverPath,server);

console.log('Applied final Revolt-X School remediation audit hardening');
