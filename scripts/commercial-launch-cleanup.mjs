import { readFile, writeFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const path = rel => new URL(rel, root);
const read = rel => readFile(path(rel), 'utf8');
const write = (rel, text) => writeFile(path(rel), text);

function requiredReplace(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`Cleanup could not find ${label}`);
  return source.replace(oldValue, newValue);
}
function requiredRegex(source, regex, replacement, label) {
  if (!regex.test(source)) throw new Error(`Cleanup could not find ${label}`);
  regex.lastIndex = 0;
  return source.replace(regex, replacement);
}
function insertBefore(source, marker, block, label) {
  if (source.includes(block.trim())) return source;
  if (!source.includes(marker)) throw new Error(`Cleanup could not find ${label}`);
  return source.replace(marker, block + '\n' + marker);
}

// -----------------------------------------------------------------------------
// School configuration: cached licences are valid for a finite outage window.
// -----------------------------------------------------------------------------
let config = await read('apps/school/src/config.ts');
config = requiredReplace(
  config,
  "  COMMUNICATION_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),",
  "  COMMUNICATION_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),\n  // When Core OS cannot be reached, a recently verified active licence remains usable\n  // for this many hours. After the grace window the School becomes read-only until\n  // Core OS can verify the entitlement again.\n  LICENSE_OUTAGE_GRACE_HOURS: z.coerce.number().int().min(1).max(336).default(72),",
  'licence outage grace configuration'
);
await write('apps/school/src/config.ts', config);

// -----------------------------------------------------------------------------
// School server: finite licence cache, tenant URLs and OS-visible admin activity.
// -----------------------------------------------------------------------------
let server = await read('apps/school/src/server.ts');
const licenceReplacement = `async function schoolLicence(organisationId:string,force=false){
  const local=await readLocalLicence(organisationId);
  const age=local?.syncedAt?Date.now()-new Date(local.syncedAt).getTime():Number.POSITIVE_INFINITY;
  if(!force&&local&&age<300000)return local;

  // Core OS is the licence source of truth. A cached active entitlement is deliberately
  // allowed only for a bounded outage grace period so a School cannot operate forever
  // on a stale licence after commercial launch.
  const remote=await fetchCoreLicence(organisationId);
  if(remote&&remote.status&&remote.status!=='unlicensed')return persistLicence(organisationId,remote,'core_os');
  if(local){
    const inactive=['suspended','expired','cancelled','unlicensed'];
    if(inactive.includes(String(local.status)))return local;
    const graceMs=Number(config.LICENSE_OUTAGE_GRACE_HOURS||72)*60*60*1000;
    if(Number.isFinite(age)&&age<=graceMs){
      return{...local,status:'outage_grace',licensed:true,underlyingStatus:local.status,outageGrace:true,
        outageGraceHours:Number(config.LICENSE_OUTAGE_GRACE_HOURS||72),
        outageGraceEndsAt:new Date(new Date(local.syncedAt).getTime()+graceMs).toISOString()};
    }
    return{...local,status:'verification_required',licensed:false,underlyingStatus:local.status,
      outageGraceExpired:true,outageGraceHours:Number(config.LICENSE_OUTAGE_GRACE_HOURS||72)};
  }

  // Existing pre-commercial tenants remain operational until explicitly adopted into OS licensing.
  return{
    licensed:true,licenseCode:null,product:'school',plan:'legacy',planName:'Legacy Commercial Transition',
    status:'legacy',billingFrequency:null,recurringAmount:0,currency:'GHS',periodEnd:null,trialEndsAt:null,graceEndsAt:null,
    limits:{},modules:ALL_COMMERCIAL_MODULES,syncedAt:null,source:'legacy_transition'
  };
}`;
server = requiredRegex(
  server,
  /async function schoolLicence\(organisationId:string,force=false\)\{[\s\S]*?\n\}\n\nasync function resolveTenantSchool/,
  licenceReplacement + '\n\nasync function resolveTenantSchool',
  'School licence resolver'
);
server = server.replaceAll("['suspended','expired','cancelled','unlicensed']", "['suspended','expired','cancelled','unlicensed','verification_required']");
server = requiredReplace(
  server,
  "  }else if(['suspended','expired','cancelled','unlicensed','verification_required'].includes(String(licence?.status))){",
  "  }else if(licence?.status==='outage_grace'){\n    warningLevel='warning';warningMessage='Core OS is temporarily unreachable. The last verified licence remains usable until '+new Date(licence.outageGraceEndsAt).toLocaleString()+' ('+licence.outageGraceHours+' hour outage grace).';\n  }else if(licence?.status==='verification_required'){\n    warningLevel='critical';warningMessage='Core OS has been unreachable beyond the '+licence.outageGraceHours+' hour licence outage grace. The workspace is read-only until the licence is verified again.';\n  }else if(['suspended','expired','cancelled','unlicensed'].includes(String(licence?.status))){",
  'licence outage warning'
);

const tenantRoutes = `// Human-readable tenant URLs keep the school code in the address while every request
// still resolves the tenant from the database. This avoids a separate deployment per school.
app.get('/s/:school/login',async(request:any,p)=>{await resolveTenantSchool(String(request.params.school));return p.type('text/html; charset=utf-8').send(loginFrontend)});
app.get('/s/:school/admin-login',async(request:any,p)=>{await resolveTenantSchool(String(request.params.school));return p.type('text/html; charset=utf-8').send(adminLoginFrontend)});
app.get('/s/:school/change-password',async(request:any,p)=>{await resolveTenantSchool(String(request.params.school));return p.type('text/html; charset=utf-8').send(passwordChangeFrontend)});
app.get('/s/:school/admin-password-reset',async(request:any,p)=>{await resolveTenantSchool(String(request.params.school));return p.header('cache-control','no-store, max-age=0').type('text/html; charset=utf-8').send(adminPasswordResetFrontend)});`;
server = insertBefore(server, "app.get('/login',async(_r,p)=>p.type('text/html; charset=utf-8').send(loginFrontend));", tenantRoutes, 'tenant login routes');

