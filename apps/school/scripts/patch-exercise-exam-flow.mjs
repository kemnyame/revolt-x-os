import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.join(process.cwd(), 'src', 'server.ts');
if (!fs.existsSync(serverPath)) throw new Error(`Missing source file: ${serverPath}`);
let source = fs.readFileSync(serverPath, 'utf8');

function replaceBetween(start, end, replacement, label) {
  const s = source.indexOf(start);
  if (s < 0) throw new Error(`Could not find start anchor for ${label}`);
  const e = source.indexOf(end, s + start.length);
  if (e < 0) throw new Error(`Could not find end anchor for ${label}`);
  source = source.slice(0, s) + replacement + source.slice(e);
}

const examPredicate = `(
          COALESCE(ac.code,'')='EXAM'
          OR lower(COALESCE(a.assessment_type,''))='exam'
          OR lower(COALESCE(a.name,'')) LIKE '%exam%'
        )`;

const calculateStudentTermResults = String.raw`async function calculateStudentTermResults(orgId:string,studentId:string,termId:string){
  const rows=(await db.query(`
    WITH current_class AS (
      SELECT e.classroom_id
      FROM enrolments e
      JOIN terms t ON t.academic_year_id=e.academic_year_id
      WHERE e.organisation_id=$1 AND e.student_id=$2 AND t.id=$3
      ORDER BY e.enrolled_at DESC LIMIT 1
    ),
    subject_list AS (
      SELECT cs.subject_id,s.name subject_name
      FROM class_subjects cs
      JOIN current_class cc ON cc.classroom_id=cs.classroom_id
      JOIN terms t ON t.id=$3 AND t.academic_year_id=cs.academic_year_id
      JOIN subjects s ON s.id=cs.subject_id
      WHERE cs.organisation_id=$1 AND cs.is_active=true
    ),
    assessment_rows AS (
      SELECT sl.subject_id,sl.subject_name,a.id assessment_id,a.name assessment_name,a.max_score,sc.score,
        (
          COALESCE(ac.code,'')='EXAM'
          OR lower(COALESCE(a.assessment_type,''))='exam'
          OR lower(COALESCE(a.name,'')) LIKE '%exam%'
        ) is_exam,
        CASE WHEN sc.score IS NOT NULL AND a.max_score>0 THEN (sc.score/a.max_score)*100.0 ELSE NULL END score_percent
      FROM subject_list sl
      LEFT JOIN current_class cc ON true
      LEFT JOIN assessments a ON a.organisation_id=$1 AND a.classroom_id=cc.classroom_id AND a.term_id=$3 AND a.subject_id=sl.subject_id
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$2
    ),
    subject_scores AS (
      SELECT subject_id,subject_name,
        COUNT(assessment_id) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam)::int exercise_count,
        COUNT(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam)::int exercise_scored_count,
        COUNT(assessment_id) FILTER(WHERE assessment_id IS NOT NULL AND is_exam)::int exam_count,
        COUNT(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND is_exam)::int exam_scored_count,
        AVG(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam) class_assessment_raw,
        MAX(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND is_exam) exam_raw,
        COALESCE(jsonb_agg(jsonb_build_object(
          'assessmentId',assessment_id,'name',assessment_name,
          'component',CASE WHEN is_exam THEN 'Exam' ELSE 'Exercise' END,
          'score',score,'maxScore',max_score,'scorePercent',ROUND(score_percent::numeric,2)
        ) ORDER BY is_exam,assessment_name) FILTER(WHERE assessment_id IS NOT NULL),'[]'::jsonb) components
      FROM assessment_rows
      GROUP BY subject_id,subject_name
    )
    SELECT *,
      ROUND(class_assessment_raw::numeric,2) class_assessment_raw,
      ROUND(exam_raw::numeric,2) exam_raw,
      ROUND((class_assessment_raw*0.30)::numeric,2) class_assessment_score,
      ROUND((exam_raw*0.70)::numeric,2) exam_score,
      ROUND(CASE WHEN class_assessment_raw IS NOT NULL AND exam_raw IS NOT NULL AND exam_count=1
        THEN class_assessment_raw*0.30+exam_raw*0.70 ELSE NULL END::numeric,2) total
    FROM subject_scores
    ORDER BY subject_name
  `,[orgId,studentId,termId])).rows;

  const bands=(await db.query('SELECT * FROM grading_bands WHERE organisation_id=$1 AND is_active=true ORDER BY sort_order,min_percentage DESC',[orgId])).rows;
  return rows.map((row:any)=>{
    const total=row.total==null?null:Number(row.total);
    const band=total==null?null:bands.find((b:any)=>total>=Number(b.min_percentage)&&total<=Number(b.max_percentage));
    return{
      ...row,
      class_assessment_raw:row.class_assessment_raw==null?null:Number(row.class_assessment_raw),
      class_assessment_score:row.class_assessment_score==null?null:Number(row.class_assessment_score),
      exam_raw:row.exam_raw==null?null:Number(row.exam_raw),
      exam_score:row.exam_score==null?null:Number(row.exam_score),
      total,
      percentage:total,
      weighted_points:total,
      grade:band?.name??'',
      remark:band?.remark??''
    };
  });
}`;

