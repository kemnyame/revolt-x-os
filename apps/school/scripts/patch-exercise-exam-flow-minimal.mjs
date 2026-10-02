import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.join(process.cwd(), 'src', 'server.ts');
if (!fs.existsSync(serverPath)) throw new Error(`Missing source file: ${serverPath}`);
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(from, to, label) {
  if (!source.includes(from)) throw new Error(`Missing patch anchor: ${label}`);
  source = source.replace(from, to);
}

// The report has exactly two components:
// 1) Continuous Assessment = 30%
// 2) End-of-Term Exam = 70%
// Class exercises, homework, assignments/projects, class tests and mid-term exams are all CA.
source = source.replace(
  "categoryId:z.string().uuid().optional(),assessmentType:z.enum(['classwork','homework','project','test','exam','other']).optional(),",
  "categoryId:z.string().uuid().optional(),assessmentType:z.enum(['classwork','homework','project','test','exam','other']).optional(),assessmentComponent:z.enum(['continuous','end_term_exam']).optional(),"
);

// Legacy category weights are no longer used to build the report. Keep the endpoints compatible,
// but remove the term-wide 100% validation that caused custom category failures.
source = source.replaceAll(
  "if(Number(total.total)+b.weightPercent>100.0001)throw fail(400,'Assessment category weights cannot exceed 100% for a term');",
  "void total;"
);
source = source.replaceAll(
  "if((b.isActive??current.is_active)&&Number(total.total)+nextWeight>100.0001)throw fail(400,'Assessment category weights cannot exceed 100% for a term');",
  "void total; void nextWeight;"
);

// Replace legacy category selection with system-managed CONTINUOUS / EXAM categories.
const oldCategoryBlock = `  let category:any=null;
  if(b.categoryId){
    category=await one<any>(db,\`SELECT * FROM assessment_categories
      WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3 AND term_id=$4 AND is_active=true\`,
      [b.categoryId,a.core.organisation_id,b.academicYearId,b.termId]);
  }else{
    const code=({classwork:'CLASSWORK',homework:'HOMEWORK',project:'PROJECT',test:'MIDTERM',exam:'EXAM',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];
    category=await maybeOne<any>(db,\`SELECT * FROM assessment_categories
      WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id=$3 AND code=$4 AND is_active=true\`,
      [a.core.organisation_id,b.academicYearId,b.termId,code]);
  }
  if(!category)throw fail(400,'Select a valid assessment category for this term');
  const type=category.code==='CLASSWORK'?'classwork':category.code==='HOMEWORK'?'homework':category.code==='PROJECT'?'project':category.code==='EXAM'?'exam':category.code==='MIDTERM'?'test':'other';
  const maxScore=type==='exam'?70:(b.maxScore??Number(category.default_max_score));
  const cleanName=b.name.trim();`;

const newCategoryBlock = `  const cleanName=b.name.trim();
  const requestedType=b.assessmentType??(b.assessmentComponent==='end_term_exam'?'exam':'classwork');
  const isEndTermExam=b.assessmentComponent==='end_term_exam'||requestedType==='exam';
  if(b.assessmentComponent==='continuous'&&requestedType==='exam')throw fail(400,'End-of-Term Exam must use the 70% exam component');
  const type=isEndTermExam?'exam':requestedType;
  const systemCode=isEndTermExam?'EXAM':'CONTINUOUS';
  const systemName=isEndTermExam?'End-of-Term Examination':'Continuous Assessment';
  const systemWeight=isEndTermExam?70:30;
  const systemDefaultMax=100;
  let category=await maybeOne<any>(db,\`SELECT * FROM assessment_categories
    WHERE organisation_id=$1 AND academic_year_id=$2 AND term_id=$3 AND code=$4\`,
    [a.core.organisation_id,b.academicYearId,b.termId,systemCode]);
  if(!category){
    category=await one<any>(db,\`INSERT INTO assessment_categories(
      organisation_id,academic_year_id,term_id,code,name,default_max_score,weight_percent,sort_order,is_active
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)
    ON CONFLICT(organisation_id,academic_year_id,term_id,code)
    DO UPDATE SET name=EXCLUDED.name,default_max_score=EXCLUDED.default_max_score,
      weight_percent=EXCLUDED.weight_percent,is_active=true,updated_at=now()
    RETURNING *\`,
    [a.core.organisation_id,b.academicYearId,b.termId,systemCode,systemName,systemDefaultMax,systemWeight,isEndTermExam?20:10]);
  }
  const maxScore=b.maxScore??Number(category.default_max_score||100);
  if(isEndTermExam&&Number(maxScore)<=0)throw fail(400,'End-of-Term Exam maximum mark must be greater than zero');
  if(!isEndTermExam&&Number(maxScore)<=0)throw fail(400,'Continuous assessment maximum mark must be greater than zero');
  if(isEndTermExam){
    const existingExam=await maybeOne<any>(db,\`SELECT ax.id,ax.name FROM assessments ax
      LEFT JOIN assessment_categories acx ON acx.id=ax.category_id
      WHERE ax.organisation_id=$1 AND ax.term_id=$2 AND ax.classroom_id=$3 AND ax.subject_id=$4
        AND upper(COALESCE(acx.code,''))='EXAM'
      LIMIT 1\`,[a.core.organisation_id,b.termId,b.classroomId,b.subjectId]);
    if(existingExam)throw fail(409,'Only one End-of-Term Exam is allowed for this subject in the term. Edit the existing exam instead.');
  }`;

