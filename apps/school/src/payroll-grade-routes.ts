import { createRequire } from 'node:module';
import { z } from 'zod';

const require=createRequire(import.meta.url);
const PDFDocument:any=require('pdfkit');

/**
 * Payroll grade and export routes.
 *
 * Grade rules are evaluated when payroll is calculated. We deliberately do not copy a grade's
 * salary package into every staff row, because copied values drift when a grade changes. Instead:
 *   1. a staff member references one payroll grade;
 *   2. grade components apply to everyone on that grade;
 *   3. personal component assignments override the same grade component when present;
 *   4. truly personal items (loan, salary advance, special allowance) stay on the staff record.
 */
export async function registerPayrollGradeRoutes(app:any,deps:any){
  const {db,config,authorize,maybeOne,one,tx,fail,audit}=deps;

  async function requireCapability(a:any,key:string){
    if(a.role==='school_admin')return;
    const row=await maybeOne(db,'SELECT allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND capability_key=$3',[a.core.organisation_id,a.role,key]);
    if(!row?.allowed)throw fail(403,'Your School role does not have permission to perform this payroll action');
  }

  app.get('/api/payroll/grades',async(request:any)=>{
    const a=await authorize(request,db,config);await requireCapability(a,'payroll.view');
    const grades=(await db.query('SELECT * FROM payroll_grades WHERE organisation_id=$1 ORDER BY code,name',[a.core.organisation_id])).rows;
    const components=(await db.query(`SELECT gc.*,c.code component_code,c.name component_name,c.component_type,c.calculation_type,c.default_value,c.rate_percent
      FROM payroll_grade_components gc JOIN payroll_components c ON c.id=gc.component_id
      WHERE gc.organisation_id=$1 ORDER BY c.component_type,c.name`,[a.core.organisation_id])).rows;
    return grades.map((g:any)=>({...g,components:components.filter((c:any)=>c.payroll_grade_id===g.id)}));
  });

  app.post('/api/payroll/grades',async(request:any,reply:any)=>{
    const a=await authorize(request,db,config);await requireCapability(a,'payroll.manage');
    const b=z.object({code:z.string().trim().min(1).max(40),name:z.string().trim().min(2).max(160),description:z.string().trim().max(1000).nullable().optional(),baseSalary:z.coerce.number().min(0),currency:z.string().trim().min(3).max(10).default('GHS')}).parse(request.body);
    const row=await one(db,`INSERT INTO payroll_grades(organisation_id,code,name,description,base_salary,currency,created_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[a.core.organisation_id,b.code.toUpperCase(),b.name,b.description??null,b.baseSalary,b.currency.toUpperCase(),a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_created','payroll_grade',row.id,{code:row.code,name:row.name,baseSalary:row.base_salary});
    return reply.code(201).send(row);
  });

  app.patch('/api/payroll/grades/:id',async(request:any)=>{
    const a=await authorize(request,db,config);await requireCapability(a,'payroll.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),description:z.string().trim().max(1000).nullable().optional(),baseSalary:z.coerce.number().min(0).optional(),currency:z.string().trim().min(3).max(10).optional(),isActive:z.boolean().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);
    const before=await one(db,'SELECT * FROM payroll_grades WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const row=await one(db,`UPDATE payroll_grades SET name=COALESCE($1,name),description=CASE WHEN $2 THEN $3 ELSE description END,
      base_salary=COALESCE($4,base_salary),currency=COALESCE($5,currency),is_active=COALESCE($6,is_active),updated_at=now()
      WHERE id=$7 AND organisation_id=$8 RETURNING *`,[b.name??null,Object.hasOwn(b,'description'),b.description??null,b.baseSalary??null,b.currency?.toUpperCase()??null,b.isActive??null,id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_updated','payroll_grade',id,{before,after:row});return row;
  });

  app.put('/api/payroll/grades/:id/components',async(request:any)=>{
    const a=await authorize(request,db,config);await requireCapability(a,'payroll.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({components:z.array(z.object({componentId:z.string().uuid(),valueOverride:z.coerce.number().min(0).nullable().optional(),rateOverride:z.coerce.number().min(0).max(100).nullable().optional(),isActive:z.boolean().default(true)})).max(100)}).parse(request.body);
    if(!await maybeOne(db,'SELECT 1 FROM payroll_grades WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]))throw fail(404,'Payroll grade was not found');
    await tx(db,async(client:any)=>{
      await client.query('DELETE FROM payroll_grade_components WHERE organisation_id=$1 AND payroll_grade_id=$2',[a.core.organisation_id,id]);
      for(const item of b.components){
        await client.query(`INSERT INTO payroll_grade_components(organisation_id,payroll_grade_id,component_id,value_override,rate_override,is_active,created_by_os_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.core.organisation_id,id,item.componentId,item.valueOverride??null,item.rateOverride??null,item.isActive,a.core.id]);
      }
    });
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_components_updated','payroll_grade',id,{count:b.components.length});
    return{saved:b.components.length};
  });

  app.put('/api/hr/staff/:userId/payroll-grade',async(request:any)=>{
    const a=await authorize(request,db,config);await requireCapability(a,'payroll.manage');
    const {userId}=z.object({userId:z.string().uuid()}).parse(request.params);
    const b=z.object({payrollGradeId:z.string().uuid().nullable(),useGradeSalary:z.boolean().default(true)}).parse(request.body);
    if(b.payrollGradeId&&!await maybeOne(db,'SELECT 1 FROM payroll_grades WHERE id=$1 AND organisation_id=$2 AND is_active=true',[b.payrollGradeId,a.core.organisation_id]))throw fail(400,'Choose an active payroll grade from this School');
    const row=await one(db,`INSERT INTO staff_payroll_profiles(organisation_id,os_user_id,base_salary,currency,payroll_grade_id,use_grade_salary,updated_by_os_user_id)
      VALUES($1,$2,0,'GHS',$3,$4,$5)
      ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET payroll_grade_id=EXCLUDED.payroll_grade_id,use_grade_salary=EXCLUDED.use_grade_salary,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now()
      RETURNING *`,[a.core.organisation_id,userId,b.payrollGradeId,b.useGradeSalary,a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.staff_grade_assigned','staff_payroll_profile',row.id,{staff:userId,payrollGradeId:b.payrollGradeId,useGradeSalary:b.useGradeSalary});return row;
  });

  function csv(value:any){const s=String(value??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
  function money(value:any){return Number(value||0).toFixed(2)}
  function monthName(month:number){return new Date(Date.UTC(2020,month-1,1)).toLocaleString('en',{month:'long',timeZone:'UTC'})}

  async function ownPayroll(a:any,year:number,month:number){
    const item=await maybeOne(db,`SELECT pri.*,pr.period_year,pr.period_month,pr.status,pr.paid_at,pr.currency
      FROM payroll_run_items pri JOIN payroll_runs pr ON pr.id=pri.payroll_run_id
      WHERE pri.organisation_id=$1 AND pri.os_user_id=$2 AND pr.period_year=$3 AND pr.period_month=$4
        AND pr.status IN('submitted_to_finance','approved_for_payment','paid')
      ORDER BY pr.created_at DESC LIMIT 1`,[a.core.organisation_id,a.core.id,year,month]);
    if(!item)throw fail(404,'No payroll was found for the selected month and year');
    const components=(await db.query(`SELECT code,name,component_type,amount,taxable,statutory
      FROM payroll_run_item_components WHERE payroll_run_item_id=$1 ORDER BY component_type,name`,[item.id])).rows;
    return{item,components};
  }

  app.get('/api/payroll/me/periods',async(request:any)=>{
    const a=await authorize(request,db,config);
    return (await db.query(`SELECT DISTINCT pr.period_year,pr.period_month,pr.status
      FROM payroll_run_items pri JOIN payroll_runs pr ON pr.id=pri.payroll_run_id
      WHERE pri.organisation_id=$1 AND pri.os_user_id=$2 AND pr.status IN('submitted_to_finance','approved_for_payment','paid')
      ORDER BY pr.period_year DESC,pr.period_month DESC`,[a.core.organisation_id,a.core.id])).rows;
  });

  app.get('/api/payroll/me/export',async(request:any,reply:any)=>{
    const a=await authorize(request,db,config);
    const q=z.object({year:z.coerce.number().int().min(2000).max(2200),month:z.coerce.number().int().min(1).max(12),format:z.enum(['pdf','excel']).default('pdf')}).parse(request.query);
    const {item,components}=await ownPayroll(a,q.year,q.month),period=`${monthName(q.month)} ${q.year}`;

    if(q.format==='excel'){
      const rows=[['Period',period],['Staff',item.staff_name],['Staff ID',item.staff_id||''],['Status',item.status],[],['Component','Type','Amount']];
      for(const c of components)rows.push([c.name,c.component_type,money(c.amount)]);
      rows.push([],['Basic Salary','',money(item.base_salary)],['Gross Earnings','',money(item.gross_earnings)],['Total Deductions','',money(item.total_deductions)],['Net Pay','',money(item.net_pay)]);
      const body=rows.map(r=>r.map(csv).join(',')).join('\n');
      return reply.header('content-type','application/vnd.ms-excel; charset=utf-8').header('content-disposition',`attachment; filename="payslip-${q.year}-${String(q.month).padStart(2,'0')}.csv"`).send(body);
    }

    const chunks:Buffer[]=[];const doc=new PDFDocument({size:'A4',margin:48});doc.on('data',(c:Buffer)=>chunks.push(c));
    const done=new Promise<Buffer>(resolve=>doc.on('end',()=>resolve(Buffer.concat(chunks))));
    doc.fontSize(20).text('Revolt-X School Payslip',{align:'center'}).moveDown(.3);
    doc.fontSize(11).text(period,{align:'center'}).moveDown(1.5);
    doc.fontSize(11).text(`Staff: ${item.staff_name}`).text(`Staff ID: ${item.staff_id||'—'}`).text(`Payroll status: ${String(item.status).replace(/_/g,' ')}`).moveDown();
    doc.fontSize(12).text('Earnings & Deductions',{underline:true}).moveDown(.5);
    for(const c of components)doc.fontSize(10).text(`${c.name} (${c.component_type}): ${item.currency||'GHS'} ${money(c.amount)}`);
    doc.moveDown().fontSize(11).text(`Basic Salary: ${item.currency||'GHS'} ${money(item.base_salary)}`).text(`Gross Earnings: ${item.currency||'GHS'} ${money(item.gross_earnings)}`).text(`Total Deductions: ${item.currency||'GHS'} ${money(item.total_deductions)}`).fontSize(14).text(`Net Pay: ${item.currency||'GHS'} ${money(item.net_pay)}`,{underline:true});
    doc.end();const pdf=await done;
    return reply.header('content-type','application/pdf').header('content-disposition',`attachment; filename="payslip-${q.year}-${String(q.month).padStart(2,'0')}.pdf"`).send(pdf);
  });

  app.get('/api/payroll/runs/:id/export',async(request:any,reply:any)=>{
    const a=await authorize(request,db,config);await requireCapability(a,'payroll.view');
    const p=z.object({id:z.string().uuid()}).parse(request.params);const q=z.object({format:z.enum(['pdf','excel']).default('excel')}).parse(request.query);
    const run=await one(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[p.id,a.core.organisation_id]);
    const items=(await db.query('SELECT * FROM payroll_run_items WHERE payroll_run_id=$1 AND organisation_id=$2 ORDER BY staff_name',[p.id,a.core.organisation_id])).rows;
    if(q.format==='excel'){
      const rows=[['Staff ID','Staff','Basic Salary','Gross Earnings','Deductions','Net Pay','Status'],...items.map((i:any)=>[i.staff_id||'',i.staff_name,money(i.base_salary),money(i.gross_earnings),money(i.total_deductions),money(i.net_pay),run.status])];
      const body=rows.map((r:any[])=>r.map(csv).join(',')).join('\n');
      return reply.header('content-type','application/vnd.ms-excel; charset=utf-8').header('content-disposition',`attachment; filename="payroll-${run.period_year}-${String(run.period_month).padStart(2,'0')}.csv"`).send(body);
    }
    const chunks:Buffer[]=[];const doc=new PDFDocument({size:'A4',layout:'landscape',margin:36});doc.on('data',(c:Buffer)=>chunks.push(c));const done=new Promise<Buffer>(resolve=>doc.on('end',()=>resolve(Buffer.concat(chunks))));
    doc.fontSize(18).text(`Payroll Register - ${monthName(Number(run.period_month))} ${run.period_year}`,{align:'center'}).moveDown();
    doc.fontSize(9);for(const i of items)doc.text(`${i.staff_id||'—'} | ${i.staff_name} | Basic ${money(i.base_salary)} | Gross ${money(i.gross_earnings)} | Ded ${money(i.total_deductions)} | Net ${money(i.net_pay)}`);
    doc.moveDown().fontSize(11).text(`Gross total: ${run.currency} ${money(run.gross_total)}   Deductions: ${run.currency} ${money(run.deductions_total)}   Net: ${run.currency} ${money(run.net_total)}`);
    doc.end();const pdf=await done;return reply.header('content-type','application/pdf').header('content-disposition',`attachment; filename="payroll-${run.period_year}-${String(run.period_month).padStart(2,'0')}.pdf"`).send(pdf);
  });
}
