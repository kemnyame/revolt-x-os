import { readFile, writeFile } from 'node:fs/promises';

const serverPath=new URL('../src/server.ts',import.meta.url);
const uiPath=new URL('../src/ui.ts',import.meta.url);
const loginPath=new URL('../src/login-ui.ts',import.meta.url);

function insertOnce(source,needle,replacement,label){
  if(source.includes(replacement))return source;
  if(!source.includes(needle))throw new Error('Remediation patch could not find '+label);
  return source.replace(needle,replacement);
}

let server=await readFile(serverPath,'utf8');
server=insertOnce(server,"import { registerAccountingRoutes } from './accounting-routes.js';",`import { registerAccountingRoutes } from './accounting-routes.js';
import { registerHrPayrollRoutes } from './hr-payroll-routes.js';
import { registerSchoolRemediationRoutes } from './school-remediation-routes.js';`,'route imports');

server=server.replace(/async function createSchoolStaffSession\(coreContext:any,source:[\s\S]*?\n}\n\nasync function activeYear/,`async function createSchoolStaffSession(coreContext:any,source:'core_exchange'|'preview'|'quick_login'|'staff_id'|'admin_email'='core_exchange'){
  const localToken='rxs_'+randomBytes(48).toString('base64url');
  const tokenHash=createHash('sha256').update(localToken).digest('hex');
  const security=await maybeOne<any>(db,'SELECT absolute_timeout_minutes FROM school_security_settings WHERE organisation_id=$1',[coreContext.organisation_id]);
  const absoluteMinutes=Math.min(1440,Math.max(30,Number(security?.absolute_timeout_minutes||480)));
  const expiresAt=new Date(Date.now()+absoluteMinutes*60*1000);
  await db.query(\`INSERT INTO school_sessions(
      token_hash,organisation_id,os_user_id,core_context,source,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6)\`,[
      tokenHash,coreContext.organisation_id,coreContext.id,JSON.stringify(coreContext),source,expiresAt.toISOString()
    ]);
  return{localToken,expiresAt};
}

async function activeYear`);

server=server.replaceAll('SameSite=Lax','SameSite=Strict');

const hookNeedle="const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});";
const hookBlock=`const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});

// Cookie-authenticated unsafe requests must originate from this School host. This protects
// state-changing routes against cross-site request forgery while still allowing trusted
// server-to-server requests that do not send a browser Origin header.
app.addHook('preHandler',async request=>{
  if(['GET','HEAD','OPTIONS'].includes(request.method))return;
  const cookie=String(request.headers.cookie||'');
  const origin=String(request.headers.origin||'');
  if(cookie.includes('rx_school_session=')&&origin){
    let originHost='';try{originHost=new URL(origin).host}catch{}
    if(originHost&&originHost!==String(request.headers.host||''))throw fail(403,'Security validation failed for this request. Refresh the School page and try again.');
  }

  const path=String(request.url||'').split('?')[0];
  if(!path.startsWith('/api/')||path.startsWith('/api/auth/')||path.startsWith('/api/academic-periods/')||path.startsWith('/api/promotions/')||path.startsWith('/api/security/'))return;
  const body:any=request.body&&typeof request.body==='object'?request.body:{};
  const query:any=request.query&&typeof request.query==='object'?request.query:{};
  const termId=body.termId||query.termId||null;
  const yearId=body.academicYearId||query.academicYearId||null;
  const classId=body.classroomId||query.classroomId||null;
  if(termId){
    const locked=await maybeOne<any>(db,'SELECT is_locked,name FROM terms WHERE id=$1',[termId]);
    if(locked?.is_locked)throw fail(423,locked.name+' is closed and read-only. A School Administrator must reopen it before records can be changed.');
  }
  if(yearId){
    const locked=await maybeOne<any>(db,'SELECT is_locked,name FROM academic_years WHERE id=$1',[yearId]);
    if(locked?.is_locked)throw fail(423,locked.name+' is closed and read-only. A School Administrator must reopen it before records can be changed.');
  }
  if(classId&&!termId&&!yearId){
    const locked=await maybeOne<any>(db,'SELECT y.is_locked,y.name FROM classrooms c JOIN academic_years y ON y.id=c.academic_year_id WHERE c.id=$1',[classId]);
    if(locked?.is_locked)throw fail(423,locked.name+' is closed and read-only. A School Administrator must reopen it before records can be changed.');
  }
});`;
server=insertOnce(server,hookNeedle,hookBlock,'security and period lock hook');

const registerNeedle=`await registerAccountingRoutes(app,{
  db,config,authorize,one,maybeOne,tx,fail,audit,postFinanceJournal,updateStudentFeeStatus,postStudentPaymentLedger,postStudentFeeReceivable,reverseFinanceJournal,notifyContact
});`;
const registerBlock=`await registerHrPayrollRoutes(app,{db,config,authorize,one,maybeOne,tx,fail,audit,fetchCoreUsers});
await registerSchoolRemediationRoutes(app,{db,config,authorize,one,maybeOne,tx,fail,audit,assignMandatoryFees});

await registerAccountingRoutes(app,{
  db,config,authorize,one,maybeOne,tx,fail,audit,postFinanceJournal,updateStudentFeeStatus,postStudentPaymentLedger,postStudentFeeReceivable,reverseFinanceJournal,notifyContact
});`;
server=insertOnce(server,registerNeedle,registerBlock,'remediation route registration');

server=server.replace("  if(error.code==='23503')status=409;","  if(error.code==='23503')status=409;\n  if(error.code==='23514')status=400;\n  if(error.code==='22P02')status=400;");
server=server.replace(":error.code==='42P08'\n        ?'The database could not safely process this action. The error has been logged for review.'",`:error.code==='23514'\n      ?'One or more values do not meet the allowed rules for this record'\n      :error.code==='22P02'\n        ?'One or more values are in the wrong format. Check dates, numbers and selected records.'\n        :error.code==='42P08'\n        ?'The database could not safely process this action. The error has been logged for review.'`);