const adminActivityRoute = `// Core OS reads this service-authenticated feed to monitor administrative activity
// across managed School tenants. The feed contains action metadata, never passwords.
app.get('/api/internal/admin-activity',async(request:any)=>{
  requireCoreServiceRequest(request);
  const q=z.object({organisationId:z.string().uuid(),limit:z.coerce.number().int().min(1).max(500).default(100)}).parse(request.query);
  const school=await maybeOne<any>(db,'SELECT school_name,tenant_slug FROM school_profiles WHERE organisation_id=$1',[q.organisationId]);
  if(!school)throw fail(404,'School tenant was not found');
  const rows=(await db.query(\`SELECT id,actor_os_user_id,action,resource_type,resource_id,metadata,created_at
    FROM school_audit_logs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT $2\`,[q.organisationId,q.limit])).rows;
  return{school,rows};
});`;
server = insertBefore(server, "app.get('/api/internal/tenants',async request=>{", adminActivityRoute, 'internal admin activity route');
await write('apps/school/src/server.ts', server);

// -----------------------------------------------------------------------------
// School login: tenant slug from URL and password visibility controls.
// -----------------------------------------------------------------------------
let login = await read('apps/school/src/login-ui.ts');
login = login.replace(
  ".switch a:hover{text-decoration:underline}",
  ".switch a:hover{text-decoration:underline}.password-visibility{display:flex;align-items:center;gap:8px;margin:8px 0 0;color:#526979;font-size:13px;font-weight:700}.password-visibility input{width:auto;margin:0;padding:0}"
);
login = login.replaceAll(
  "requested=new URLSearchParams(location.search).get('school')||'',saved='';",
  "pathSchool=(location.pathname.match(/^\\/s\\/([^/]+)\\//)||[])[1]||'',requested=decodeURIComponent(pathSchool||new URLSearchParams(location.search).get('school')||''),saved='';"
);
// Each login/reset page receives the same accessible Show password control without
// maintaining duplicate page-specific password scripts.
login = login.replaceAll(
  "  function E(id){return document.getElementById(id)}",
  "  function E(id){return document.getElementById(id)}\n  function enablePasswordVisibility(){document.querySelectorAll('input[type=\\\"password\\\"]').forEach(function(input){if(input.dataset.visibilityReady)return;input.dataset.visibilityReady='1';var label=document.createElement('label');label.className='password-visibility';var check=document.createElement('input');check.type='checkbox';check.onchange=function(){input.type=check.checked?'text':'password'};label.appendChild(check);label.appendChild(document.createTextNode('Show password'));input.insertAdjacentElement('afterend',label)})}\n  enablePasswordVisibility();"
);
await write('apps/school/src/login-ui.ts', login);

// -----------------------------------------------------------------------------
// Payroll routes: reusable grades, Finance review before journals and exports.
// -----------------------------------------------------------------------------
let payroll = await read('apps/school/src/hr-payroll-routes.ts');
payroll = requiredReplace(payroll, "import { z } from 'zod';", "import { z } from 'zod';\nimport { createRequire } from 'node:module';\nconst require=createRequire(import.meta.url);\nconst PDFDocument:any=require('pdfkit');", 'payroll PDF dependency');

payroll = requiredReplace(
  payroll,
  "    const profiles=(await db.query(`SELECT * FROM staff_payroll_profiles WHERE organisation_id=$1`,[a.core.organisation_id])).rows;",
  "    const profiles=(await db.query(`SELECT * FROM staff_payroll_profiles WHERE organisation_id=$1`,[a.core.organisation_id])).rows;\n    const grades=(await db.query(`SELECT id,code,name,base_salary,currency,is_active FROM payroll_grades WHERE organisation_id=$1`,[a.core.organisation_id])).rows;",
  'staff payroll grade lookup'
);
payroll = requiredReplace(
  payroll,
  "        payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,\n        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};",
  "        payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,\n        payroll_grade:(()=>{const p=profiles.find((x:any)=>x.os_user_id===m.os_user_id);return p?.grade_id?grades.find((g:any)=>g.id===p.grade_id)||null:null})(),\n        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};",
  'staff grade response'
);

