import { readFile,writeFile } from 'node:fs/promises';

/**
 * Commercial-launch source normalisation.
 *
 * Revolt-X School predates the current production architecture and some historical releases are
 * represented by build-time source transforms. This script is intentionally the single launch
 * hardening layer for concerns that cross the very large legacy server/UI files. It does not
 * introduce alternative business flows. Instead it removes obsolete paths and normalises the
 * final generated source before TypeScript compilation.
 *
 * New standalone features belong in normal TypeScript modules (for example payroll-grade-routes
 * and commercial-observability-routes); only wiring and legacy-source replacement live here.
 */
const serverPath=new URL('../src/server.ts',import.meta.url);
const uiPath=new URL('../src/ui.ts',import.meta.url);
const loginPath=new URL('../src/login-ui.ts',import.meta.url);
const payrollPath=new URL('../src/hr-payroll-routes.ts',import.meta.url);

function insertAfter(source,marker,value,label){
  if(source.includes(value.trim()))return source;
  const i=source.indexOf(marker);if(i<0)throw new Error('Commercial launch cleanup could not find '+label);
  return source.slice(0,i+marker.length)+value+source.slice(i+marker.length);
}
function insertBefore(source,marker,value,label){
  if(source.includes(value.trim()))return source;
  const i=source.indexOf(marker);if(i<0)throw new Error('Commercial launch cleanup could not find '+label);
  return source.slice(0,i)+value+source.slice(i);
}
function replaceBetween(source,start,end,value,label){
  const a=source.indexOf(start),b=a<0?-1:source.indexOf(end,a+start.length);
  if(a<0||b<0)throw new Error('Commercial launch cleanup could not find '+label);
  return source.slice(0,a)+value+source.slice(b);
}
function replaceIfPresent(source,from,to){return source.includes(from)?source.replace(from,to):source}

// -----------------------------------------------------------------------------
// SCHOOL SERVER: canonical auth, finite licence cache, service observability wiring
// -----------------------------------------------------------------------------
let server=await readFile(serverPath,'utf8');
server=insertAfter(server,"import { registerSchoolRemediationRoutes } from './school-remediation-routes.js';",`
import { registerCommercialObservabilityRoutes } from './commercial-observability-routes.js';
import { registerPayrollGradeRoutes } from './payroll-grade-routes.js';`,'School commercial route imports');

server=insertBefore(server,'await registerAccountingRoutes(app,{',`await registerCommercialObservabilityRoutes(app,{db,requireCoreServiceRequest});
await registerPayrollGradeRoutes(app,{db,config,authorize,one,maybeOne,tx,fail,audit});

`,'School commercial route registration');

// Production School sessions have exactly three supported origins. Preview and Quick Login were
// historical conveniences and are intentionally absent from the runtime type contract.
server=server.replace(/source:'core_exchange'\|'preview'\|'quick_login'\|'staff_id'\|'admin_email'/g,"source:'core_exchange'|'staff_id'|'admin_email'");