const reportAssessmentReadiness = String.raw`async function reportAssessmentReadiness(orgId:string,studentId:string,termId:string,classroomId?:string|null){
  let classId=classroomId??null;
  if(!classId){
    const current=await maybeOne<any>(db,`
      SELECT e.classroom_id FROM enrolments e JOIN terms t ON t.academic_year_id=e.academic_year_id
      WHERE e.organisation_id=$1 AND e.student_id=$2 AND t.id=$3
      ORDER BY e.enrolled_at DESC LIMIT 1
    `,[orgId,studentId,termId]);
    classId=current?.classroom_id??null;
  }
  if(!classId)return{complete:false,classroomId:null,totalSubjects:0,completeSubjects:0,missing:[{subjectName:'Student enrolment',missing:['No class enrolment found for this term']}]};

  const rows=(await db.query(`
    WITH assessment_rows AS (
      SELECT cs.subject_id,s.name subject_name,a.id assessment_id,a.name assessment_name,sc.score,
        (
          COALESCE(ac.code,'')='EXAM'
          OR lower(COALESCE(a.assessment_type,''))='exam'
          OR lower(COALESCE(a.name,'')) LIKE '%exam%'
        ) is_exam
      FROM class_subjects cs
      JOIN subjects s ON s.id=cs.subject_id
      JOIN terms t ON t.id=$3 AND t.academic_year_id=cs.academic_year_id
      LEFT JOIN assessments a ON a.organisation_id=cs.organisation_id AND a.classroom_id=cs.classroom_id
        AND a.subject_id=cs.subject_id AND a.term_id=$3
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=$2
      WHERE cs.organisation_id=$1 AND cs.classroom_id=$4 AND cs.is_active=true
    )
    SELECT subject_id,subject_name,
      COUNT(assessment_id) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam)::int exercise_count,
      COUNT(score) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam)::int exercise_scored_count,
      COUNT(assessment_id) FILTER(WHERE assessment_id IS NOT NULL AND is_exam)::int exam_count,
      COUNT(score) FILTER(WHERE assessment_id IS NOT NULL AND is_exam)::int exam_scored_count,
      COALESCE(jsonb_agg(jsonb_build_object('assessmentId',assessment_id,'name',assessment_name,'component',CASE WHEN is_exam THEN 'Exam' ELSE 'Exercise' END)
        ORDER BY is_exam,assessment_name) FILTER(WHERE assessment_id IS NOT NULL AND score IS NULL),'[]'::jsonb) missing_scores
    FROM assessment_rows
    GROUP BY subject_id,subject_name
    ORDER BY subject_name
  `,[orgId,studentId,termId,classId])).rows;

  const missing:any[]=[];
  for(const row of rows){
    const reasons:string[]=[];
    if(Number(row.exercise_count||0)===0)reasons.push('No exercises have been configured. Add at least one exercise for the 30% class assessment average.');
    if(Number(row.exercise_scored_count||0)<Number(row.exercise_count||0)){
      const names=(Array.isArray(row.missing_scores)?row.missing_scores:[]).filter((x:any)=>x.component==='Exercise').map((x:any)=>x.name).filter(Boolean);
      reasons.push('Missing exercise score'+(names.length?': '+names.join(', '):''));
    }
    if(Number(row.exam_count||0)===0)reasons.push('Exam score out of 70 has not been configured');
    if(Number(row.exam_count||0)>1)reasons.push('Only one Exam is allowed for this subject in the term. Remove the extra exam records.');
    if(Number(row.exam_count||0)===1&&Number(row.exam_scored_count||0)===0)reasons.push('Exam score is missing');
    if(reasons.length)missing.push({subjectId:row.subject_id,subjectName:row.subject_name,missing:reasons,missingScores:row.missing_scores||[]});
  }
  return{complete:rows.length>0&&missing.length===0,classroomId:classId,totalSubjects:rows.length,completeSubjects:rows.length-missing.length,missing};
}`;

