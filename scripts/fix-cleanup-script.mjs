import { readFile, writeFile } from 'node:fs/promises';

const file=new URL('./commercial-launch-cleanup.mjs',import.meta.url);
let src=await readFile(file,'utf8');

// The HR response keeps payroll_profile on the same source line as staff_id. Make the
// cleanup replacement start at the field name instead of depending on line indentation.
src=src.replace(
  '  "        payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,\\n        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};",',
  '  "payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,\\n        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};",'
).replace(
  '  "        payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,\\n        payroll_grade:(()=>{const p=profiles.find((x:any)=>x.os_user_id===m.os_user_id);return p?.grade_id?grades.find((g:any)=>g.id===p.grade_id)||null:null})(),\\n        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};",',
  '  "payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,\\n        payroll_grade:(()=>{const p=profiles.find((x:any)=>x.os_user_id===m.os_user_id);return p?.grade_id?grades.find((g:any)=>g.id===p.grade_id)||null:null})(),\\n        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};",'
);

// Avoid a regex literal inside the generated HTML template. Template-string escape
// processing can strip the regex's slash escapes, so parse /s/<school>/... using path
// segments instead. It is simpler and produces valid browser JavaScript.
src=src.replace(
  `  "pathSchool=(location.pathname.match(/^\\\\/s\\\\/([^/]+)\\\\//)||[])[1]||'',requested=decodeURIComponent(pathSchool||new URLSearchParams(location.search).get('school')||''),saved='';"`,
  `  "pathParts=location.pathname.split('/').filter(Boolean),pathSchool=pathParts[0]==='s'?(pathParts[1]||''):'',requested=decodeURIComponent(pathSchool||new URLSearchParams(location.search).get('school')||''),saved='';"`
);

const start=src.indexOf('const exportRoute = `');
const endMarker="payroll = insertBefore(payroll, \"  app.get('/api/payroll/me',async(request:any)=>{\", exportRoute, 'payroll export route');";
const end=src.indexOf(endMarker,start);
if(start<0||end<0)throw new Error('Could not locate exportRoute materializer block');

const replacement=String.raw`const exportRoute = [
"  app.get('/api/payroll/runs/:id/export',async(request:any,reply:any)=>{",
"    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');",
"    const {id}=z.object({id:z.string().uuid()}).parse(request.params);",
"    const q=z.object({format:z.enum(['pdf','excel']).default('pdf')}).parse(request.query);",
"    const run=await one(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);",
"    const items=(await db.query('SELECT * FROM payroll_run_items WHERE payroll_run_id=$1 AND organisation_id=$2 ORDER BY staff_name',[id,a.core.organisation_id])).rows;",
"    const period=String(run.period_year)+'-'+String(run.period_month).padStart(2,'0');",
"    if(q.format==='excel'){",
"      const escXml=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');",
"      const rows=items.map((r:any)=>'<tr><td>'+escXml(r.staff_id)+'</td><td>'+escXml(r.staff_name)+'</td><td>'+Number(r.base_salary).toFixed(2)+'</td><td>'+Number(r.gross_earnings).toFixed(2)+'</td><td>'+Number(r.total_deductions).toFixed(2)+'</td><td>'+Number(r.net_pay).toFixed(2)+'</td></tr>').join('');",
"      const html='<html><head><meta charset=\"utf-8\"></head><body><table border=\"1\"><tr><th colspan=\"6\">Revolt-X School Payroll '+period+'</th></tr><tr><th>Staff ID</th><th>Staff</th><th>Basic</th><th>Gross</th><th>Deductions</th><th>Net Pay</th></tr>'+rows+'<tr><th colspan=\"3\">Totals</th><th>'+Number(run.gross_total).toFixed(2)+'</th><th>'+Number(run.deductions_total).toFixed(2)+'</th><th>'+Number(run.net_total).toFixed(2)+'</th></tr></table></body></html>';",
"      return reply.header('content-disposition','attachment; filename=\"payroll-'+period+'.xls\"').type('application/vnd.ms-excel; charset=utf-8').send(html);",
"    }",
"    const chunks:Buffer[]=[];const doc=new PDFDocument({size:'A4',margin:36});doc.on('data',(c:Buffer)=>chunks.push(c));const done=new Promise<Buffer>((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});",
"    doc.fontSize(18).text('Revolt-X School Payroll',{align:'center'});doc.fontSize(11).text('Period: '+period+'   Status: '+String(run.status).replace(/_/g,' '),{align:'center'});doc.moveDown();",
"    doc.fontSize(9);for(const r of items){doc.text((r.staff_id||'—')+'  '+r.staff_name+' | Basic '+Number(r.base_salary).toFixed(2)+' | Gross '+Number(r.gross_earnings).toFixed(2)+' | Deductions '+Number(r.total_deductions).toFixed(2)+' | Net '+Number(r.net_pay).toFixed(2));if(doc.y>760)doc.addPage()}",
"    doc.moveDown().fontSize(11).text('Totals: Gross '+Number(run.gross_total).toFixed(2)+' | Deductions '+Number(run.deductions_total).toFixed(2)+' | Net '+Number(run.net_total).toFixed(2));doc.end();",
"    const pdf=await done;return reply.header('content-disposition','attachment; filename=\"payroll-'+period+'.pdf\"').type('application/pdf').send(pdf);",
"  });"
].join('\n');
payroll = insertBefore(payroll, "  app.get('/api/payroll/me',async(request:any)=>{", exportRoute, 'payroll export route');`;

src=src.slice(0,start)+replacement+src.slice(end+endMarker.length);
// hr-payroll-routes receives its helpers through deps:any. Generic calls on those
// dynamically supplied helpers are rejected by TypeScript once the old compile-fix
// patch is removed, so generated commercial routes must use the same non-generic style
// as the materialized production source.
src=src.replaceAll('one<any>(', 'one(').replaceAll('maybeOne<any>(', 'maybeOne(');
// The payroll register export helper may be emitted into a conditional branch in the
// legacy UI source. Use an async function expression (a valid single statement) instead
// of a block-scoped async function declaration, then terminate it before binding buttons.
src=src.replaceAll('async function exportPayroll(format){','var exportPayroll=async function(format){');
src=src.replaceAll("setTimeout(function(){URL.revokeObjectURL(url)},1000)}if(E('exportPayrollPdf'))", "setTimeout(function(){URL.revokeObjectURL(url)},1000)};if(E('exportPayrollPdf'))");
await writeFile(file,src);
console.log('Repaired commercial launch cleanup materializer');