const gradeRoutes = `
  // Salary grades let HR maintain one salary/deduction definition for many staff.
  // Personal staff component assignments continue to override the grade for loans or
  // other employee-specific adjustments.
  app.get('/api/payroll/grades',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');
    const grades=(await db.query('SELECT * FROM payroll_grades WHERE organisation_id=$1 ORDER BY code,name',[a.core.organisation_id])).rows;
    const components=(await db.query(\`SELECT gc.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory
      FROM payroll_grade_components gc JOIN payroll_components c ON c.id=gc.component_id
      WHERE gc.organisation_id=$1 AND gc.is_active=true AND c.is_active=true ORDER BY c.component_type,c.name\`,[a.core.organisation_id])).rows;
    return grades.map((g:any)=>({...g,components:components.filter((c:any)=>c.grade_id===g.id)}));
  });

  app.post('/api/payroll/grades',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const b=z.object({code:z.string().trim().min(1).max(40),name:z.string().trim().min(2).max(160),baseSalary:z.number().min(0),currency:z.string().trim().min(3).max(10).default('GHS')}).parse(request.body);
    const row=await one<any>(db,\`INSERT INTO payroll_grades(organisation_id,code,name,base_salary,currency,created_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *\`,[a.core.organisation_id,b.code.toUpperCase(),b.name,b.baseSalary,b.currency.toUpperCase(),a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_created','payroll_grade',row.id,{code:row.code,name:row.name});
    return reply.code(201).send(row);
  });

  app.patch('/api/payroll/grades/:id',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),baseSalary:z.number().min(0).optional(),currency:z.string().trim().min(3).max(10).optional(),isActive:z.boolean().optional()}).parse(request.body);
    const current=await one<any>(db,'SELECT * FROM payroll_grades WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const row=await one<any>(db,\`UPDATE payroll_grades SET name=$1,base_salary=$2,currency=$3,is_active=$4,updated_at=now()
      WHERE id=$5 AND organisation_id=$6 RETURNING *\`,[b.name??current.name,b.baseSalary??Number(current.base_salary),String(b.currency??current.currency).toUpperCase(),b.isActive??current.is_active,id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_updated','payroll_grade',id,{name:row.name,baseSalary:row.base_salary});return row;
  });

  app.put('/api/payroll/grades/:id/components',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({components:z.array(z.object({componentId:z.string().uuid(),valueOverride:z.number().min(0).nullable().optional(),rateOverride:z.number().min(0).max(100).nullable().optional()})).max(100)}).parse(request.body);
    await one<any>(db,'SELECT id FROM payroll_grades WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    await tx(db,async(client:any)=>{await client.query('DELETE FROM payroll_grade_components WHERE grade_id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);for(const c of b.components)await client.query(\`INSERT INTO payroll_grade_components(organisation_id,grade_id,component_id,value_override,rate_override,created_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6)\`,[a.core.organisation_id,id,c.componentId,c.valueOverride??null,c.rateOverride??null,a.core.id])});
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_components_updated','payroll_grade',id,{count:b.components.length});return{saved:b.components.length};
  });

  app.put('/api/hr/staff/:userId/grade',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {userId}=z.object({userId:z.string().uuid()}).parse(request.params);
    const b=z.object({gradeId:z.string().uuid().nullable()}).parse(request.body);
    if(b.gradeId)await one<any>(db,'SELECT id FROM payroll_grades WHERE id=$1 AND organisation_id=$2 AND is_active=true',[b.gradeId,a.core.organisation_id]);
    const row=await one<any>(db,'UPDATE staff_payroll_profiles SET grade_id=$1,updated_by_os_user_id=$2,updated_at=now() WHERE organisation_id=$3 AND os_user_id=$4 RETURNING *',[b.gradeId,a.core.id,a.core.organisation_id,userId]);
    await audit(a.core.organisation_id,a.core.id,'payroll.staff_grade_assigned','staff_payroll_profile',row.id,{staff:userId,gradeId:b.gradeId});return row;
  });
`;
payroll = insertBefore(payroll, "  app.put('/api/hr/staff/:userId/emolument',async(request:any)=>{", gradeRoutes, 'payroll grade routes');

// Merge grade defaults with personal assignments. Personal items with the same component
// take precedence, which is how loans and one-off adjustments remain employee-specific.
payroll = requiredReplace(
  payroll,
  "    const result=await tx(db,async(client:any)=>{",
  "    const grades=(await db.query('SELECT * FROM payroll_grades WHERE organisation_id=$1 AND is_active=true',[a.core.organisation_id])).rows;\n    const gradeComponents=(await db.query(`SELECT gc.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory FROM payroll_grade_components gc JOIN payroll_components c ON c.id=gc.component_id WHERE gc.organisation_id=$1 AND gc.is_active=true AND c.is_active=true`,[a.core.organisation_id])).rows;\n    const result=await tx(db,async(client:any)=>{",
  'payroll grade calculation inputs'
);
payroll = requiredReplace(
  payroll,
  "        const u=users.find((x:any)=>x.id===p.os_user_id)||{};const basic=Number(p.base_salary||0);const assigned=components.filter((x:any)=>x.os_user_id===p.os_user_id);",
  "        const u=users.find((x:any)=>x.id===p.os_user_id)||{};const grade=p.grade_id?grades.find((g:any)=>g.id===p.grade_id):null;const basic=Number(grade?.base_salary??p.base_salary??0);const personal=components.filter((x:any)=>x.os_user_id===p.os_user_id);const inherited=grade?gradeComponents.filter((x:any)=>x.grade_id===grade.id):[];const merged=new Map<string,any>();inherited.forEach((x:any)=>merged.set(x.component_id,x));personal.forEach((x:any)=>merged.set(x.component_id,x));const assigned=Array.from(merged.values());",
  'grade-aware payroll calculation'
);

const submitBlock = /  app\.post\('\/api\/payroll\/runs\/:id\/submit',[\s\S]*?\n  \}\);\n\n  app\.post\('\/api\/payroll\/runs\/:id\/approve',[\s\S]*?\n  \}\);/;
const submitReplacement = `  app.post('/api/payroll/runs/:id/submit',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const current=await one<any>(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(current.status!=='draft')throw fail(409,'Only a draft payroll can be submitted to Finance');
    // Submission is a review hand-off only. No accounting entry is posted until Finance approves.
    const updated=await one<any>(db,\`UPDATE payroll_runs SET status='submitted_to_finance',submitted_by_os_user_id=$1,submitted_at=now(),updated_at=now()
      WHERE id=$2 AND organisation_id=$3 RETURNING *\`,[a.core.id,id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.submitted_to_finance','payroll_run',id,{net:updated.net_total});return updated;
  });

  app.post('/api/payroll/runs/:id/approve',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.process');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const current=await one<any>(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(current.status!=='submitted_to_finance')throw fail(409,'Payroll must be submitted to Finance before approval');
    const updated=await tx(db,async(client:any)=>{
      const journal=await createJournal(client,a.core.organisation_id,a.core.id,\`Payroll \${current.period_year}-\${String(current.period_month).padStart(2,'0')}\`,'payroll_accrual',id,[
        {code:'5000',debit:Number(current.gross_total),description:'Gross salaries and wages'},
        {code:'2050',credit:Number(current.net_total),description:'Net payroll payable'},
        ...(Number(current.deductions_total)>0?[{code:'2100',credit:Number(current.deductions_total),description:'Payroll deductions payable'}]:[])
      ]);
      return one<any>(client,\`UPDATE payroll_runs SET status='approved_for_payment',approved_by_os_user_id=$1,approved_at=now(),finance_journal_entry_id=$2,updated_at=now()
        WHERE id=$3 AND organisation_id=$4 RETURNING *\`,[a.core.id,journal.id,id,a.core.organisation_id]);
    });
    await audit(a.core.organisation_id,a.core.id,'payroll.approved_for_payment','payroll_run',id,{net:updated.net_total,journalEntryId:updated.finance_journal_entry_id});return updated;
  });`;