const calculateClassRank = String.raw`async function calculateClassRank(orgId:string,classroomId:string,termId:string,studentId:string){
  return maybeOne<any>(db,`
    WITH enrolled AS (
      SELECT e.student_id FROM enrolments e
      WHERE e.organisation_id=$1 AND e.classroom_id=$2 AND e.status IN('active','promoted','repeated','completed')
    ),
    class_subjects_active AS (
      SELECT cs.subject_id FROM class_subjects cs
      JOIN terms t ON t.id=$3 AND t.academic_year_id=cs.academic_year_id
      WHERE cs.organisation_id=$1 AND cs.classroom_id=$2 AND cs.is_active=true
    ),
    assessment_rows AS (
      SELECT en.student_id,cs.subject_id,a.id assessment_id,sc.score,a.max_score,
        (
          COALESCE(ac.code,'')='EXAM'
          OR lower(COALESCE(a.assessment_type,''))='exam'
          OR lower(COALESCE(a.name,'')) LIKE '%exam%'
        ) is_exam,
        CASE WHEN sc.score IS NOT NULL AND a.max_score>0 THEN (sc.score/a.max_score)*100.0 ELSE NULL END score_percent
      FROM enrolled en
      CROSS JOIN class_subjects_active cs
      LEFT JOIN assessments a ON a.classroom_id=$2 AND a.term_id=$3 AND a.subject_id=cs.subject_id
      LEFT JOIN assessment_categories ac ON ac.id=a.category_id
      LEFT JOIN assessment_scores sc ON sc.assessment_id=a.id AND sc.student_id=en.student_id
    ),
    subject_scores AS (
      SELECT student_id,subject_id,
        COUNT(assessment_id) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam)::int exercise_count,
        COUNT(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam)::int exercise_scored_count,
        COUNT(assessment_id) FILTER(WHERE assessment_id IS NOT NULL AND is_exam)::int exam_count,
        COUNT(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND is_exam)::int exam_scored_count,
        AVG(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND NOT is_exam) ca_raw,
        MAX(score_percent) FILTER(WHERE assessment_id IS NOT NULL AND is_exam) exam_raw
      FROM assessment_rows
      GROUP BY student_id,subject_id
    ),
    subject_totals AS (
      SELECT student_id,subject_id,
        CASE WHEN exercise_count>0 AND exercise_scored_count=exercise_count AND exam_count=1 AND exam_scored_count=1
          THEN ca_raw*0.30+exam_raw*0.70 ELSE NULL END subject_total
      FROM subject_scores
    ),
    student_scores AS (
      SELECT student_id,AVG(subject_total) overall_average
      FROM subject_totals
      GROUP BY student_id
      HAVING COUNT(*) FILTER(WHERE subject_total IS NOT NULL)=(SELECT COUNT(*) FROM class_subjects_active)
        AND (SELECT COUNT(*) FROM class_subjects_active)>0
    ),
    ranked AS (
      SELECT student_id,ROUND(overall_average::numeric,2) average,
        RANK() OVER(ORDER BY overall_average DESC)::int position,
        COUNT(*) OVER()::int class_size
      FROM student_scores
    )
    SELECT * FROM ranked WHERE student_id=$4
  `,[orgId,classroomId,termId,studentId]);
}`;

