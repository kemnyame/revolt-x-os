import {z} from 'zod';
import {createRequire} from 'node:module';
import {schoolRecordId} from './record-id.js';
import {reportCsv} from './operations-reports.js';
const PDFDocument:any=createRequire(import.meta.url)('pdfkit');

/** Payments are aggregated before charges are joined, preventing duplicate
 * enrolments/guardians from multiplying balances. Waivers and reversals are
 * handled in the ledger; available deposits are shown separately from bills. */
export const outstandingFeeSql=`WITH paid AS (
 SELECT student_fee_id,sum(amount) amount FROM payments WHERE organisation_id=$1 AND voided_at IS NULL GROUP BY student_fee_id
), charges AS (
 SELECT sf.id,sf.student_id,fi.name fee_name,y.name academic_year,t.name term,
  sf.amount_due-sf.discount billed,COALESCE(p.amount,0) paid,
  GREATEST(0,sf.amount_due-sf.discount-COALESCE(p.amount,0)) balance,sf.created_at
 FROM student_fees sf JOIN fee_items fi ON fi.id=sf.fee_item_id AND fi.organisation_id=sf.organisation_id
 JOIN academic_years y ON y.id=fi.academic_year_id LEFT JOIN terms t ON t.id=fi.term_id
 LEFT JOIN paid p ON p.student_fee_id=sf.id
 WHERE sf.organisation_id=$1 AND sf.status<>'waived' AND ($2::uuid IS NULL OR fi.academic_year_id=$2)
 AND ($3::uuid IS NULL OR fi.term_id=$3)
), credits AS (
 SELECT student_id,sum(balance) amount FROM student_account_credits WHERE organisation_id=$1 AND status='open' GROUP BY student_id
), debtors AS (
 SELECT s.id,s.admission_no,concat_ws(' ',s.first_name,s.middle_name,s.last_name) student,s.status student_status,
  cls.id classroom_id,COALESCE(cls.name,'Unassigned') class,guardian.name guardian,guardian.phone,
  sum(c.billed) billed,sum(c.paid) paid,sum(c.balance) unpaid_fees,COALESCE(cr.amount,0) available_credit,
  GREATEST(0,sum(c.balance)-COALESCE(cr.amount,0)) amount_owing,
  jsonb_agg(jsonb_build_object('id',c.id,'fee',c.fee_name,'academic_year',c.academic_year,'term',c.term,'billed',c.billed,'paid',c.paid,'balance',c.balance) ORDER BY c.created_at,c.fee_name) fees
 FROM students s JOIN charges c ON c.student_id=s.id LEFT JOIN credits cr ON cr.student_id=s.id
 LEFT JOIN LATERAL(SELECT cl.id,cl.name FROM enrolments e JOIN classrooms cl ON cl.id=e.classroom_id AND cl.organisation_id=e.organisation_id
  JOIN academic_years ay ON ay.id=e.academic_year_id WHERE e.student_id=s.id AND e.organisation_id=$1 AND ($2::uuid IS NULL OR e.academic_year_id=$2)
  ORDER BY (e.status='active') DESC,(ay.status='active') DESC,ay.start_date DESC,e.enrolled_at DESC LIMIT 1) cls ON true
 LEFT JOIN LATERAL(SELECT concat_ws(' ',g.first_name,g.last_name) name,g.phone FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id AND g.organisation_id=s.organisation_id
  WHERE sg.student_id=s.id ORDER BY sg.is_primary DESC,g.created_at LIMIT 1) guardian ON true
 WHERE s.organisation_id=$1 GROUP BY s.id,cls.id,cls.name,guardian.name,guardian.phone,cr.amount
 HAVING GREATEST(0,sum(c.balance)-COALESCE(cr.amount,0))>0
) `;