payroll = requiredRegex(payroll, submitBlock, submitReplacement, 'payroll Finance review workflow');

const exportRoute = `
  app.get('/api/payroll/runs/:id/export',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const q=z.object({format:z.enum(['pdf','excel']).default('pdf')}).parse(request.query);
    const run=await one<any>(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const items=(await db.query('SELECT * FROM payroll_run_items WHERE payroll_run_id=$1 AND organisation_id=$2 ORDER BY staff_name',[id,a.core.organisation_id])).rows;
    const period=String(run.period_year)+'-'+String(run.period_month).padStart(2,'0');
    if(q.format==='excel'){
      const escXml=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const rows=items.map((r:any)=>`<tr><td>${escXml(r.staff_id)}</td><td>${escXml(r.staff_name)}</td><td>${Number(r.base_salary).toFixed(2)}</td><td>${Number(r.gross_earnings).toFixed(2)}</td><td>${Number(r.total_deductions).toFixed(2)}</td><td>${Number(r.net_pay).toFixed(2)}</td></tr>`).join('');
      const html=`<html><head><meta charset="utf-8"></head><body><table border="1"><tr><th colspan="6">Revolt-X School Payroll ${period}</th></tr><tr><th>Staff ID</th><th>Staff</th><th>Basic</th><th>Gross</th><th>Deductions</th><th>Net Pay</th></tr>${rows}<tr><th colspan="3">Totals</th><th>${Number(run.gross_total).toFixed(2)}</th><th>${Number(run.deductions_total).toFixed(2)}</th><th>${Number(run.net_total).toFixed(2)}</th></tr></table></body></html>`;
      return reply.header('content-disposition',`attachment; filename="payroll-${period}.xls"`).type('application/vnd.ms-excel; charset=utf-8').send(html);
    }
    const chunks:Buffer[]=[];const doc=new PDFDocument({size:'A4',margin:36});doc.on('data',(c:Buffer)=>chunks.push(c));const done=new Promise<Buffer>((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
    doc.fontSize(18).text('Revolt-X School Payroll',{align:'center'});doc.fontSize(11).text('Period: '+period+'   Status: '+String(run.status).replace(/_/g,' '),{align:'center'});doc.moveDown();
    doc.fontSize(9);for(const r of items){doc.text(`${r.staff_id||'—'}  ${r.staff_name} | Basic ${Number(r.base_salary).toFixed(2)} | Gross ${Number(r.gross_earnings).toFixed(2)} | Deductions ${Number(r.total_deductions).toFixed(2)} | Net ${Number(r.net_pay).toFixed(2)}`);if(doc.y>760)doc.addPage()}
    doc.moveDown().fontSize(11).text(`Totals: Gross ${Number(run.gross_total).toFixed(2)} | Deductions ${Number(run.deductions_total).toFixed(2)} | Net ${Number(run.net_total).toFixed(2)}`);doc.end();
    const pdf=await done;return reply.header('content-disposition',`attachment; filename="payroll-${period}.pdf"`).type('application/pdf').send(pdf);
  });
`;
payroll = insertBefore(payroll, "  app.get('/api/payroll/me',async(request:any)=>{", exportRoute, 'payroll export route');
await write('apps/school/src/hr-payroll-routes.ts', payroll);

// -----------------------------------------------------------------------------
// School UI: larger forms, safe event binding, form reset and payroll grade/export UI.
// -----------------------------------------------------------------------------
let ui = await read('apps/school/src/ui.ts');
ui = ui.replace('</head>', `<style id="rx-commercial-launch-css">.modalbox{width:min(860px,96vw)!important;max-height:92vh!important}.grade-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.grade-card{border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--panel)}@media(max-width:760px){.modalbox{width:96vw!important}.grade-grid{grid-template-columns:1fr}}</style></head>`);
// A missing optional control must never prevent the dashboard from loading. Dynamic page
// controls are intentionally null-safe because role/module combinations can remove them.
ui = ui.replace(/E\('([^']+)'\)\.onclick=/g, "if(E('$1'))E('$1').onclick=");
ui = ui.replace(
  "await raw('/api/attendance/mark',{method:'POST',body:JSON.stringify({classroomId:cid,date:date,records:records})});toast('Attendance saved')",
  "await raw('/api/attendance/mark',{method:'POST',body:JSON.stringify({classroomId:cid,date:date,records:records})});E('attPanel').innerHTML='<div class=\\\"empty\\\">Attendance saved. Choose Load class to record another date or class.</div>';toast('Attendance saved')"
);