const createAssessmentEndpoint = String.raw`app.post('/api/assessments',async(request,reply)=>{
  const a=await authorize(request,db,config,'assessment.create');
  const b=z.object({
    academicYearId:z.string().uuid(),termId:z.string().uuid(),classroomId:z.string().uuid(),subjectId:z.string().uuid(),
    categoryId:z.string().uuid().optional(),assessmentType:z.enum(['classwork','homework','project','test','exam','other']).optional(),
    name:z.string().min(2).max(160),maxScore:z.number().positive().optional(),assessmentDate:z.string().date().optional(),
    teacherOsUserId:z.string().uuid().optional()
  }).parse(request.body);
  const teacherId=a.role==='teacher'?a.core.id:(b.teacherOsUserId??a.core.id);
  if(a.role==='teacher')await ensureTeacherScope(a,b.classroomId,b.subjectId);
  else await validateTeachingAssignment({
    organisationId:a.core.organisation_id,academicYearId:b.academicYearId,termId:b.termId,
    classroomId:b.classroomId,subjectId:b.subjectId,teacherOsUserId:teacherId
  });
  let category:any=null;
  if(b.categoryId){
    category=await one<any>(db,`SELECT * FROM assessment_categories
      WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND term_id=$4 AND is_active=true`,
      [b.categoryId,a.core.organisation_id,b.academicYearId,b.termId]);
  }else{
    const code=({exam:'EXAM',classwork:'CLASSWORK',homework:'CLASSWORK',project:'CLASSWORK',test:'CLASSWORK',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];
    category=await maybeOne<any>(db,`SELECT * FROM assessment_categories
      WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id=$3 AND code=$4 AND is_active=true`,
      [a.core.organisation_id,b.academicYearId,b.termId,code]);
  }
  if(!category)throw fail(400,'Select a valid assessment category for this term');
  const cleanName=b.name.trim();
  const isExam=category.code==='EXAM'||b.assessmentType==='exam'||/exam/i.test(cleanName);
  const type=isExam?'exam':'classwork';
  const maxScore=b.maxScore??(isExam?70:Number(category.default_max_score||30));
  if(isExam&&Number(maxScore)!==70)throw fail(400,'Exam must be marked out of 70');
  if(!isExam&&Number(maxScore)<=0)throw fail(400,'Exercise maximum mark must be greater than zero');
  if(isExam){
    const existingExam=await maybeOne<any>(db,`
      SELECT id,name FROM assessments ax
      LEFT JOIN assessment_categories acx ON acx.id=ax.category_id
      WHERE ax.organisation_id=$1 AND ax.term_id=$2 AND ax.classroom_id=$3 AND ax.subject_id=$4
        AND (
          COALESCE(acx.code,'')='EXAM'
          OR lower(COALESCE(ax.assessment_type,''))='exam'
          OR lower(COALESCE(ax.name,'')) LIKE '%exam%'
        )
      LIMIT 1`,[a.core.organisation_id,b.termId,b.classroomId,b.subjectId]);
    if(existingExam)throw fail(409,'Only one Exam is allowed for this subject in the term. Edit the existing exam instead of creating another one.');
  }
  const duplicate=await maybeOne<any>(db,`SELECT id FROM assessments
    WHERE organisation_id=$1 AND term_id=$2 AND classroom_id=$3 AND subject_id=$4 AND teacher_os_user_id=$5
      AND lower(trim(name))=lower($6) AND assessment_date IS NOT DISTINCT FROM $7::date LIMIT 1`,
    [a.core.organisation_id,b.termId,b.classroomId,b.subjectId,teacherId,cleanName,b.assessmentDate??null]);
  if(duplicate)throw fail(409,'This teacher already has an exercise or exam with the same name and date for this class and subject');
  const row=await one<any>(db,`INSERT INTO assessments(
      organisation_id,academic_year_id,term_id,classroom_id,subject_id,category_id,name,assessment_type,max_score,weight,
      assessment_date,created_by_os_user_id,teacher_os_user_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [a.core.organisation_id,b.academicYearId,b.termId,b.classroomId,b.subjectId,category.id,cleanName,type,maxScore,
      isExam?70:30,b.assessmentDate??null,a.core.id,teacherId]);
  await audit(a.core.organisation_id,a.core.id,'assessment.created','assessment',row.id,{categoryId:category.id,teacherOsUserId:teacherId,flow:isExam?'exam_70':'exercise_average_30'});
  return reply.code(201).send(row);
});`;

replaceBetween('async function calculateStudentTermResults(orgId:string,studentId:string,termId:string){', '\n\nasync function reportAssessmentReadiness', calculateStudentTermResults, 'calculateStudentTermResults');
replaceBetween('async function reportAssessmentReadiness(orgId:string,studentId:string,termId:string,classroomId?:string|null){', '\n\nasync function reportPromotionInfo', reportAssessmentReadiness, 'reportAssessmentReadiness');
replaceBetween('async function calculateClassRank(orgId:string,classroomId:string,termId:string,studentId:string){', '\n\nasync function provisionDemoTeachers', calculateClassRank, 'calculateClassRank');
replaceBetween("app.post('/api/assessments',async(request,reply)=>{", "\n});\napp.get('/api/assessments/:id/scores'", createAssessmentEndpoint, 'create assessment endpoint');

fs.writeFileSync(serverPath, source);
console.log('Exercise/exam assessment flow patched: exercises average to 30%, one exam out of 70%.');