const persistLicence=`async function persistLicence(organisationId:string,entitlement:any,source='core_os'){
  const e=normalizedLicence(entitlement),graceHours=Number(config.LICENSE_OUTAGE_GRACE_HOURS||72);
  await db.query(\`INSERT INTO school_license_state(
    organisation_id,license_code,product_key,plan_key,plan_name,status,billing_frequency,recurring_amount,currency,
    period_end,trial_ends_at,grace_ends_at,limits,modules,organisation_admin_email,synced_at,source,
    last_core_success_at,last_core_attempt_at,outage_grace_ends_at,last_core_error
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,now(),now(),now()+make_interval(hours=>$17),NULL)
  ON CONFLICT(organisation_id) DO UPDATE SET
    license_code=EXCLUDED.license_code,product_key=EXCLUDED.product_key,plan_key=EXCLUDED.plan_key,plan_name=EXCLUDED.plan_name,
    status=EXCLUDED.status,billing_frequency=EXCLUDED.billing_frequency,recurring_amount=EXCLUDED.recurring_amount,currency=EXCLUDED.currency,
    period_end=EXCLUDED.period_end,trial_ends_at=EXCLUDED.trial_ends_at,grace_ends_at=EXCLUDED.grace_ends_at,limits=EXCLUDED.limits,
    modules=EXCLUDED.modules,organisation_admin_email=EXCLUDED.organisation_admin_email,synced_at=now(),source=EXCLUDED.source,
    last_core_success_at=now(),last_core_attempt_at=now(),outage_grace_ends_at=EXCLUDED.outage_grace_ends_at,last_core_error=NULL\`,[
    organisationId,e.licenseCode,e.productKey,e.planKey,e.planName,e.status,e.billingFrequency,e.recurringAmount,e.currency,
    e.periodEnd,e.trialEndsAt,e.graceEndsAt,JSON.stringify(e.limits||{}),JSON.stringify(e.modules||[]),e.organisationAdminEmail||null,source,graceHours
  ]);
  return{...e,syncedAt:new Date().toISOString(),source,lastCoreSuccessAt:new Date().toISOString(),outageGraceEndsAt:new Date(Date.now()+graceHours*3600000).toISOString(),usingCachedLicence:false};
}

`;
server=replaceBetween(server,'async function persistLicence(','async function readLocalLicence(',persistLicence,'licence persistence');

const readLocal=`async function readLocalLicence(organisationId:string){
  const row=await maybeOne<any>(db,'SELECT * FROM school_license_state WHERE organisation_id=$1',[organisationId]);
  if(!row)return null;
  return{
    ...normalizedLicence({licenseCode:row.license_code,productKey:row.product_key,planKey:row.plan_key,planName:row.plan_name,status:row.status,
      billingFrequency:row.billing_frequency,recurringAmount:Number(row.recurring_amount||0),currency:row.currency,periodEnd:row.period_end,
      trialEndsAt:row.trial_ends_at,graceEndsAt:row.grace_ends_at,limits:row.limits||{},modules:Array.isArray(row.modules)?row.modules:[],organisationAdminEmail:row.organisation_admin_email}),
    syncedAt:row.synced_at,source:row.source,lastCoreSuccessAt:row.last_core_success_at||row.synced_at,
    lastCoreAttemptAt:row.last_core_attempt_at,outageGraceEndsAt:row.outage_grace_ends_at,lastCoreError:row.last_core_error||null
  };
}

`;
server=replaceBetween(server,'async function readLocalLicence(','async function fetchCoreLicence(',readLocal,'local licence reader');