ui = requiredReplace(
  ui,
  "var rr=await Promise.all([raw('/api/hr/staff'),raw('/api/payroll/components')]),staff=rr[0],components=rr[1];",
  "var rr=await Promise.all([raw('/api/hr/staff'),raw('/api/payroll/components'),raw('/api/payroll/grades')]),staff=rr[0],components=rr[1],grades=rr[2];",
  'HR grade loading'
);
ui = requiredReplace(
  ui,
  "<button id=\"newPayrollComponent\" class=\"primary\">Add earning / deduction</button></div>",
  "<div class=\"actions\"><button id=\"newPayrollGrade\" class=\"ghost\">Add salary grade</button><button id=\"newPayrollComponent\" class=\"primary\">Add earning / deduction</button></div></div>",
  'HR grade button'
);
ui = requiredReplace(
  ui,
  "</div><div class=\"section\"><h2>Payroll Components</h2></div><div class=\"panel\">'+table(components,",
  "</div><div class=\"section\"><h2>Salary Grades</h2></div><div class=\"panel\"><div class=\"grade-grid\">'+(grades.length?grades.map(function(g){return'<div class=\\\"grade-card\\\"><b>'+esc(g.code)+' · '+esc(g.name)+'</b><p>'+docMoney(g.base_salary,g.currency)+'</p><small class=\\\"muted\\\">'+esc((g.components||[]).length)+' grade-level earning/deduction rule(s)</small><br><button class=\\\"mini\\\" data-edit-pay-grade=\\\"'+g.id+'\\\">Edit grade</button></div>'}).join(''):'<div class=\\\"empty\\\">No salary grades yet.</div>')+'</div></div><div class=\"section\"><h2>Payroll Components</h2></div><div class=\"panel\">'+table(components,",
  'salary grade panel'
);
// Show inherited grade salary instead of implying every employee must be configured manually.
ui = ui.replace(
  "return s.payroll_profile?docMoney(s.payroll_profile.base_salary,s.payroll_profile.currency):'<span class=\"badge pending\">Not configured</span>'",
  "return s.payroll_grade?'<b>'+docMoney(s.payroll_grade.base_salary,s.payroll_grade.currency)+'</b><br><small class=\\\"muted\\\">'+esc(s.payroll_grade.code+' · '+s.payroll_grade.name)+'</small>':(s.payroll_profile?docMoney(s.payroll_profile.base_salary,s.payroll_profile.currency):'<span class=\\\"badge pending\\\">Not configured</span>')"
);
const gradeUiHook = "if(E('newPayrollGrade'))E('newPayrollGrade').onclick=function(){form('Add salary grade',[{key:'code',label:'Grade code'},{key:'name',label:'Grade name'},{key:'baseSalary',label:'Basic salary',type:'number'}],{baseSalary:'0'},function(v){return raw('/api/payroll/grades',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,baseSalary:Number(v.baseSalary),currency:'GHS'})})})};";
ui = requiredReplace(ui, "if(E('newPayrollComponent'))E('newPayrollComponent').onclick=function(){", gradeUiHook + "\n   if(E('newPayrollComponent'))E('newPayrollComponent').onclick=function(){", 'grade create handler');

ui = requiredReplace(
  ui,
  "E('content').onclick=function(e){var id=e.target.dataset.emolument;if(!id)return;var s=staff.find(function(x){return x.id===id}),p=s.payroll_profile||{},assigned=s.payroll_components||[];modal('<h2>Staff Emolument</h2>",
  "E('content').onclick=function(e){var gid=e.target.dataset.editPayGrade;if(gid){var g=grades.find(function(x){return x.id===gid}),ga=g.components||[];modal('<h2>Edit Salary Grade</h2><p class=\\\"muted\\\">Changes apply to every staff member assigned to this grade on the next payroll run.</p><label>Grade name</label><input id=\\\"gradeName\\\" value=\\\"'+esc(g.name)+'\\\"><label>Basic salary</label><input id=\\\"gradeBasic\\\" type=\\\"number\\\" min=\\\"0\\\" step=\\\"0.01\\\" value=\\\"'+esc(g.base_salary)+'\\\"><h3>Grade earnings & deductions</h3><div id=\\\"gradeComponents\\\">'+components.filter(function(c){return c.is_active}).map(function(c){var a=ga.find(function(x){return x.component_id===c.id});return'<label class=\\\"privilege-item\\\"><input type=\\\"checkbox\\\" data-grade-component=\\\"'+c.id+'\\\"'+(a?' checked':'')+'><span><b>'+esc(c.name)+'</b><small>'+esc(c.component_type)+' · '+esc(c.calculation_type==='percent_basic'?(c.rate_percent+'% of basic'):docMoney(c.default_value,g.currency))+'</small></span></label>'}).join('')+'</div><button id=\\\"saveGrade\\\" class=\\\"primary\\\" style=\\\"width:100%;margin-top:12px\\\">Save grade</button>');if(E('saveGrade'))E('saveGrade').onclick=async function(){await raw('/api/payroll/grades/'+gid,{method:'PATCH',body:JSON.stringify({name:E('gradeName').value,baseSalary:Number(E('gradeBasic').value),currency:g.currency||'GHS'})});var gc=[];E('gradeComponents').querySelectorAll('[data-grade-component]:checked').forEach(function(x){gc.push({componentId:x.dataset.gradeComponent})});await raw('/api/payroll/grades/'+gid+'/components',{method:'PUT',body:JSON.stringify({components:gc})});close();toast('Salary grade updated');page('hr')};return}var id=e.target.dataset.emolument;if(!id)return;var s=staff.find(function(x){return x.id===id}),p=s.payroll_profile||{},assigned=s.payroll_components||[];modal('<h2>Staff Emolument</h2>",
  'salary grade edit handler'
);
ui = requiredReplace(
  ui,
  "<label>Basic salary <span class=\"req\">*</span></label><input id=\"hrBasic\" type=\"number\" min=\"0\" step=\"0.01\" value=\"'+esc(p.base_salary||0)+'\">",
  "<label>Salary grade</label><select id=\"hrGrade\"><option value=\"\">Individual salary</option>'+grades.filter(function(g){return g.is_active}).map(function(g){return'<option value=\\\"'+g.id+'\\\"'+(p.grade_id===g.id?' selected':'')+'>'+esc(g.code+' · '+g.name+' · '+docMoney(g.base_salary,g.currency))+'</option>'}).join('')+'</select><p class=\"muted\">Grade salary and grade deductions are inherited automatically. Keep personal components below for loans and other employee-specific items.</p><label>Individual basic salary <span class=\"req\">*</span></label><input id=\"hrBasic\" type=\"number\" min=\"0\" step=\"0.01\" value=\"'+esc(p.base_salary||0)+'\">",
  'staff salary grade selector'
);
ui = requiredReplace(
  ui,
  "await raw('/api/hr/staff/'+id+'/emolument',{method:'PUT',body:JSON.stringify({baseSalary:base,currency:p.currency||'GHS'",
  "await raw('/api/hr/staff/'+id+'/emolument',{method:'PUT',body:JSON.stringify({baseSalary:base,currency:p.currency||'GHS'",
  'emolument save anchor'
);
// Assign the grade after the staff profile exists.
ui = requiredReplace(
  ui,
  "isActive:true})});var cs=[];",
  "isActive:true})});await raw('/api/hr/staff/'+id+'/grade',{method:'PUT',body:JSON.stringify({gradeId:E('hrGrade').value||null})});var cs=[];",
  'staff grade assignment save'
);