if(source.includes(oldCategoryBlock)){
  source=source.replace(oldCategoryBlock,newCategoryBlock);
}else if(!source.includes("const systemCode=isEndTermExam?'EXAM':'CONTINUOUS'")){
  throw new Error('Missing patch anchor: canonical assessment creation flow');
}

// Insert the fixed 30/70 component weight on every new assessment.
source = source.replace(
  "category.weight_percent,b.assessmentDate??null,a.core.id,teacherId]",
  "systemWeight,b.assessmentDate??null,a.core.id,teacherId]"
);

// Normalise legacy exam detection. Only the system EXAM category is the 70% component.
const broadExamPredicate = "(upper(COALESCE(ac.code,''))='EXAM' OR lower(COALESCE(a.assessment_type,''))='exam' OR lower(COALESCE(a.name,'')) LIKE '%exam%')";
source = source.split(broadExamPredicate).join("(upper(COALESCE(ac.code,''))='EXAM')");

// Continuous Assessment is the arithmetic average of every individual CA assessment.
// We normalise each raw score to a percentage, average the assessment percentages equally,
// then scale that single average to 30%.
source = source.replace(
  "COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,\n        AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END) category_average",
  "COALESCE(ac.weight_percent,a.weight,0)::numeric weight_percent,\n        COUNT(a.id)::int assessment_count,\n        AVG(CASE WHEN sc.score IS NOT NULL THEN (sc.score/a.max_score)*100.0 END) category_average"
);
source = source.replaceAll(
  "SUM(category_average*weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)",
  "SUM(category_average*assessment_count) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)"
);
source = source.replaceAll(
  "SUM(weight_percent) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)",
  "SUM(assessment_count) FILTER(WHERE category_code<>'EXAM' AND category_average IS NOT NULL)"
);

// Fixed final formula: CA average contributes 30%, End-of-Term Exam contributes 70%.
source = source
  .replaceAll('Class Assessment (30%) is not configured','Continuous Assessment (30%) is not configured')
  .replaceAll('Class Assessment score is not set up. Add or record the Class Assessment mark out of 30.','Continuous Assessment scores are not complete')
  .replaceAll('Exam (70%) is not configured','End-of-Term Exam (70%) is not configured')
  .replaceAll('Exam score is not set up. Create or record the End-of-Term Exam mark; Revolt-X scales it to the 70% report component.','End-of-Term Exam raw score is required; Revolt-X scales it to the 70% report component')
  .replaceAll("component',CASE WHEN COALESCE(ac.code,upper(a.assessment_type))='EXAM' THEN 'Exam' ELSE 'Class Assessment' END",
              "component',CASE WHEN COALESCE(ac.code,upper(a.assessment_type))='EXAM' THEN 'End-of-Term Exam' ELSE 'Continuous Assessment' END");

fs.writeFileSync(serverPath, source);
console.log('Simple assessment flow applied: system-managed Continuous Assessment 30% + End-of-Term Exam 70%.');
