import { schoolRecordId } from './record-id.js';
import { z } from 'zod';

export async function registerSchoolRemediationRoutes(app:any,deps:any){
  const {db,config,authorize,one,maybeOne,tx,fail,audit,assignMandatoryFees}=deps;

  app.post('/api/promotions/manual',async(request:any)=>{
    const a=await authorize(request,db,config,'promotion.manage');
    const b=z.object({
      studentId:schoolRecordId,
      fromAcademicYearId:schoolRecordId,
      toAcademicYearId:schoolRecordId,
      toClassroomId:schoolRecordId.nullable().optional(),
      outcome:z.enum(['promoted','repeated','completed']),
      reason:z.string().trim().min(5).max(1000)
    }).parse(request.body);
    if(b.fromAcademicYearId===b.toAcademicYearId)throw fail(400,'The source and destination academic years must be different');
    if(b.outcome!=='completed'&&!b.toClassroomId)throw fail(400,'Choose the destination class for a promoted or repeated student');

    const result=await tx(db,async(client:any)=>{
      const current=await maybeOne(client,`SELECT e.*,c.name classroom_name
        FROM enrolments e JOIN classrooms c ON c.id=e.classroom_id
        WHERE e.organisation_id=$1 AND e.student_id=$2 AND e.academic_year_id=$3 AND e.status='active'`,[a.core.organisation_id,b.studentId,b.fromAcademicYearId]);
      if(!current)throw fail(404,'The student does not have an active enrolment in the selected source academic year');
      if(b.toClassroomId){
        const dest=await maybeOne(client,'SELECT id FROM classrooms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND is_active=true',[b.toClassroomId,a.core.organisation_id,b.toAcademicYearId]);
        if(!dest)throw fail(400,'The selected destination class does not belong to the destination academic year');
      }

      await client.query('UPDATE enrolments SET status=$1 WHERE id=$2',[b.outcome==='promoted'?'promoted':b.outcome==='repeated'?'repeated':'completed',current.id]);
      if(b.outcome==='completed'){
        await client.query("UPDATE students SET status='graduated',updated_at=now() WHERE id=$1 AND organisation_id=$2",[b.studentId,a.core.organisation_id]);
      }else{
        await client.query(`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status)
          VALUES($1,$2,$3,$4,'active') ON CONFLICT(student_id,academic_year_id)
          DO UPDATE SET classroom_id=EXCLUDED.classroom_id,status='active',enrolled_at=now()`,[a.core.organisation_id,b.studentId,b.toAcademicYearId,b.toClassroomId]);
        await client.query("UPDATE students SET status='active',updated_at=now() WHERE id=$1 AND organisation_id=$2",[b.studentId,a.core.organisation_id]);
        await assignMandatoryFees(client,a.core.organisation_id,b.studentId,b.toAcademicYearId,b.toClassroomId);
      }
      const promotion=await one(client,`INSERT INTO student_promotions(
        organisation_id,student_id,from_academic_year_id,to_academic_year_id,from_classroom_id,to_classroom_id,outcome,
        processed_by_os_user_id,academic_average,terms_count,promotion_basis
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,'manual_override')
      ON CONFLICT(student_id,to_academic_year_id) DO UPDATE SET from_classroom_id=EXCLUDED.from_classroom_id,to_classroom_id=EXCLUDED.to_classroom_id,
        outcome=EXCLUDED.outcome,processed_by_os_user_id=EXCLUDED.processed_by_os_user_id,promotion_basis='manual_override',created_at=now()
      RETURNING *`,[a.core.organisation_id,b.studentId,b.fromAcademicYearId,b.toAcademicYearId,current.classroom_id,b.toClassroomId??null,b.outcome,a.core.id]);
      return promotion;
    });
    await audit(a.core.organisation_id,a.core.id,'student.manual_promotion','student_promotion',result.id,{studentId:b.studentId,outcome:b.outcome,reason:b.reason,fromAcademicYearId:b.fromAcademicYearId,toAcademicYearId:b.toAcademicYearId,toClassroomId:b.toClassroomId??null});
    return{...result,manual_override_reason:b.reason};
  });
}
