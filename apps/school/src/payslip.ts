import {createRequire} from 'node:module';
const PDFDocument:any=createRequire(import.meta.url)('pdfkit');

/** The caller must authorize ownership and paid/publication state before rendering. */
export async function renderStaffPayslip(school:any,item:any,components:any[]):Promise<Buffer>{
  const doc=new PDFDocument({size:'A4',margin:44}),chunks:Buffer[]=[];
  doc.on('data',(chunk:Buffer)=>chunks.push(chunk));
  const done=new Promise<Buffer>((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
  const money=(value:any)=>String(item.currency||'GHS')+' '+Number(value||0).toFixed(2);
  doc.fontSize(20).text(school.school_name||'School',{align:'center'});
  doc.fontSize(13).text('STAFF PAYSLIP',{align:'center'}).moveDown();
  doc.fontSize(11).text('Period: '+item.period_year+'-'+String(item.period_month).padStart(2,'0'));
  doc.text('Staff: '+item.staff_name).text('Staff ID: '+(item.staff_id||'—'));
  if(item.salary_grade_name)doc.text('Salary Grade: '+(item.salary_grade_code||'')+' '+item.salary_grade_name);
  doc.text('Payment date: '+String(item.payment_date||item.paid_at||'').slice(0,10));
  if(item.payment_reference)doc.text('Payment reference: '+item.payment_reference);
  for(const type of ['earning','deduction']){
    doc.moveDown().fontSize(13).text(type==='earning'?'EARNINGS':'DEDUCTIONS');
    const rows=components.filter(c=>c.component_type===type);
    if(!rows.length)doc.fontSize(10).text('None');
    for(const row of rows)doc.fontSize(10).text(row.name+' ('+row.code+'): '+money(row.amount));
  }
  doc.moveDown().fontSize(12).text('Gross earnings: '+money(item.gross_earnings));
  doc.text('Total deductions: '+money(item.total_deductions));doc.fontSize(15).text('NET PAY: '+money(item.net_pay));
  doc.moveDown().fontSize(9).text('Paid by Finance and published by HR. This payslip is a record of the payroll payment entered by your school.');
  doc.end();return done;
}