export async function registerOutstandingFees(app:any,d:any){
 const {db,config,authorize,fail}=d;
 const schema=z.object({academicYearId:schoolRecordId.optional(),termId:schoolRecordId.optional(),classroomId:schoolRecordId.optional(),studentId:schoolRecordId.optional(),q:z.string().trim().max(120).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(5).max(100).default(10),format:z.enum(['json','csv','pdf']).default('json')});
 app.get('/api/fees/outstanding',async(request:any,reply:any)=>{
  const a=await authorize(request,db,config,'fees.view'),q=schema.parse(request.query);
  const params:any[]=[a.core.organisation_id,q.academicYearId??null,q.termId??null,q.classroomId??null,q.studentId??null,(q.q||'').split(/\s+/).filter(Boolean)];
  const filter=`($4::uuid IS NULL OR classroom_id=$4) AND ($5::uuid IS NULL OR id=$5) AND NOT EXISTS(SELECT 1 FROM unnest($6::text[]) word WHERE concat_ws(' ',student,admission_no,class,guardian,phone,student_status) NOT ILIKE '%'||word||'%')`;
  const summary=(await db.query(outstandingFeeSql+'SELECT count(*)::int students,COALESCE(sum(amount_owing),0) amount_owing,COALESCE(sum(unpaid_fees),0) unpaid_fees,COALESCE(sum(available_credit),0) available_credit FROM debtors WHERE '+filter,params)).rows[0];
  if(q.format!=='json'&&summary.students>50000)throw fail(400,'Narrow the class, term or search filters before exporting more than 50,000 students');
  const page=Math.min(q.page,Math.max(1,Math.ceil(summary.students/q.pageSize))),limit=q.format==='json'?q.pageSize:Math.max(1,summary.students),offset=q.format==='json'?(page-1)*limit:0;
  const rows=(await db.query(outstandingFeeSql+'SELECT * FROM debtors WHERE '+filter+' ORDER BY amount_owing DESC,student,id LIMIT $7 OFFSET $8',[...params,limit,offset])).rows;
  const columns=['admission_no','student','class','guardian','phone','billed','paid','unpaid_fees','available_credit','amount_owing'];
  if(q.format==='csv')return reply.header('content-disposition','attachment; filename="students-owing.csv"').type('text/csv; charset=utf-8').send(reportCsv([...columns,'fee_details'],rows.map((r:any)=>({...r,fee_details:r.fees.map((f:any)=>f.fee+' ('+f.academic_year+', '+(f.term||'Year')+'): billed '+f.billed+', paid '+f.paid+', balance '+f.balance).join('; ')}))));
  if(q.format==='pdf'){
   const doc=new PDFDocument({size:'A4',layout:'landscape',margin:30}),chunks:Buffer[]=[];doc.on('data',(c:Buffer)=>chunks.push(c));const done=new Promise<Buffer>((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
   const profile=(await db.query('SELECT school_name,currency FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id])).rows[0]||{};
   doc.fontSize(18).text(profile.school_name||'School').fontSize(13).text('Students owing · '+summary.students+' students · '+(profile.currency||'GHS')+' '+Number(summary.amount_owing).toFixed(2)).moveDown();
   for(const r of rows){if(doc.y>450)doc.addPage();doc.fontSize(11).text(r.student+' · '+r.admission_no+' · '+r.class).fontSize(9).text('Guardian: '+(r.guardian||'—')+' · '+(r.phone||'—')).text('Unpaid fees '+Number(r.unpaid_fees).toFixed(2)+' | Available credit '+Number(r.available_credit).toFixed(2)+' | Amount owing '+Number(r.amount_owing).toFixed(2));for(const fee of r.fees)if(Number(fee.balance)>0)doc.text(fee.fee+' · '+fee.academic_year+' · '+(fee.term||'Whole year')+' | Billed '+fee.billed+' | Paid '+fee.paid+' | Balance '+fee.balance);doc.moveDown()}
   doc.end();return reply.header('content-disposition','attachment; filename="students-owing.pdf"').type('application/pdf').send(await done);
  }
  return{rows,summary,page,pages:Math.max(1,Math.ceil(summary.students/q.pageSize)),pageSize:q.pageSize};
 });
}