// Payroll register exports are authenticated fetches so they work even when only the
// bearer session token is available.
ui = requiredReplace(
  ui,
  "<div class=\"actions\">'+(r.status==='draft'?'<button id=\"submitPayroll\" class=\"primary\">Submit to Finance</button>':'')",
  "<div class=\"actions\"><button id=\"exportPayrollPdf\" class=\"ghost\">Export PDF</button><button id=\"exportPayrollExcel\" class=\"ghost\">Export Excel</button>'+(r.status==='draft'?'<button id=\"submitPayroll\" class=\"primary\">Submit to Finance</button>':'')",
  'payroll export buttons'
);
ui = requiredReplace(
  ui,
  "if(E('submitPayroll'))E('submitPayroll').onclick=async function(){",
  "async function exportPayroll(format){var res=await fetch('/api/payroll/runs/'+id+'/export?format='+format,{headers:token?{authorization:'Bearer '+token}:{}});if(!res.ok){var er=await res.json().catch(function(){return null});throw Error(er&&er.error&&er.error.message?er.error.message:'Payroll export failed')}var blob=await res.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='payroll-'+r.period_year+'-'+String(r.period_month).padStart(2,'0')+(format==='pdf'?'.pdf':'.xls');a.click();setTimeout(function(){URL.revokeObjectURL(url)},1000)}if(E('exportPayrollPdf'))E('exportPayrollPdf').onclick=function(){exportPayroll('pdf').catch(function(e){toast(e.message,true)})};if(E('exportPayrollExcel'))E('exportPayrollExcel').onclick=function(){exportPayroll('excel').catch(function(e){toast(e.message,true)})};if(E('submitPayroll'))E('submitPayroll').onclick=async function(){",
  'payroll export handlers'
);
await write('apps/school/src/ui.ts', ui);

// -----------------------------------------------------------------------------
// OS login: always enter the Core OS first. Commercial access is role/permission based.
// -----------------------------------------------------------------------------
let osLogin = await read('src/login-ui.ts');
osLogin = osLogin.replace(
  "function save(x){sessionStorage.setItem('rx_access',x.accessToken);sessionStorage.setItem('rx_refresh',x.refreshToken||'');location.replace('/commercial-control')}",
  "function save(x){sessionStorage.setItem('rx_access',x.accessToken);sessionStorage.setItem('rx_refresh',x.refreshToken||'');location.replace('/')}"
);
osLogin = osLogin.replace(
  ".error{background:#fff0f1;color:#a62934}.success{background:#eaf7f0;color:#177448}.hidden{display:none!important}",
  ".error{background:#fff0f1;color:#a62934}.success{background:#eaf7f0;color:#177448}.hidden{display:none!important}.show-pass{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--muted)}.show-pass input{width:auto;margin:0}"
);
osLogin = osLogin.replace(
  "<input id=\"loginPassword\" type=\"password\" autocomplete=\"current-password\"><button id=\"loginBtn\"",
  "<input id=\"loginPassword\" type=\"password\" autocomplete=\"current-password\"><label class=\"show-pass\"><input id=\"showLoginPassword\" type=\"checkbox\"> Show password</label><button id=\"loginBtn\""
);
osLogin = osLogin.replace(
  "<input id=\"registerPassword\" type=\"password\"><p class=\"muted\">",
  "<input id=\"registerPassword\" type=\"password\"><label class=\"show-pass\"><input id=\"showRegisterPassword\" type=\"checkbox\"> Show password</label><p class=\"muted\">"
);
osLogin = osLogin.replace(
  "E('loginPassword').onkeydown=function(e){if(e.key==='Enter')E('loginBtn').click()};",
  "E('showLoginPassword').onchange=function(){E('loginPassword').type=this.checked?'text':'password'};E('showRegisterPassword').onchange=function(){E('registerPassword').type=this.checked?'text':'password'};E('loginPassword').onkeydown=function(e){if(e.key==='Enter')E('loginBtn').click()};"
);
await write('src/login-ui.ts', osLogin);

// Core OS main navigation hides Commercial Control from users without the commercial role.
let osUi = await read('src/ui.ts');
osUi = requiredReplace(
  osUi,
  "data.org=await raw('/v1/organisation');E('org').textContent=data.org.name;\n   E('nav').innerHTML=pages.map(function(p){",
  "data.context=await raw('/v1/auth/context');data.org=await raw('/v1/organisation');E('org').textContent=data.org.name;\n   var visiblePages=pages.filter(function(p){return p[0]!=='commercial-control'||(data.context.permissions||[]).indexOf('commercial.read')>=0});\n   E('nav').innerHTML=visiblePages.map(function(p){",
  'OS permission-aware commercial navigation'
);
await write('src/ui.ts', osUi);

