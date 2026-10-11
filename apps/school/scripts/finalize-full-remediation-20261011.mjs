import { readFile, writeFile } from 'node:fs/promises';

const hrPath=new URL('../src/hr-payroll-routes.ts',import.meta.url);
const remediationPath=new URL('../src/school-remediation-routes.ts',import.meta.url);
const migrationPath=new URL('../migrations/053_security_period_lock_hr_payroll.sql',import.meta.url);
const uiPath=new URL('../src/ui.ts',import.meta.url);

for(const path of [hrPath,remediationPath]){
  let src=await readFile(path,'utf8');
  src=src.replace(/\b(one|maybeOne)<any>/g,'$1');
  await writeFile(path,src);
}

let migration=await readFile(migrationPath,'utf8');
migration=migration.replace("    WHEN c.key='payroll.view' THEN true\n    ELSE false","    ELSE false");
await writeFile(migrationPath,migration);

let ui=await readFile(uiPath,'utf8');

// HR is only for roles that manage emoluments. The Payroll screen remains visible so an
// ordinary staff user can fall back to /api/payroll/me and view only their own payslips.
ui=ui.replace("['hr','HR','H','','school.staff']","['hr','HR & Emoluments','H','payroll.manage','school.staff']");
ui=ui.replace("['payroll','Payroll','₵','','school.staff']","['payroll','Payroll','₵','','school.staff']");

// Add lock/reopen controls to academic years and terms in School Setup.
ui=ui.replace(
  "function(r){return (r.status!=='active'?'<button class=\"mini\" data-activate-year=\"'+r.id+'\">Activate</button>':'')+'<button class=\"mini\" data-edit-year=\"'+r.id+'\">Edit</button><button class=\"mini danger\" data-delete-year=\"'+r.id+'\">Delete</button>'}",
  "function(r){return (r.status!=='active'&&!r.is_locked?'<button class=\"mini\" data-activate-year=\"'+r.id+'\">Activate</button>':'')+'<button class=\"mini\" data-edit-year=\"'+r.id+'\"'+(r.is_locked?' disabled':'')+'>Edit</button>'+(r.is_locked?'<button class=\"mini primary-lite\" data-lock-year=\"'+r.id+'\" data-lock-next=\"false\">Reopen</button>':'<button class=\"mini\" data-lock-year=\"'+r.id+'\" data-lock-next=\"true\">Lock</button>')+'<button class=\"mini danger\" data-delete-year=\"'+r.id+'\"'+(r.is_locked?' disabled':'')+'>Delete</button>'}"
);
ui=ui.replace(
  "function(r){return (r.status!=='active'?'<button class=\"mini\" data-activate-term=\"'+r.id+'\">Activate</button>':'')+'<button class=\"mini\" data-edit-term=\"'+r.id+'\">Edit dates</button>'}",
  "function(r){return (r.status!=='active'&&!r.is_locked?'<button class=\"mini\" data-activate-term=\"'+r.id+'\">Activate</button>':'')+'<button class=\"mini\" data-edit-term=\"'+r.id+'\"'+(r.is_locked?' disabled':'')+'>Edit dates</button>'+(r.is_locked?'<button class=\"mini primary-lite\" data-lock-term=\"'+r.id+'\" data-lock-next=\"false\">Reopen</button>':'<button class=\"mini\" data-lock-term=\"'+r.id+'\" data-lock-next=\"true\">Lock</button>')}"
);

const termHandler="     id=e.target.dataset.activateTerm;if(id){await raw('/api/terms/'+id+'/activate',{method:'POST',body:'{}'});toast('Term activated');return page('setup')}";
if(ui.includes(termHandler)&&!ui.includes("dataset.lockYear")){
  ui=ui.replace(termHandler,`     id=e.target.dataset.lockYear;if(id){var locked=e.target.dataset.lockNext==='true',reason=locked?'Academic year completed / protected':'Administrator reopening';if(!confirm((locked?'Lock':'Reopen')+' this academic year? '+(locked?'All its terms will become read-only.':'Its terms will also be reopened for authorised edits.')))return;await raw('/api/academic-periods/year/'+id+'/lock',{method:'POST',body:JSON.stringify({locked:locked,reason:reason})});toast(locked?'Academic year locked':'Academic year reopened');return page('setup')}
     id=e.target.dataset.lockTerm;if(id){var termLocked=e.target.dataset.lockNext==='true';if(!confirm((termLocked?'Lock':'Reopen')+' this term?'))return;await raw('/api/academic-periods/term/'+id+'/lock',{method:'POST',body:JSON.stringify({locked:termLocked,reason:termLocked?'Term completed / protected':'Administrator reopening'})});toast(termLocked?'Term locked':'Term reopened');return page('setup')}
${termHandler}`);
}

// The admission application is edited in Admissions, not an Admin/settings page. Make the
// distinction explicit in the UI and mark the mandatory applicant/guardian fields.
ui=ui.replace('<h2>Admission Application</h2>','<h2>Admission Application</h2><small class="muted">Admissions workspace</small>');
for(const label of ['First name','Last name','Requested grade','Guardian first name','Guardian last name','Primary phone','Relationship']){
  ui=ui.replaceAll('<label>'+label+'</label>','<label>'+label+' <span class="req">*</span></label>');
}

// Mark standard standalone modal controls that are already browser-required, without turning
// optional search/filter fields into required data entry fields.
if(!ui.includes('function markRequiredControls')){
  ui=ui.replace("function modal(html){E('modalBody').innerHTML=html;E('modal').classList.remove('hide')}",`function markRequiredControls(root){if(!root)return;root.querySelectorAll('input[required],select[required],textarea[required]').forEach(function(el){var label=el.previousElementSibling;if(label&&label.tagName==='LABEL'&&!label.querySelector('.req'))label.insertAdjacentHTML('beforeend',' <span class="req">*</span>')})}
function modal(html){E('modalBody').innerHTML=html;markRequiredControls(E('modalBody'));E('modal').classList.remove('hide')}`);
}

await writeFile(uiPath,ui);
console.log('Finalized Revolt-X School remediation hardening');