const schoolLicence=`async function schoolLicence(organisationId:string,force=false){
  const local=await readLocalLicence(organisationId),ttlMs=Number(config.LICENSE_CACHE_TTL_SECONDS||300)*1000;
  const graceMs=Number(config.LICENSE_OUTAGE_GRACE_HOURS||72)*3600000;
  const age=local?.syncedAt?Date.now()-new Date(local.syncedAt).getTime():Number.POSITIVE_INFINITY;
  if(!force&&local&&age<ttlMs)return local;

  const remote=await fetchCoreLicence(organisationId);
  if(remote&&remote.status)return persistLicence(organisationId,remote,'core_os');

  // Core OS is unreachable. Record the attempt so Commercial Support can distinguish a stale
  // entitlement from a currently connected School. A cached licence is trusted only inside the
  // configured outage window measured from the last successful Core OS entitlement sync.
  await db.query('UPDATE school_license_state SET last_core_attempt_at=now(),last_core_error=$2 WHERE organisation_id=$1',[
    organisationId,'Core OS licence service unavailable'
  ]).catch(()=>null);
  if(local){
    const lastSuccess=local.lastCoreSuccessAt?new Date(local.lastCoreSuccessAt).getTime():0;
    const graceEndsAt=lastSuccess?new Date(lastSuccess+graceMs).toISOString():null;
    if(lastSuccess&&Date.now()<=lastSuccess+graceMs){
      return{...local,usingCachedLicence:true,outageGraceEndsAt:graceEndsAt,outageGraceHours:Number(config.LICENSE_OUTAGE_GRACE_HOURS||72),lastCoreError:'Core OS licence service unavailable'};
    }
    return{...local,status:'unlicensed',modules:[],usingCachedLicence:true,outageGraceExpired:true,outageGraceEndsAt:graceEndsAt,
      lastCoreError:'Core OS licence service unavailable and the cached entitlement grace period has expired'};
  }

  // Development/test can still create a workspace before a commercial subscription is attached.
  // Production fails closed: no Core entitlement means no implicit unlimited licence.
  if(config.NODE_ENV!=='production')return{
    licenseCode:null,productKey:'school',planKey:'legacy',planName:'Development Transition',status:'legacy',billingFrequency:null,
    recurringAmount:0,currency:'GHS',periodEnd:null,trialEndsAt:null,graceEndsAt:null,limits:{},modules:ALL_COMMERCIAL_MODULES,
    organisationAdminEmail:null,syncedAt:null,source:'development_transition'
  };
  return{licenseCode:null,productKey:'school',planKey:null,planName:null,status:'unlicensed',billingFrequency:null,recurringAmount:0,currency:'GHS',
    periodEnd:null,trialEndsAt:null,graceEndsAt:null,limits:{},modules:[],organisationAdminEmail:null,syncedAt:null,source:'no_core_entitlement',outageGraceExpired:true};
}

`;
server=replaceBetween(server,'async function schoolLicence(','async function resolveTenantSchool(',schoolLicence,'finite licence outage policy');

// Warn users while cached entitlement is being used, before the grace window expires.
server=replaceIfPresent(server,"  if(licence?.status==='legacy'){","  if(licence?.usingCachedLicence&&!licence?.outageGraceExpired){\n    warningLevel='warn';warningMessage='Core OS licence validation is temporarily unavailable. Cached access remains valid until '+new Date(licence.outageGraceEndsAt).toLocaleString()+'.';\n  }else if(licence?.status==='legacy'){");