// -----------------------------------------------------------------------------
// OS support API: cross-school admin activity and human-readable School URLs.
// -----------------------------------------------------------------------------
let support = await read('src/routes/commercial-support.ts');
const activitySupport = `
  app.get('/v1/commercial-control/support/admin-activity', async request => {
    const a = requirePermission(request, 'commercial.read');
    const q = z.object({ schoolId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(150) }).parse(request.query);
    const schools = q.schoolId
      ? await safeRows(db, 'SELECT o.id,o.name,o.slug FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id WHERE c.provider_organisation_id=$1 AND c.customer_organisation_id=$2', [a.organisationId,q.schoolId])
      : await safeRows(db, 'SELECT o.id,o.name,o.slug FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id WHERE c.provider_organisation_id=$1 ORDER BY o.name', [a.organisationId]);
    const all:any[]=[];
    for(const school of schools){
      const response=await fetch(schoolBase(config)+'/api/internal/admin-activity?organisationId='+encodeURIComponent(school.id)+'&limit='+Math.min(q.limit,200),{headers:schoolHeaders(config),signal:AbortSignal.timeout(15000)}).catch(()=>null);
      if(!response?.ok)continue;
      const payload=await response.json().catch(()=>null) as any;
      for(const row of payload?.rows||[])all.push({...row,school_id:school.id,school_name:school.name,school_slug:school.slug});
    }
    all.sort((x,y)=>new Date(y.created_at).getTime()-new Date(x.created_at).getTime());
    const ids=[...new Set(all.map(x=>x.actor_os_user_id).filter(Boolean))];
    const users=ids.length?await safeRows(db,'SELECT id,email,first_name,last_name FROM users WHERE id=ANY($1::uuid[])',[ids]):[];
    return all.slice(0,q.limit).map(row=>{const u=users.find((x:any)=>x.id===row.actor_os_user_id);return{...row,actor_name:u?[u.first_name,u.last_name].filter(Boolean).join(' '):null,actor_email:u?.email||null}});
  });
`;
support = insertBefore(support, "  app.get('/v1/commercial-control/support/database-tables', async request => {", activitySupport, 'OS admin activity support route');
support = support.replaceAll("schoolBase(config) + '/admin-password-reset?school=' + encodeURIComponent(org.slug)", "schoolBase(config) + '/s/' + encodeURIComponent(org.slug) + '/admin-password-reset'");
await write('src/routes/commercial-support.ts', support);

let saas = await read('src/routes/saas.ts');
saas = saas.replaceAll("schoolApplicationBase(config) + '/login?school=' + encodeURIComponent(created.organisation.slug)", "schoolApplicationBase(config) + '/s/' + encodeURIComponent(created.organisation.slug) + '/login'");
saas = saas.replaceAll("schoolApplicationBase(config) + '/admin-login?school=' + encodeURIComponent(created.organisation.slug)", "schoolApplicationBase(config) + '/s/' + encodeURIComponent(created.organisation.slug) + '/admin-login'");
saas = saas.replaceAll("schoolApplicationBase(config) + '/admin-password-reset?school=' + encodeURIComponent(created.organisation.slug) + '&token=' + encodeURIComponent(created.setupToken) + '&mode=setup'", "schoolApplicationBase(config) + '/s/' + encodeURIComponent(created.organisation.slug) + '/admin-password-reset?token=' + encodeURIComponent(created.setupToken) + '&mode=setup'");
saas = saas.replaceAll("schoolApplicationBase(config) + '/login?school=' + encodeURIComponent(customer.slug)", "schoolApplicationBase(config) + '/s/' + encodeURIComponent(customer.slug) + '/login'");
saas = saas.replaceAll("schoolApplicationBase(config) + '/admin-login?school=' + encodeURIComponent(customer.slug)", "schoolApplicationBase(config) + '/s/' + encodeURIComponent(customer.slug) + '/admin-login'");
saas = saas.replaceAll("schoolApplicationBase(config)+'/admin-login?school='+encodeURIComponent(customer.slug)", "schoolApplicationBase(config)+'/s/'+encodeURIComponent(customer.slug)+'/admin-login'");
saas = saas.replaceAll("schoolApplicationBase(config)+'/admin-login?school='+encodeURIComponent(org.slug)", "schoolApplicationBase(config)+'/s/'+encodeURIComponent(org.slug)+'/admin-login'");
saas = saas.replaceAll("schoolApplicationBase(config)+'/admin-password-reset?school='+encodeURIComponent(org.slug)+'&token='+encodeURIComponent(resetToken)", "schoolApplicationBase(config)+'/s/'+encodeURIComponent(org.slug)+'/admin-password-reset?token='+encodeURIComponent(resetToken)");
await write('src/routes/saas.ts', saas);

