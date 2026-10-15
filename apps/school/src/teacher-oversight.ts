import {z} from 'zod';
import {schoolRecordId} from './record-id.js';

export async function registerTeacherOversight(app:any,d:any){
  const {db,config,authorize,one,activeTerm,effectiveClassTeacher,fail}=d;
  app.get('/api/teacher/class-overview',async(request:any)=>{
    const a=await authorize(request,db,config,'academic.view');
    const q=z.object({classroomId:schoolRecordId,termId:schoolRecordId.optional()}).parse(request.query);
    const classroom=await one(db,'SELECT * FROM classrooms WHERE id=$1 AND organisation_id=$2',[q.classroomId,a.core.organisation_id]);
    const term=q.termId?await one(db,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3',[q.termId,a.core.organisation_id,classroom.academic_year_id]):await activeTerm(a.core.organisation_id);
    if(term&&term.academic_year_id!==classroom.academic_year_id)throw fail(400,'Choose a term from this class academic year');
    if(a.role!=='school_admin'&&await effectiveClassTeacher(a.core.organisation_id,q.classroomId,term?.id)!==a.core.id)throw fail(403,'Only the assigned Class Teacher can open this class oversight');
    const subjects=(await db.query(`SELECT cs.subject_id,s.name subject_name,cs.weekly_periods,
      COALESCE(NULLIF(concat_ws(' ',u.first_name,u.last_name),''),ta.teacher_os_user_id::text,'Not assigned') teacher_name,
      (SELECT count(*)::int FROM assessments a WHERE a.organisation_id=$1 AND a.classroom_id=$2 AND a.subject_id=cs.subject_id AND a.term_id=$3) assessments,
      (SELECT count(*)::int FROM assessment_scores sc JOIN assessments a ON a.id=sc.assessment_id WHERE a.organisation_id=$1 AND a.classroom_id=$2 AND a.subject_id=cs.subject_id AND a.term_id=$3) scores_saved,
      (SELECT count(*)::int FROM homework_assignments h WHERE h.organisation_id=$1 AND h.classroom_id=$2 AND h.subject_id=cs.subject_id AND h.term_id=$3) homework,
      (SELECT count(*)::int FROM lesson_notes n WHERE n.organisation_id=$1 AND n.classroom_id=$2 AND n.subject_id=cs.subject_id AND n.term_id=$3 AND n.status IN('approved','taught')) approved_lesson_notes
      FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
      LEFT JOIN LATERAL(SELECT x.teacher_os_user_id FROM teacher_assignments x WHERE x.organisation_id=$1 AND x.classroom_id=$2
        AND x.subject_id=cs.subject_id AND x.is_active=true AND (x.term_id=$3 OR x.term_id IS NULL) ORDER BY x.term_id NULLS LAST,x.created_at DESC LIMIT 1) ta ON true
      LEFT JOIN school_user_directory u ON u.organisation_id=cs.organisation_id AND u.os_user_id=ta.teacher_os_user_id
      WHERE cs.organisation_id=$1 AND cs.classroom_id=$2 AND cs.is_active=true ORDER BY s.name`,[a.core.organisation_id,q.classroomId,term?.id??null])).rows;
    const students=(await db.query(`SELECT s.id,s.admission_no,s.first_name,s.last_name,s.status FROM students s JOIN enrolments e ON e.student_id=s.id
      WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.academic_year_id=$3 ORDER BY s.last_name,s.first_name`,[a.core.organisation_id,q.classroomId,classroom.academic_year_id])).rows;
    return{classroom,term,subjects,students};
  });
}