// Delete obsolete alternate login aliases from the generated server. Historical migrations stay
// intact, but production HTTP entry points are now /login and /admin-login only.
server=server.replace(/^app\.get\('\/(?:headteacher-login|bursar-login|registrar-login|demo|main|quick-login)'[^\n]*\n/gm,'');

// Canonical public School URLs contain School name + immutable ID prefix. The `school` query is
// still accepted because it resolves the tenant without putting a database UUID into auth forms.
if(!server.includes("/school/:schoolKey/login")){
  server=insertBefore(server,"app.get('/parent',",`app.get('/school/:schoolKey/login',async(_r,p)=>p.type('text/html; charset=utf-8').send(loginFrontend));
app.get('/school/:schoolKey/admin-login',async(_r,p)=>p.type('text/html; charset=utf-8').send(adminLoginFrontend));
app.get('/school/:schoolKey/change-password',async(_r,p)=>p.type('text/html; charset=utf-8').send(passwordChangeFrontend));

`,'canonical School login URLs');
}

// This strictness correction used to live in a one-line standalone build script. Keeping it here
// removes that duplicate patch layer.
server=server.replace("const path=String(request.url||'').split('?')[0];","const path=String(request.url||'').split('?')[0]||'';");
await writeFile(serverPath,server);

// -----------------------------------------------------------------------------
// PAYROLL: grades + Finance review before any journal posting
// -----------------------------------------------------------------------------
let payroll=await readFile(payrollPath,'utf8');

// Load shared grade components beside personal staff components. Personal assignments win if the
// same component exists at both levels; this is how a loan/special adjustment can override a grade.
if(!payroll.includes('const gradeComponents=')){
  payroll=payroll.replace("    const result=await tx(db,async(client:any)=>{",`    const gradeComponents=(await db.query(\`SELECT gc.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory
      FROM payroll_grade_components gc JOIN payroll_components c ON c.id=gc.component_id
      WHERE gc.organisation_id=$1 AND gc.is_active=true AND c.is_active=true\`,[a.core.organisation_id])).rows;
    const grades=(await db.query('SELECT * FROM payroll_grades WHERE organisation_id=$1 AND is_active=true',[a.core.organisation_id])).rows;
    const result=await tx(db,async(client:any)=>{`);
}
payroll=payroll.replace(
  "const u=users.find((x:any)=>x.id===p.os_user_id)||{};const basic=Number(p.base_salary||0);const assigned=components.filter((x:any)=>x.os_user_id===p.os_user_id);",
  "const u=users.find((x:any)=>x.id===p.os_user_id)||{},grade=grades.find((g:any)=>g.id===p.payroll_grade_id);const basic=Number(grade&&p.use_grade_salary?grade.base_salary:p.base_salary||0);const personal=components.filter((x:any)=>x.os_user_id===p.os_user_id),personalIds=new Set(personal.map((x:any)=>x.component_id)),gradeAssigned=grade?gradeComponents.filter((x:any)=>x.payroll_grade_id===grade.id&&!personalIds.has(x.component_id)):[],assigned=[...gradeAssigned,...personal];"
);

const submitRoute=`  app.post('/api/payroll/runs/:id/submit',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const current=await one<any>(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!['draft','returned_to_hr'].includes(current.status))throw fail(409,'Only a draft or Finance-returned payroll can be submitted for review');
    // HR submission does not create a GL entry. Finance must review and approve first.
    const updated=await one<any>(db,\`UPDATE payroll_runs SET status='submitted_to_finance',submitted_by_os_user_id=$1,submitted_at=now(),
      finance_review_note=NULL,returned_by_os_user_id=NULL,returned_at=NULL,updated_at=now() WHERE id=$2 RETURNING *\`,[a.core.id,id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.submitted_to_finance','payroll_run',id,{net:updated.net_total});return updated;
  });

`;
payroll=replaceBetween(payroll,"  app.post('/api/payroll/runs/:id/submit'","  app.post('/api/payroll/runs/:id/approve'",submitRoute,'payroll Finance submission workflow');

const approveRoute=`  app.post('/api/payroll/runs/:id/approve',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.process');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const current=await one<any>(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(current.status!=='submitted_to_finance')throw fail(409,'Payroll must be submitted to Finance before approval');
    if(current.finance_journal_entry_id)throw fail(409,'This payroll already has a Finance journal entry');
    const updated=await tx(db,async(client:any)=>{
      const journal=await createJournal(client,a.core.organisation_id,a.core.id,\`Payroll ${'${current.period_year}'}-${'${String(current.period_month).padStart(2,\'0\')}'}\`,'payroll_accrual',id,[
        {code:'5000',debit:Number(current.gross_total),description:'Gross salaries and wages'},
        {code:'2050',credit:Number(current.net_total),description:'Net payroll payable'},
        ...(Number(current.deductions_total)>0?[{code:'2100',credit:Number(current.deductions_total),description:'Payroll deductions payable'}]:[])
      ]);
      return one<any>(client,\`UPDATE payroll_runs SET status='approved_for_payment',approved_by_os_user_id=$1,approved_at=now(),
        finance_journal_entry_id=$2,finance_review_note=NULL,updated_at=now() WHERE id=$3 RETURNING *\`,[a.core.id,journal.id,id]);
    });
    await audit(a.core.organisation_id,a.core.id,'payroll.finance_approved','payroll_run',id,{net:updated.net_total,journalEntryId:updated.finance_journal_entry_id});return updated;
  });

  app.post('/api/payroll/runs/:id/return',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.process');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({note:z.string().trim().min(3).max(2000)}).parse(request.body);
    const current=await one<any>(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(current.status!=='submitted_to_finance')throw fail(409,'Only payroll awaiting Finance review can be returned to HR');
    if(current.finance_journal_entry_id)throw fail(409,'A payroll with a posted Finance journal cannot be returned through this workflow');
    const row=await one<any>(db,\`UPDATE payroll_runs SET status='returned_to_hr',finance_review_note=$1,returned_by_os_user_id=$2,
      returned_at=now(),updated_at=now() WHERE id=$3 RETURNING *\`,[b.note,a.core.id,id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.returned_to_hr','payroll_run',id,{note:b.note});return row;
  });

`;
payroll=replaceBetween(payroll,"  app.post('/api/payroll/runs/:id/approve'","  app.post('/api/payroll/runs/:id/pay'",approveRoute,'payroll Finance approval/return workflow');
await writeFile(payrollPath,payroll);

// -----------------------------------------------------------------------------
// ADMIN UI: prevent missing-element crashes, enlarge forms, reset saved registers, payroll UX
// -----------------------------------------------------------------------------
let ui=await readFile(uiPath,'utf8');
if(!ui.includes('id="rx-commercial-launch-school-css"')){
  ui=ui.replace('</head>',`<style id="rx-commercial-launch-school-css">
.modal{padding:24px!important}.modalbox{width:min(860px,94vw)!important;max-height:88vh!important;padding:28px!important}.modalbox .two,.modalbox .three{gap:16px}.modalbox label{font-size:12px}.modalbox textarea{min-height:120px}.payroll-filter{display:grid;grid-template-columns:1fr 1fr auto auto;gap:10px;align-items:end;margin:12px 0}@media(max-width:760px){.modalbox{width:96vw!important;padding:20px!important}.payroll-filter{grid-template-columns:1fr 1fr}}
</style></head>`);
}

// A missing optional button must never abort page initialisation. We bind event handlers through a
// detached fallback element and log the missing ID for diagnostics. Data reads still use E(id), so
// this does not hide missing fields that are genuinely required by business logic.
if(!ui.includes('function bindElement(id)')){
  ui=ui.replace('function E(id){return document.getElementById(id)}',"function E(id){return document.getElementById(id)}\nfunction bindElement(id){var el=E(id);if(el)return el;console.warn('[Revolt-X School] Optional UI control not rendered:',id);var fallback=document.createElement('button');fallback.type='button';fallback.hidden=true;return fallback}");
}
ui=ui.replace(/E\('([^']+)'\)\.(onclick|oninput|onchange|onkeydown)=/g,"bindElement('$1').$2=");
ui=ui.replace(/E\("([^"]+)"\)\.(onclick|oninput|onchange|onkeydown)=/g,'bindElement("$1").$2=');

// Attendance is an inline register rather than a modal. After a successful save we reset the
// register instead of leaving the previous marks on screen where they could be submitted twice.
ui=ui.replace("toast('Attendance saved')","toast('Attendance saved');E('attSearch').value='';E('attPanel').innerHTML='<div class=\"success\">Attendance saved successfully. Choose Load register to continue.</div>'");

// Payroll actions and exports. HR submits for review; Finance can approve or return. No journal is
// posted at submission. Both the register and individual staff payslip have PDF/Excel outputs.
ui=ui.replace("(r.status==='draft'?'<button id=\"submitPayroll\" class=\"primary\">Submit to Finance</button>':'')", "(['draft','returned_to_hr'].includes(r.status)?'<button id=\"submitPayroll\" class=\"primary\">Submit to Finance Review</button>':'')");
ui=ui.replace("(r.status==='submitted_to_finance'?'<button id=\"approvePayroll\" class=\"primary\">Finance Approve</button>':'')", "(r.status==='submitted_to_finance'?'<button id=\"approvePayroll\" class=\"primary\">Finance Approve & Post Accrual</button><button id=\"returnPayroll\" class=\"ghost\">Return to HR</button>':'')");
ui=ui.replace("+(r.status==='approved_for_payment'?'<button id=\"payPayroll\" class=\"primary\">Post Salary Payment</button>':'')", "+(r.status==='approved_for_payment'?'<button id=\"payPayroll\" class=\"primary\">Post Salary Payment</button>':'')+'<button id=\"exportPayrollPdf\" class=\"ghost\">PDF</button><button id=\"exportPayrollExcel\" class=\"ghost\">Excel</button>'");
ui=ui.replace("if(E('approvePayroll'))E('approvePayroll').onclick=async function(){await raw('/api/payroll/runs/'+id+'/approve',{method:'POST',body:'{}'});close();page('payroll')};", "if(E('approvePayroll'))bindElement('approvePayroll').onclick=async function(){await raw('/api/payroll/runs/'+id+'/approve',{method:'POST',body:'{}'});close();page('payroll')};if(E('returnPayroll'))bindElement('returnPayroll').onclick=async function(){var note=prompt('Finance review note / reason for return:');if(!note||note.trim().length<3)return;await raw('/api/payroll/runs/'+id+'/return',{method:'POST',body:JSON.stringify({note:note.trim()})});close();page('payroll')};if(E('exportPayrollPdf'))bindElement('exportPayrollPdf').onclick=function(){window.open('/api/payroll/runs/'+id+'/export?format=pdf','_blank')};if(E('exportPayrollExcel'))bindElement('exportPayrollExcel').onclick=function(){window.open('/api/payroll/runs/'+id+'/export?format=excel','_blank')};");

// Staff payroll period selector and personal exports.
ui=ui.replace("if(mine){E('content').innerHTML='<div class=\"section\"><div><h1>My Payroll</h1>","if(mine){var periods=await raw('/api/payroll/me/periods');E('content').innerHTML='<div class=\"section\"><div><h1>My Payroll</h1>");
ui=ui.replace("</p></div></div><div class=\"panel\">'+table(myPayslips", "</p></div></div><div class=\"panel\"><div class=\"payroll-filter\"><div><label>Year</label><select id=\"myPayrollYear\">'+Array.from(new Set(periods.map(function(x){return x.period_year}))).map(function(y){return '<option>'+y+'</option>'}).join('')+'</select></div><div><label>Month</label><select id=\"myPayrollMonth\">'+Array.from({length:12},function(_,i){return '<option value=\"'+(i+1)+'\">'+new Date(2020,i,1).toLocaleString('en',{month:'long'})+'</option>'}).join('')+'</select></div><button id=\"myPayrollPdf\" class=\"ghost\">PDF</button><button id=\"myPayrollExcel\" class=\"ghost\">Excel</button></div>'+table(myPayslips");
ui=ui.replace("+'</div>';}","+'</div>';var latest=periods[0];if(latest){E('myPayrollYear').value=latest.period_year;E('myPayrollMonth').value=latest.period_month}function exportMine(format){var y=E('myPayrollYear').value,m=E('myPayrollMonth').value;if(!y||!m)return toast('Choose a payroll month and year',true);window.open('/api/payroll/me/export?year='+encodeURIComponent(y)+'&month='+encodeURIComponent(m)+'&format='+format,'_blank')}if(E('myPayrollPdf'))bindElement('myPayrollPdf').onclick=function(){exportMine('pdf')};if(E('myPayrollExcel'))bindElement('myPayrollExcel').onclick=function(){exportMine('excel')}}");

// HR grade management: load grades with staff/components and expose a focused modal. Grade-level
// salary/components are shared; the existing staff component form remains for personal exceptions.
ui=ui.replace("var rr=await Promise.all([raw('/api/hr/staff'),raw('/api/payroll/components')]),staff=rr[0],components=rr[1];","var rr=await Promise.all([raw('/api/hr/staff'),raw('/api/payroll/components'),raw('/api/payroll/grades')]),staff=rr[0],components=rr[1],payrollGrades=rr[2];");
ui=ui.replace("<button id=\"newPayrollComponent\" class=\"primary\">Add earning / deduction</button>","<div class=\"actions\"><button id=\"managePayrollGrades\" class=\"ghost\">Payroll Grades</button><button id=\"newPayrollComponent\" class=\"primary\">Add earning / deduction</button></div>");
ui=ui.replace("E('newPayrollComponent').onclick=function(){",`bindElement('managePayrollGrades').onclick=function(){modal('<h2>Payroll Grades</h2><p class="muted">A grade applies one salary package to every assigned staff member. Loans and other personal items remain on the staff record.</p><div>'+table(payrollGrades,[{key:'code'},{key:'name'},{key:'base_salary',label:'Basic Salary',render:function(g){return docMoney(g.base_salary,g.currency)}},{key:'components',label:'Shared Components',render:function(g){return esc((g.components||[]).length)}}])+'</div><button id="createPayrollGrade" class="primary" style="width:100%;margin-top:12px">Create grade</button>');bindElement('createPayrollGrade').onclick=function(){form('Create Payroll Grade',[{key:'code',label:'Grade code'},{key:'name',label:'Grade name'},{key:'baseSalary',label:'Basic salary',type:'number'},{key:'description',label:'Description',type:'textarea',required:false}],{baseSalary:'0'},function(v){return raw('/api/payroll/grades',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,baseSalary:Number(v.baseSalary||0),description:v.description||null,currency:'GHS'})})})}};
   bindElement('newPayrollComponent').onclick=function(){`);

// Add grade choice to the staff emolument modal and save it separately from personal exceptions.
ui=ui.replace("<label>Basic salary <span class=\"req\">*</span></label><input id=\"hrBasic\"", "<label>Payroll grade</label><select id=\"hrGrade\"><option value=\"\">No grade / individual salary</option>'+payrollGrades.filter(function(g){return g.is_active}).map(function(g){return '<option value=\"'+g.id+'\"'+(p.payroll_grade_id===g.id?' selected':'')+'>'+esc(g.code+' - '+g.name)+' ('+docMoney(g.base_salary,g.currency)+')</option>'}).join('')+'</select><label style=\"display:flex;gap:8px;align-items:center\"><input id=\"hrUseGradeSalary\" type=\"checkbox\" style=\"width:auto\"'+(p.use_grade_salary!==false?' checked':'')+'> Use the grade basic salary</label><label>Individual basic salary / override <span class=\"req\">*</span></label><input id=\"hrBasic\"");
ui=ui.replace("await raw('/api/hr/staff/'+id+'/emolument", "await raw('/api/hr/staff/'+id+'/payroll-grade',{method:'PUT',body:JSON.stringify({payrollGradeId:E('hrGrade').value||null,useGradeSalary:E('hrUseGradeSalary').checked})});await raw('/api/hr/staff/'+id+'/emolument");

await writeFile(uiPath,ui);

// -----------------------------------------------------------------------------
// LOGIN UI: password visibility for Staff, Admin and first-password-change screens
// -----------------------------------------------------------------------------
let login=await readFile(loginPath,'utf8');
if(!login.includes('function enablePasswordVisibility()')){
  login=login.replace(/function E\(id\)\{return document\.getElementById\(id\)\}/g,`function E(id){return document.getElementById(id)}
  function enablePasswordVisibility(){document.querySelectorAll('input[type="password"]').forEach(function(input){if(input.dataset.visibilityReady)return;input.dataset.visibilityReady='1';var label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.style.width='auto';check.style.margin='0 7px 0 0';label.style.margin='8px 0 0';label.style.fontWeight='600';label.style.display='flex';label.style.alignItems='center';label.appendChild(check);label.appendChild(document.createTextNode('Show password'));input.insertAdjacentElement('afterend',label);check.onchange=function(){input.type=check.checked?'text':'password'}})}
  enablePasswordVisibility();`);
}
await writeFile(loginPath,login);
console.log('Applied Revolt-X School commercial-launch cleanup');