const promotionMarker=`    await client.query(\`UPDATE promotion_batches SET promoted_count=$1,repeated_count=$2,completed_count=$3 WHERE id=$4\`,
      [promoted,repeated,completed,batch.id]);
    await audit(a.core.organisation_id,a.core.id,'students.promoted','promotion_batch',batch.id,{processed,promoted,repeated,completed});`;
if(server.includes(promotionMarker)){
  server=server.replace(promotionMarker,`    await client.query(\`UPDATE promotion_batches SET promoted_count=$1,repeated_count=$2,completed_count=$3 WHERE id=$4\`,
      [promoted,repeated,completed,batch.id]);
    // Rollover completion closes the source year. Academic records remain readable but are
    // protected from edits until a School Administrator explicitly reopens the period.
    await client.query(\`UPDATE academic_years SET status='closed',is_locked=true,locked_at=now(),locked_by_os_user_id=$1 WHERE id=$2 AND organisation_id=$3\`,[a.core.id,b.fromAcademicYearId,a.core.organisation_id]);
    await client.query(\`UPDATE terms SET status='closed',is_locked=true,locked_at=now(),locked_by_os_user_id=$1 WHERE academic_year_id=$2 AND organisation_id=$3\`,[a.core.id,b.fromAcademicYearId,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'students.promoted','promotion_batch',batch.id,{processed,promoted,repeated,completed});`);
}

await writeFile(serverPath,server);

let login=await readFile(loginPath,'utf8');
login=login.replaceAll('SameSite=Lax','SameSite=Strict');
login=login.replace(/<label>Staff ID<\/label>/g,'<label>Staff ID <span class="req">*</span></label>');
login=login.replace(/<label>Password<\/label>/g,'<label>Password <span class="req">*</span></label>');
login=login.replace('</style>',`.req{color:#b42318;font-weight:800}.field-error{font-size:12px;color:#b42318;margin-top:5px}input:invalid:not(:placeholder-shown),select:invalid{border-color:#b42318;box-shadow:0 0 0 3px rgba(180,35,24,.08)}</style>`);
await writeFile(loginPath,login);

let ui=await readFile(uiPath,'utf8');
const extraCss=`<style id="rx-remediation-css">
.req{color:#b42318;font-weight:900}.modal{padding:24px}.modalbox{width:min(640px,92vw)!important;max-height:84vh!important;margin:auto;border-radius:18px}.modalbox input,.modalbox select,.modalbox textarea{max-width:100%}select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#60727d 50%),linear-gradient(135deg,#60727d 50%,transparent 50%);background-position:calc(100% - 16px) 50%,calc(100% - 11px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:34px!important}.badge.success{background:#e8f7ef;color:#12643c}.badge.pending{background:#fff3d6;color:#805600}.badge.closed{background:#edf0f3;color:#53606a}.badge.submitted{background:#e8f1ff;color:#24599a}.badge.danger{background:#fdebec;color:#9c2630}.attendance-summary{display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));gap:8px;margin:12px 0}.attendance-summary>div{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--panel)}.attendance-summary b{display:block;font-size:20px}.attendance-row{grid-template-columns:minmax(180px,1fr) repeat(4,88px)!important;gap:8px!important}.attendance-row [data-status="present"].sel{background:#16794e!important;color:#fff}.attendance-row [data-status="absent"].sel{background:#b42318!important;color:#fff}.attendance-row [data-status="late"].sel{background:#ad6800!important;color:#fff}.attendance-row [data-status="excused"].sel{background:#3465a4!important;color:#fff}.rx-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 0}.rx-pagination button{min-width:70px}.lesson-note-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.lesson-note-card{border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--panel)}.lesson-note-card h3{margin:0 0 6px}.report-card{background:#fff;color:#172027;padding:18px}.report-school-head{display:grid;grid-template-columns:72px 1fr auto;gap:14px;align-items:center;border-bottom:3px solid #14715f;padding-bottom:12px}.report-logo{width:64px;height:64px;object-fit:contain}.report-term{text-align:right;display:grid;gap:3px}.report-document-title{text-align:center;padding:12px 0}.report-document-title strong{display:block;font-size:20px}.report-student-grid,.report-summary,.report-comments,.report-signatures{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0}.report-student-grid>div,.report-summary>div,.report-comments>div,.report-signatures>div{border:1px solid #dfe8ea;border-radius:8px;padding:8px}.report-student-grid span,.report-summary span,.report-signatures span{display:block;font-size:10px;text-transform:uppercase;color:#667780}.report-table{width:100%;border-collapse:collapse}.report-table th,.report-table td{border:1px solid #dfe8ea;padding:6px;font-size:11px}.report-table th{background:#eef7f4}.report-attendance{display:flex;gap:8px;flex-wrap:wrap}.report-attendance span{border:1px solid #dfe8ea;border-radius:8px;padding:7px}.timetable-week{display:grid;grid-template-columns:repeat(5,minmax(160px,1fr));gap:8px}.timetable-day{border:1px solid #dfe8ea;border-radius:10px;padding:8px}.timetable-card,.timetable-block{border:1px solid #dfe8ea;border-radius:8px;padding:8px;margin:6px 0}.payroll-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.payroll-item{border:1px solid var(--line);border-radius:12px;padding:12px}.period-locked{opacity:.78}.period-locked:after{content:'LOCKED';font-size:10px;font-weight:800;margin-left:6px;color:#9c2630}@media(max-width:900px){.lesson-note-grid,.payroll-grid,.report-student-grid,.report-summary,.report-comments,.report-signatures{grid-template-columns:1fr}.attendance-row{grid-template-columns:1fr 1fr 1fr!important}.timetable-week{grid-template-columns:1fr}.modal{padding:10px}.modalbox{width:min(620px,96vw)!important;max-height:90vh!important}}@media print{body{background:#fff!important}.side,.top,.actions,.no-print{display:none!important}.main{margin:0!important}.report-card{padding:4mm!important}.report-school-head{grid-template-columns:60px 1fr auto}.report-table th,.report-table td{padding:4px!important;font-size:10px!important}.report-footer{font-size:9px}.timetable-week{grid-template-columns:repeat(5,1fr)!important;gap:4px}.timetable-day{font-size:9px}}
</style>`;
if(!ui.includes('id="rx-remediation-css"'))ui=ui.replace('</head>',extraCss+'</head>');