// Commercial Control gets an explicit Admin Activity workspace and clearer plan cards.
let commercialUi = await read('src/commercial-control2-ui.ts');
commercialUi = commercialUi.replace('<button data-page="plans">Plans & Modules</button>', '<button data-page="plans">Plans & Modules</button>\n<button data-page="activity">Admin Activity</button>');
commercialUi = commercialUi.replace(
  '.module-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border-bottom:1px solid #edf1f5;padding:9px 0}.pillbox{display:flex;gap:8px;flex-wrap:wrap}',
  '.module-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border-bottom:1px solid #edf1f5;padding:9px 0}.pillbox{display:flex;gap:8px;flex-wrap:wrap}.plan-card{position:relative;border-top:4px solid var(--blue);min-height:210px}.plan-card.basic{border-top-color:var(--green)}.plan-tag{display:inline-flex;background:#eaf7f0;color:#147a4d;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;margin-bottom:8px}.module-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}.module-chips span{font-size:10px;background:#eef5ff;color:#315b88;padding:4px 7px;border-radius:999px}'
);
commercialUi = commercialUi.replace(
  "return '<div class=\"card\"><h3>'+esc(p.name)+'</h3><b>'+money(p.monthly_price,p.currency)+'/month</b><p class=\"sub\">'+esc(p.description||'')+'</p><div class=\"sub\">'+esc(p.student_limit||'∞')+' students · '+esc(p.staff_limit||'∞')+' staff · '+esc(p.campus_limit||'∞')+' campuses</div><div class=\"actions\" style=\"margin-top:10px\"><button class=\"mini\" data-edit-plan=\"'+p.id+'\">Edit Plan</button><button class=\"mini\" data-mod-plan=\"'+p.id+'\">Plan Modules</button></div></div>'",
  "return '<div class=\"card plan-card '+(p.plan_key==='basic'?'basic':'')+'\">'+(p.plan_key==='basic'?'<span class=\"plan-tag\">BASE PLAN</span>':'')+'<h3>'+esc(p.name)+'</h3><b>'+money(p.monthly_price,p.currency)+'/month</b><p class=\"sub\">'+esc(p.description||'')+'</p><div class=\"sub\">'+esc(p.student_limit||'∞')+' students · '+esc(p.staff_limit||'∞')+' staff · '+esc(p.campus_limit||'∞')+' campuses</div><div class=\"module-chips\">'+(p.modules||[]).slice(0,6).map(function(k){var m=modules.find(function(x){return x.module_key===k});return'<span>'+esc(m?m.name:k.replace('school.',''))+'</span>'}).join('')+((p.modules||[]).length>6?'<span>+'+((p.modules||[]).length-6)+' more</span>':'')+'</div><div class=\"actions\" style=\"margin-top:12px\"><button class=\"mini\" data-edit-plan=\"'+p.id+'\">Edit Plan</button><button class=\"mini\" data-mod-plan=\"'+p.id+'\">Plan Modules</button></div></div>'"
);
const activityPage = `async function activityPage(){E('title').textContent='School Admin Activity';var opts='<option value="">All managed schools</option>'+schools.map(function(s){return'<option value="'+s.id+'">'+esc(s.name)+'</option>'}).join('');E('content').innerHTML='<div class="panel"><div class="toolbar"><select id="activitySchool">'+opts+'</select><button class="btn primary" id="loadActivity">Load activity</button></div><div id="activityRows" class="empty">Choose a school or load all managed schools.</div></div>';async function load(){var id=E('activitySchool').value,q=id?'?schoolId='+encodeURIComponent(id)+'&limit=150':'?limit=150',rows=await raw('/v1/commercial-control/support/admin-activity'+q);E('activityRows').innerHTML=table(rows,[{key:'created_at',label:'Time',render:function(r){return fmt(r.created_at)}},{key:'school_name',label:'School'},{key:'actor_name',label:'Administrator',render:function(r){return esc(r.actor_name||r.actor_email||r.actor_os_user_id||'System')}},{key:'action',render:function(r){return esc(String(r.action||'').replace(/[._]/g,' '))}},{key:'resource_type',label:'Resource'},{key:'resource_id',label:'Record'}])}E('loadActivity').onclick=function(){load().catch(function(e){toast(e.message,true)})};await load()}
`;
commercialUi = requiredReplace(commercialUi, "async function billingPage(){", activityPage + "async function billingPage(){", 'commercial admin activity page');
commercialUi = commercialUi.replace("else if(p==='plans')plansPage();else if(p==='billing')", "else if(p==='plans')plansPage();else if(p==='activity')await activityPage();else if(p==='billing')");
commercialUi = commercialUi.replace(
  "async function loadBase(){if(!token){location.href='/login';return false}catalog=await raw('/v1/commercial-control/catalog');schools=await raw('/v1/commercial-control/schools');return true}",
  "async function loadBase(){if(!token){location.href='/login';return false}var context=await raw('/v1/auth/context');if((context.permissions||[]).indexOf('commercial.read')<0){location.href='/';return false}catalog=await raw('/v1/commercial-control/catalog');schools=await raw('/v1/commercial-control/schools');return true}"
);
await write('src/commercial-control2-ui.ts', commercialUi);

// -----------------------------------------------------------------------------
// Build cleanup: the source is now authoritative. Build-time source mutation is removed.
// -----------------------------------------------------------------------------
const schoolPackage = JSON.parse(await read('apps/school/package.json'));
schoolPackage.scripts.build = 'tsc -p tsconfig.json && node scripts/validate-frontends.mjs && node --test test/*.smoke.mjs';
await write('apps/school/package.json', JSON.stringify(schoolPackage, null, 2) + '\n');

const obsoleteSchoolScripts = [
  'apps/school/scripts/patch-grade-levels.mjs',
  'apps/school/scripts/patch-academic-manager-inline-subjects.mjs',
  'apps/school/scripts/patch-admission-grade-flow.mjs',
  'apps/school/scripts/patch-assessment-score-readiness.mjs',
  'apps/school/scripts/patch-exercise-exam-flow-minimal.mjs',
  'apps/school/scripts/retire-reserved-module-placeholders-20261011.mjs',
  'apps/school/scripts/patch-full-remediation-20261011.mjs',
  'apps/school/scripts/finalize-full-remediation-20261011.mjs',
  'apps/school/scripts/patch-remediation-compile-fix.mjs',
  'apps/school/scripts/patch-final-audit-20261011.mjs'
];
for (const rel of obsoleteSchoolScripts) await rm(path(rel), { force: true });
await rm(path('src/demo-login-ui.ts'), { force: true });

// This materializer and its temporary workflow remove themselves. Final builds contain
// only normal source, migrations, tests and documentation.
await rm(path('.github/workflows/commercial-launch-cleanup.yml'), { force: true });
await rm(path('scripts/commercial-launch-cleanup.mjs'), { force: true });

console.log('Commercial launch cleanup materialized successfully');