// Shared form validation: required fields are visually marked and browser validation is
// applied consistently to every modal that uses the common form helper.
ui=ui.replace(/function field\(f,v\)\{[\s\S]*?function confirmDo\(message,action\)\{/,`function isRequiredField(f){if(f.required===false||f.optional===true)return false;var l=String(f.label||'').toLowerCase();return !/(optional|note|remark|comment|address|motto|short name|middle name|room|reference|interest|reason)/.test(l)}
function field(f,v){v=v==null?'':v;var req=isRequiredField(f),mark=req?' <span class="req">*</span>':'',attr=req?' required':'';if(f.type==='select')return'<label>'+esc(f.label)+mark+'</label><select data-f="'+f.key+'"'+attr+'>'+(f.options||[]).map(function(o){var value=typeof o==='string'?o:o.value,label=typeof o==='string'?o:o.label;return'<option value="'+esc(value)+'"'+(String(value)===String(v)?' selected':'')+'>'+esc(label)+'</option>'}).join('')+'</select>';if(f.type==='textarea')return'<label>'+esc(f.label)+mark+'</label><textarea rows="'+(f.rows||4)+'" data-f="'+f.key+'"'+attr+'>'+esc(v)+'</textarea>';return'<label>'+esc(f.label)+mark+'</label><input type="'+(f.type||'text')+'" data-f="'+f.key+'" value="'+esc(v)+'"'+attr+'>'}
function form(title,fields,vals,save){vals=vals||{};modal('<h2 style="margin-bottom:15px">'+esc(title)+'</h2><p class="muted"><span class="req">*</span> Required fields</p>'+fields.map(function(f){return field(f,vals[f.key])}).join('')+'<button id="saveModal" class="primary" style="width:100%;margin:8px 0 12px">Save</button>');E('saveModal').onclick=async function(){var v={},btn=E('saveModal'),elements=Array.from(E('modalBody').querySelectorAll('[data-f]')),invalid=elements.find(function(x){return !x.checkValidity()});if(invalid){invalid.reportValidity();var def=fields.find(function(f){return f.key===invalid.dataset.f});return toast((def&&def.label?def.label:'This field')+' is required or invalid',true)}elements.forEach(function(x){v[x.dataset.f]=x.value});try{btn.disabled=true;btn.textContent='Saving...';await save(v);btn.textContent='Saved';close();await page(current);successDialog('Record saved',title+' was saved successfully.')}catch(e){btn.disabled=false;btn.textContent='Save';toast(e&&e.message?e.message:'The record could not be saved',true)}}}
function confirmDo(message,action){`);

// Auto-pagination is applied to every long data table without changing individual workflows.
const paginationHelper=`
function enhancePagination(root){
  root=root||E('content');if(!root)return;
  root.querySelectorAll('.table').forEach(function(wrap){if(wrap.dataset.rxPaged==='1')return;var body=wrap.querySelector('tbody');if(!body)return;var rows=Array.from(body.children),size=25;if(rows.length<=size)return;wrap.dataset.rxPaged='1';var pageNo=1,total=Math.ceil(rows.length/size),bar=document.createElement('div');bar.className='rx-pagination';bar.innerHTML='<button class="mini" data-prev>Previous</button><span></span><button class="mini" data-next>Next</button>';wrap.after(bar);function draw(){rows.forEach(function(r,i){r.style.display=(i>=(pageNo-1)*size&&i<pageNo*size)?'':'none'});bar.querySelector('span').textContent='Page '+pageNo+' of '+total+' • '+rows.length+' records';bar.querySelector('[data-prev]').disabled=pageNo<=1;bar.querySelector('[data-next]').disabled=pageNo>=total}bar.querySelector('[data-prev]').onclick=function(){if(pageNo>1){pageNo--;draw()}};bar.querySelector('[data-next]').onclick=function(){if(pageNo<total){pageNo++;draw()}};draw()})
}
`;
if(!ui.includes('function enhancePagination(root)'))ui=ui.replace('var searchTimer=null;',paginationHelper+'\nvar searchTimer=null;');
ui=ui.replace("  E('loading').classList.add('hide');E('app').classList.remove('hide');","  E('loading').classList.add('hide');E('app').classList.remove('hide');var contentRoot=E('content');if(contentRoot){new MutationObserver(function(){enhancePagination(contentRoot)}).observe(contentRoot,{childList:true,subtree:true})}");

// Guard critical boot bindings so a design variation cannot crash the whole dashboard when
// a top-bar element is intentionally hidden or unavailable.
ui=ui.replace("  E('licenceButton').onclick=function(){page('licence')};","  var licenceButton=E('licenceButton');if(licenceButton)licenceButton.onclick=function(){page('licence')};");
ui=ui.replace("  E('refresh').onclick=function(){page(current)};\n  E('myProfile').onclick=openMyProfile;\n  E('signOut').onclick=async function(){","  var refreshButton=E('refresh');if(refreshButton)refreshButton.onclick=function(){page(current)};\n  var profileButton=E('myProfile');if(profileButton)profileButton.onclick=openMyProfile;\n  var signOutButton=E('signOut');if(signOutButton)signOutButton.onclick=async function(){");
ui=ui.replace("location.replace('/login')};\n  setupGlobalSearch();","location.replace('/login')};\n  setupGlobalSearch();");

// Semantic status classes remain compatible with existing badge styles but provide distinct
// colours for successful, submitted, pending, closed and failed states.
ui=ui.replace("return '<span class=\"badge'+c+'\">'+icon+esc((s||'—').replace(/_/g,' '))+'</span>'","if(/published|approved|graded|paid|active|present|success|taught|enrolled|complete|released/.test(n))c=' success';else if(/submitted|under_review|processing|in_progress/.test(n))c=' submitted';else if(/pending|requested|waitlisted|draft|planned|late|part_paid|unmarked|returned|overdue/.test(n))c=' pending';else if(/closed|archived|inactive|cancelled|not_submitted/.test(n))c=' closed';else if(/declined|absent|withdrawn|suspended|unpaid|failed|voided|server_error/.test(n))c=' danger';return '<span class=\"badge'+c+'\">'+icon+esc((s||'—').replace(/_/g,' '))+'</span>'");

// Student financial statements are intentionally transaction-only: no fee summary cards or
// guardian profile blocks are printed into the statement.
ui=ui.replace(/function studentStatementDocument\(st\)\{[\s\S]*?\n}\nfunction schoolLogoHtml/,`function studentStatementDocument(st){
  var currency=st.school.currency||'GHS';
  var rows=(st.rows||[]).map(function(r){return'<tr><td>'+esc(String(r.occurred_at).slice(0,10))+'</td><td>'+esc(String(r.kind||'').replace(/_/g,' '))+'</td><td>'+esc(r.description||'')+(r.reference?'<br><small>'+esc(r.reference)+'</small>':'')+'</td><td>'+esc(r.gl_code||'')+'</td><td class="amount">'+(Number(r.debit)?docMoney(r.debit,currency):'')+'</td><td class="amount">'+(Number(r.credit)?docMoney(r.credit,currency):'')+'</td><td class="amount">'+docMoney(r.running_balance,currency)+'</td></tr>'}).join('');
  return '<div class="doc-head">'+schoolLogoHtml(st.school)+'<div><h1 style="margin:0">'+esc(st.school.school_name)+'</h1><div class="muted">'+esc(st.school.motto||'')+'</div><div class="muted">'+esc([st.school.address,st.school.phone,st.school.email].filter(Boolean).join(' • '))+'</div></div></div><h2>Student Transaction Statement</h2><div class="box"><b>'+esc(st.student.first_name+' '+(st.student.middle_name||'')+' '+st.student.last_name)+'</b><br><span class="muted">Student ID: '+esc(st.student.admission_no)+' • Class: '+esc(st.student.classroom_name||'—')+'</span></div><table><thead><tr><th>Date</th><th>Type</th><th>Description / Reference</th><th>GL</th><th>Charge</th><th>Payment</th><th>Balance</th></tr></thead><tbody>'+rows+'</tbody></table>'
}
function schoolLogoHtml`);
ui=ui.replace(/'<div class=\"grid\"><div class=\"panel stat\"><span class=\"muted\">Charges<\/span>[\s\S]*?<\/div><\/div>'\+\n       table\(st\.rows,/,"'<div class=\"notice\"><b>Transaction-only statement.</b> This view shows posted charges, payments, references and the running balance only.</div>'+\n       table(st.rows,");

// Improved attendance workspace with search, status counters and clearer controls.
const attStart=ui.indexOf("else if(p==='attendance'){");
const attEnd=ui.indexOf(" else if(p==='assessments'){",attStart);
if(attStart>=0&&attEnd>attStart){
  ui=ui.slice(0,attStart)+`else if(p==='attendance'){
   var classes=await raw('/api/classes');
   E('content').innerHTML='<div class="section"><div><h1>Attendance</h1><p class="muted">A faster daily register with live totals, search and colour-coded attendance states.</p></div></div><div class="panel"><div class="three"><div><label>Class <span class="req">*</span></label><select id="attClass">'+classes.map(function(c){return'<option value="'+c.id+'">'+esc(c.name)+'</option>'}).join('')+'</select></div><div><label>Date <span class="req">*</span></label><input id="attDate" type="date" value="'+new Date().toISOString().slice(0,10)+'" required></div><div><label>Find student</label><input id="attSearch" placeholder="Name or Student ID"></div></div><button id="loadAtt" class="primary">Load register</button></div><div id="attPanel" class="panel"><div class="empty">Choose a class and date.</div></div>';
   E('loadAtt').onclick=async function(){
     var cid=E('attClass').value,date=E('attDate').value;if(!cid||!date)return toast('Choose a class and attendance date',true);var rows=await raw('/api/attendance?classroomId='+cid+'&date='+date);
     function counts(){var c={present:0,absent:0,late:0,excused:0,unmarked:0};E('attPanel').querySelectorAll('[data-student]').forEach(function(row){var s=row.querySelector('.sel');c[s?s.dataset.status:'unmarked']++});Object.keys(c).forEach(function(k){var x=E('attCount'+k);if(x)x.textContent=c[k]})}
     function draw(){var q=(E('attSearch').value||'').trim().toLowerCase(),filtered=q?rows.filter(function(r){return (r.first_name+' '+r.last_name+' '+r.admission_no).toLowerCase().includes(q)}):rows;E('attPanel').innerHTML=rows.length?'<div class="attendance-summary"><div><span class="muted">Present</span><b id="attCountpresent">0</b></div><div><span class="muted">Absent</span><b id="attCountabsent">0</b></div><div><span class="muted">Late</span><b id="attCountlate">0</b></div><div><span class="muted">Excused</span><b id="attCountexcused">0</b></div><div><span class="muted">Unmarked</span><b id="attCountunmarked">0</b></div></div><div class="actions" style="margin-bottom:10px"><button id="allPresent" class="ghost">Mark all present</button><button id="clearAtt" class="danger">Clear this date</button></div>'+filtered.map(function(r){return'<div class="attendance-row" data-student="'+r.student_id+'"><div class="student"><b>'+esc(r.first_name+' '+r.last_name)+'</b><div class="muted">'+esc(r.admission_no)+'</div></div>'+['present','absent','late','excused'].map(function(s){return'<button class="mini '+(r.attendance_status===s?'sel':'')+'" data-status="'+s+'">'+s.charAt(0).toUpperCase()+s.slice(1)+'</button>'}).join('')+'</div>'}).join('')+'<button id="saveAtt" class="primary" style="margin-top:12px">Save attendance</button>':'<div class="empty">No students enrolled in this class.</div>';counts();E('attPanel').onclick=function(e){var b=e.target.closest('[data-status]');if(b){var row=b.closest('[data-student]');row.querySelectorAll('[data-status]').forEach(function(x){x.classList.remove('sel')});b.classList.add('sel');counts()}};var all=E('allPresent');if(all)all.onclick=function(){E('attPanel').querySelectorAll('[data-student]').forEach(function(row){row.querySelectorAll('[data-status]').forEach(function(x){x.classList.toggle('sel',x.dataset.status==='present')})});counts()};var clearBtn=E('clearAtt');if(clearBtn)clearBtn.onclick=function(){confirmDo('Clear all attendance records for this class and date?',function(){return raw('/api/attendance?classroomId='+cid+'&date='+date,{method:'DELETE'})})};var save=E('saveAtt');if(save)save.onclick=async function(){var records=[];E('attPanel').querySelectorAll('[data-student]').forEach(function(row){var s=row.querySelector('.sel');if(s)records.push({studentId:row.dataset.student,status:s.dataset.status})});if(records.length!==rows.length&&!confirm((rows.length-records.length)+' student(s) are still unmarked. Save the marked records only?'))return;if(!records.length)return toast('Mark at least one student',true);await raw('/api/attendance/mark',{method:'POST',body:JSON.stringify({classroomId:cid,date:date,records:records})});toast('Attendance saved')}}
     draw();E('attSearch').oninput=draw
   }
 }
`+ui.slice(attEnd);
}

// Timetable exports: create a genuine spreadsheet-readable .xls file in-browser and send only
// the timetable view to Print/PDF rather than printing the entire administration shell.
ui=ui.replace("<button id=\"exportTimetable\" class=\"ghost\">Export CSV</button>","<button id=\"exportTimetable\" class=\"ghost\">Export Excel</button>");
ui=ui.replace(/E\('exportTimetable'\)\.onclick=async function\(\)\{[\s\S]*?URL\.revokeObjectURL\(u\)\};\n   E\('printTimetable'\)\.onclick=function\(\)\{window\.print\(\)\};/,`E('exportTimetable').onclick=function(){var rows=tt||[],days=['','Monday','Tuesday','Wednesday','Thursday','Friday'],html='<table><thead><tr><th>Day</th><th>Start</th><th>End</th><th>Class</th><th>Subject</th><th>Teacher</th><th>Room</th></tr></thead><tbody>'+rows.map(function(r){return'<tr><td>'+esc(days[Number(r.day_of_week)]||r.day_of_week)+'</td><td>'+esc(String(r.start_time).slice(0,5))+'</td><td>'+esc(String(r.end_time).slice(0,5))+'</td><td>'+esc(r.classroom_name)+'</td><td>'+esc(r.subject_name)+'</td><td>'+esc(teacherName(r.teacher_os_user_id))+'</td><td>'+esc(r.room||'')+'</td></tr>'}).join('')+'</tbody></table>',blob=new Blob(['<html><head><meta charset="utf-8"></head><body>'+html+'</body></html>'],{type:'application/vnd.ms-excel'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='revolt-x-school-timetable.xls';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},1000);toast('Timetable Excel export created')};
   E('printTimetable').onclick=function(){var y=years.find(function(x){return x.id===E('ttYear').value}),t=terms.find(function(x){return x.id===E('ttTerm').value});printStandalone('School Timetable','<h2>Timetable</h2><p class="muted">'+esc(y?y.name:'')+(t?' • '+esc(t.name):'')+'</p>'+E('ttView').innerHTML)};`);

// Report cards print through the standalone print document so saved PDFs contain only the
// official report and use controlled A4-friendly styles.
ui=ui.replace("E('printReport').onclick=function(){window.print()};","E('printReport').onclick=function(){var node=E('printableReport');if(!node)return toast('Generate the report before printing',true);printStandalone('Student Report Card',node.outerHTML)};");

// Lesson-note review is condensed into cards and the attachment list remains directly usable.
const lessonStart=ui.indexOf("     var html='<h2>'+esc(n.title)");
const lessonEnd=ui.indexOf("     if(e.target.dataset.reviewNote)html+=",lessonStart);
if(lessonStart>=0&&lessonEnd>lessonStart){
  const lesson=`     var html='<div class="section compact"><div><h2>'+esc(n.title)+'</h2><p class="muted">'+esc(n.classroom_name)+' • '+esc(n.subject_name)+' • '+esc(teacherName(n.teacher_os_user_id))+'</p></div>'+badge(n.status)+'</div><div class="info-grid"><div><span>Week</span><b>'+esc(n.week_no||'—')+'</b></div><div><span>Lesson date</span><b>'+esc(n.lesson_date?String(n.lesson_date).slice(0,10):'—')+'</b></div><div><span>Strand</span><b>'+esc(n.strand||'—')+'</b></div><div><span>Sub-strand</span><b>'+esc(n.sub_strand||'—')+'</b></div></div><div class="lesson-note-grid"><div class="lesson-note-card"><h3>Learning objectives</h3><p>'+esc(n.learning_objectives||'—')+'</p></div><div class="lesson-note-card"><h3>Teaching & learning resources</h3><p>'+esc(n.teaching_learning_resources||'—')+'</p></div><div class="lesson-note-card"><h3>Introduction</h3><p>'+esc(n.introduction_activity||'—')+'</p></div><div class="lesson-note-card"><h3>Main activity</h3><p>'+esc(n.main_activity||'—')+'</p></div><div class="lesson-note-card"><h3>Plenary</h3><p>'+esc(n.plenary_activity||'—')+'</p></div><div class="lesson-note-card"><h3>Assessment</h3><p>'+esc(n.assessment_method||'—')+'</p></div><div class="lesson-note-card"><h3>Homework</h3><p>'+esc(n.homework||'—')+'</p></div><div class="lesson-note-card"><h3>Teacher reflection</h3><p>'+esc(n.teacher_reflection||'—')+'</p></div></div>'+(n.teaching_log?'<div class="lesson-note-card"><h3>Teaching log</h3><p>'+esc(n.teaching_log)+'</p></div>':'')+(n.review_note?'<div class="notice warn"><b>Review note</b><br>'+esc(n.review_note)+'</div>':'')+'<div class="panel"><h3>Attachments ('+attachments.length+')</h3>'+(attachments.length?attachments.map(function(a){return'<div class="row"><div><b>'+esc(a.file_name)+'</b><div class="muted">'+esc(Math.ceil(Number(a.file_size)/1024))+' KB • '+esc(a.mime_type)+'</div></div><button class="mini" data-admin-download-attachment="'+a.id+'">Download</button></div>'}).join(''):'<div class="empty">No attachments were added to this lesson note.</div>')+'</div>';\n`;
  ui=ui.slice(0,lessonStart)+lesson+ui.slice(lessonEnd);
}

// Security settings in School Setup, including administrator-controlled inactivity timeout.
ui=ui.replace('<button id="promotionThreshold" class="ghost">Promotion Threshold</button>','<button id="sessionSecurity" class="ghost">Session Security</button><button id="promotionThreshold" class="ghost">Promotion Threshold</button>');
ui=ui.replace("   E('editProfile').onclick=function(){",`   var sessionSecurity=E('sessionSecurity');if(sessionSecurity)sessionSecurity.onclick=async function(){var s=await raw('/api/security/settings');modal('<h2>Session Security</h2><p class="muted">Set how long staff can stay inactive and the maximum length of a signed-in School session.</p><label>Idle timeout (minutes) <span class="req">*</span></label><input id="idleTimeout" type="number" min="5" max="240" value="'+esc(s.idle_timeout_minutes)+'" required><label>Absolute session timeout (minutes) <span class="req">*</span></label><input id="absoluteTimeout" type="number" min="30" max="1440" value="'+esc(s.absolute_timeout_minutes)+'" required><div class="notice">The idle timeout signs out an inactive user. The absolute timeout signs the user out even if they remain active.</div><button id="saveSecurity" class="primary" style="width:100%">Save security settings</button>');E('saveSecurity').onclick=async function(){var idle=Number(E('idleTimeout').value),absolute=Number(E('absoluteTimeout').value);if(idle<5||idle>240)return toast('Idle timeout must be between 5 and 240 minutes',true);if(absolute<30||absolute>1440||absolute<idle)return toast('Absolute timeout must be at least the idle timeout and between 30 and 1440 minutes',true);await raw('/api/security/settings',{method:'PUT',body:JSON.stringify({idleTimeoutMinutes:idle,absoluteTimeoutMinutes:absolute})});close();toast('Session security updated')}};
   E('editProfile').onclick=function(){`);

// Manual promotion exception is separate from the automatic ready-student rollover and requires
// an explicit reason for audit purposes.
ui=ui.replace('<button id="processRollover" class="primary">Process ready students</button>','<div class="actions"><button id="processRollover" class="primary">Process ready students</button><button id="manualPromotion" class="ghost">Manual student exception</button></div>');
ui=ui.replace("     E('promotionPreview').querySelectorAll('[data-promo-outcome]').forEach(function(sel){",`     var manualPromotion=E('manualPromotion');if(manualPromotion)manualPromotion.onclick=function(){if(!preview.students.length)return toast('No students are available in this source class',true);form('Manual student promotion exception',[{key:'studentId',label:'Student',type:'select',options:preview.students.map(function(s){return{value:s.id,label:s.first_name+' '+s.last_name+' ('+s.admission_no+')'+(s.ready?' • ready':' • '+(s.reason||'blocked'))}})},{key:'outcome',label:'Outcome',type:'select',options:[{value:'promoted',label:'Promoted'},{value:'repeated',label:'Repeated / retained'},{value:'completed',label:'Completed / graduated'}]},{key:'toClassroomId',label:'Destination class',type:'select',required:false,options:[{value:'',label:'No destination (completed only)'}].concat(preview.destinations.concat(preview.repeatDestinations).filter(function(x,i,a){return a.findIndex(function(y){return y.id===x.id})===i}).map(function(x){return{value:x.id,label:x.name}}))},{key:'reason',label:'Reason for manual exception',type:'textarea',required:true}],{outcome:'promoted'},function(v){if(v.outcome!=='completed'&&!v.toClassroomId)throw Error('Choose a destination class');return raw('/api/promotions/manual',{method:'POST',body:JSON.stringify({studentId:v.studentId,fromAcademicYearId:fy,toAcademicYearId:ty,toClassroomId:v.toClassroomId||null,outcome:v.outcome,reason:v.reason})})})};
     E('promotionPreview').querySelectorAll('[data-promo-outcome]').forEach(function(sel){`);

// HR and payroll workspaces. HR configures emoluments/components and submits payroll; Finance
// approves and pays it. Staff can view their own generated payslips.
const leaveMarker=" else if(p==='leave'){";
if(!ui.includes("p==='hr'")){
  const payrollUi=` else if(p==='hr'){
   var rr=await Promise.all([raw('/api/hr/staff'),raw('/api/payroll/components')]),staff=rr[0],components=rr[1];
   E('content').innerHTML='<div class="section"><div><h1>HR & Emoluments</h1><p class="muted">Maintain staff salary profiles, payment details, earnings and deductions before payroll is processed.</p></div><button id="newPayrollComponent" class="primary">Add earning / deduction</button></div><div class="panel"><div class="toolbar"><input id="hrSearch" placeholder="Search staff, Staff ID, role or job title"></div><div id="hrRows"></div></div><div class="section"><h2>Payroll Components</h2></div><div class="panel">'+table(components,[{key:'code'},{key:'name'},{key:'component_type',label:'Type',render:function(r){return badge(r.component_type)}},{key:'calculation_type',label:'Calculation',render:function(r){return esc(String(r.calculation_type).replace(/_/g,' '))}},{key:'default_value',label:'Default value'},{key:'rate_percent',label:'Rate %'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}])+'</div>';
   function drawHr(){var q=(E('hrSearch').value||'').toLowerCase(),rows=q?staff.filter(function(s){return (s.first_name+' '+s.last_name+' '+(s.staff_id||'')+' '+(s.role||'')+' '+(s.job_title||'')).toLowerCase().includes(q)}):staff;E('hrRows').innerHTML=table(rows,[{key:'first_name',label:'Staff',render:function(s){return'<b>'+esc(s.first_name+' '+s.last_name)+'</b><br><span class="muted">'+esc(s.staff_id||'No Staff ID')+' • '+esc(s.job_title||s.role||'')+'</span>'}},{key:'base',label:'Basic Salary',render:function(s){return s.payroll_profile?docMoney(s.payroll_profile.base_salary,s.payroll_profile.currency):'<span class="badge pending">Not configured</span>'}},{key:'payroll_components',label:'Components',render:function(s){return esc((s.payroll_components||[]).length)}},{key:'status',render:function(s){return badge(s.status)}}],function(s){return'<button class="mini primary" data-emolument="'+s.id+'">Emolument</button>'})}drawHr();E('hrSearch').oninput=drawHr;
   E('newPayrollComponent').onclick=function(){form('Add payroll component',[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'componentType',label:'Type',type:'select',options:['earning','deduction']},{key:'calculationType',label:'Calculation',type:'select',options:[{value:'fixed',label:'Fixed amount'},{value:'percent_basic',label:'Percentage of basic salary'}]},{key:'defaultValue',label:'Default fixed amount',type:'number',required:false},{key:'ratePercent',label:'Percentage rate',type:'number',required:false}],{componentType:'earning',calculationType:'fixed',defaultValue:'0',ratePercent:'0'},function(v){return raw('/api/payroll/components',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,componentType:v.componentType,calculationType:v.calculationType,defaultValue:Number(v.defaultValue||0),ratePercent:Number(v.ratePercent||0),taxable:v.componentType==='earning',statutory:false})})})};
   E('content').onclick=function(e){var id=e.target.dataset.emolument;if(!id)return;var s=staff.find(function(x){return x.id===id}),p=s.payroll_profile||{},assigned=s.payroll_components||[];modal('<h2>Staff Emolument</h2><p class="muted">'+esc(s.first_name+' '+s.last_name)+' • Staff ID '+esc(s.staff_id||'—')+'</p><label>Basic salary <span class="req">*</span></label><input id="hrBasic" type="number" min="0" step="0.01" value="'+esc(p.base_salary||0)+'"><label>Bank name</label><input id="hrBank" value="'+esc(p.bank_name||'')+'"><label>Account name</label><input id="hrAccountName" value="'+esc(p.bank_account_name||'')+'"><label>Account number</label><input id="hrAccountNo" value="'+esc(p.bank_account_number||'')+'"><label>Mobile money number</label><input id="hrMomo" value="'+esc(p.mobile_money_number||'')+'"><label>Mobile money network</label><input id="hrMomoNetwork" value="'+esc(p.mobile_money_network||'')+'"><h3>Earnings & Deductions</h3><div id="hrComponents">'+components.filter(function(c){return c.is_active}).map(function(c){var a=assigned.find(function(x){return x.component_id===c.id});return'<label class="privilege-item"><input type="checkbox" data-pay-component="'+c.id+'"'+(a?' checked':'')+'><span><b>'+esc(c.name)+'</b><small>'+esc(c.component_type)+' • '+esc(c.calculation_type==='percent_basic'?(c.rate_percent+'% of basic'):(docMoney(c.default_value,p.currency||'GHS')))+'</small></span></label>'}).join('')+'</div><button id="saveEmolument" class="primary" style="width:100%;margin-top:12px">Save emolument</button>');E('saveEmolument').onclick=async function(){var base=Number(E('hrBasic').value);if(!Number.isFinite(base)||base<0)return toast('Enter a valid basic salary',true);await raw('/api/hr/staff/'+id+'/emolument',{method:'PUT',body:JSON.stringify({baseSalary:base,currency:p.currency||'GHS',bankName:E('hrBank').value||null,bankAccountName:E('hrAccountName').value||null,bankAccountNumber:E('hrAccountNo').value||null,mobileMoneyNumber:E('hrMomo').value||null,mobileMoneyNetwork:E('hrMomoNetwork').value||null,isActive:true})});var cs=[];E('hrComponents').querySelectorAll('[data-pay-component]:checked').forEach(function(x){cs.push({componentId:x.dataset.payComponent,isActive:true})});await raw('/api/hr/staff/'+id+'/components',{method:'PUT',body:JSON.stringify({components:cs})});close();toast('Staff emolument saved');page('hr')}}
 }
 else if(p==='payroll'){
   var mine=false,runs=[],myPayslips=[];try{runs=await raw('/api/payroll/runs')}catch(e){mine=true;myPayslips=await raw('/api/payroll/me')}
   if(mine){E('content').innerHTML='<div class="section"><div><h1>My Payroll</h1><p class="muted">View your earnings, deductions and net pay for processed periods.</p></div></div><div class="panel">'+table(myPayslips,[{key:'period_year',label:'Period',render:function(r){return esc(r.period_year+'-'+String(r.period_month).padStart(2,'0'))}},{key:'base_salary',label:'Basic',render:function(r){return docMoney(r.base_salary,'GHS')}},{key:'gross_earnings',label:'Gross',render:function(r){return docMoney(r.gross_earnings,'GHS')}},{key:'total_deductions',label:'Deductions',render:function(r){return docMoney(r.total_deductions,'GHS')}},{key:'net_pay',label:'Net Pay',render:function(r){return'<b>'+docMoney(r.net_pay,'GHS')+'</b>'}},{key:'status',render:function(r){return badge(r.status)}}])+'</div>';}
   else{E('content').innerHTML='<div class="section"><div><h1>Payroll</h1><p class="muted">HR prepares payroll, Finance approves payment and the School GL records payroll automatically.</p></div><button id="createPayroll" class="primary">Create monthly payroll</button></div><div class="panel">'+table(runs,[{key:'period_year',label:'Period',render:function(r){return'<b>'+esc(r.period_year+'-'+String(r.period_month).padStart(2,'0'))+'</b>'}},{key:'gross_total',label:'Gross',render:function(r){return docMoney(r.gross_total,r.currency)}},{key:'deductions_total',label:'Deductions',render:function(r){return docMoney(r.deductions_total,r.currency)}},{key:'net_total',label:'Net Pay',render:function(r){return'<b>'+docMoney(r.net_total,r.currency)+'</b>'}},{key:'status',render:function(r){return badge(r.status)}}],function(r){return'<button class="mini" data-open-payroll="'+r.id+'">Open</button>'})+'</div>';E('createPayroll').onclick=function(){var now=new Date();form('Create monthly payroll',[{key:'year',label:'Year',type:'number'},{key:'month',label:'Month',type:'number'}],{year:now.getFullYear(),month:now.getMonth()+1},function(v){return raw('/api/payroll/runs',{method:'POST',body:JSON.stringify({year:Number(v.year),month:Number(v.month)})})})};E('content').onclick=async function(e){var id=e.target.dataset.openPayroll;if(!id)return;var x=await raw('/api/payroll/runs/'+id),r=x.run;modal('<h2>Payroll '+esc(r.period_year+'-'+String(r.period_month).padStart(2,'0'))+'</h2><div class="payroll-grid"><div class="payroll-item"><span class="muted">Gross</span><b>'+docMoney(r.gross_total,r.currency)+'</b></div><div class="payroll-item"><span class="muted">Deductions</span><b>'+docMoney(r.deductions_total,r.currency)+'</b></div><div class="payroll-item"><span class="muted">Net Pay</span><b>'+docMoney(r.net_total,r.currency)+'</b></div><div class="payroll-item"><span class="muted">Status</span>'+badge(r.status)+'</div></div>'+table(x.items,[{key:'staff_name',label:'Staff',render:function(i){return'<b>'+esc(i.staff_name)+'</b><br><span class="muted">'+esc(i.staff_id||'')+'</span>'}},{key:'base_salary',label:'Basic',render:function(i){return docMoney(i.base_salary,r.currency)}},{key:'gross_earnings',label:'Gross',render:function(i){return docMoney(i.gross_earnings,r.currency)}},{key:'total_deductions',label:'Deductions',render:function(i){return docMoney(i.total_deductions,r.currency)}},{key:'net_pay',label:'Net',render:function(i){return'<b>'+docMoney(i.net_pay,r.currency)+'</b>'}}])+'<div class="actions">'+(r.status==='draft'?'<button id="submitPayroll" class="primary">Submit to Finance</button>':'')+(r.status==='submitted_to_finance'?'<button id="approvePayroll" class="primary">Finance Approve</button>':'')+(r.status==='approved_for_payment'?'<button id="payPayroll" class="primary">Post Salary Payment</button>':'')+'</div>');if(E('submitPayroll'))E('submitPayroll').onclick=async function(){await raw('/api/payroll/runs/'+id+'/submit',{method:'POST',body:'{}'});close();page('payroll')};if(E('approvePayroll'))E('approvePayroll').onclick=async function(){await raw('/api/payroll/runs/'+id+'/approve',{method:'POST',body:'{}'});close();page('payroll')};if(E('payPayroll'))E('payPayroll').onclick=async function(){if(!confirm('Post the salary payment to the GL and mark this payroll paid?'))return;await raw('/api/payroll/runs/'+id+'/pay',{method:'POST',body:'{}'});close();page('payroll')}}}
 }
`;
  if(!ui.includes(leaveMarker))throw new Error('Remediation patch could not find leave module marker');
  ui=ui.replace(leaveMarker,payrollUi+leaveMarker);
}

// Staff ID is always visible in the Access Management directory search/table through a normalised
// helper value, regardless of whether Core returned employee_number or login_staff_id.
ui=ui.replace("function emailLabel(u){return u&&u.email?u.email:'Email not configured'}","function emailLabel(u){return u&&u.email?u.email:'Email not configured'}\n   function staffIdLabel(u){return u&&(u.employee_number||u.login_staff_id)?(u.employee_number||u.login_staff_id):'Not assigned'}");
ui=ui.replace(/function directoryTable\(rows\)\{return table\(rows,\[/,`function directoryTable(rows){return table(rows,[{key:'id',label:'Staff ID',render:function(u){return'<b>'+esc(staffIdLabel(u))+'</b>'}},`);

await writeFile(uiPath,ui);
console.log('Applied Revolt-X School full remediation patch');
