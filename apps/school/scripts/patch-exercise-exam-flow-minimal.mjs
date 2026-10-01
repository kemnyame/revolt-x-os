import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.join(process.cwd(), 'src', 'server.ts');
if (!fs.existsSync(serverPath)) throw new Error(`Missing source file: ${serverPath}`);
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(from, to, label) {
  if (!source.includes(from)) throw new Error(`Missing patch anchor: ${label}`);
  source = source.replace(from, to);
}

// Treat every non-exam assessment as an Exercise/Class Assessment record.
replaceOnce(
  "const code=({classwork:'CLASSWORK',homework:'HOMEWORK',project:'PROJECT',test:'MIDTERM',exam:'EXAM',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];",
  "const code=({classwork:'CLASSWORK',homework:'CLASSWORK',project:'CLASSWORK',test:'CLASSWORK',exam:'EXAM',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];",
  'assessment type to category mapping'
);

// After the system knows the category/type/name, force the two-component rule.
replaceOnce(
  "  const type=category.code==='CLASSWORK'?'classwork':category.code==='HOMEWORK'?'homework':category.code==='PROJECT'?'project':category.code==='EXAM'?'exam':category.code==='MIDTERM'?'test':'other';\n  const maxScore=b.maxScore??Number(category.default_max_score);\n  const cleanName=b.name.trim();",
  [
    "  const cleanName=b.name.trim();",
    "  const isExam=category.code==='EXAM'||b.assessmentType==='exam'||/exam/i.test(cleanName);",
    "  const type=isExam?'exam':'classwork';",
    "  const maxScore=b.maxScore??(isExam?70:Number(category.default_max_score||30));",
    "  if(isExam&&Number(maxScore)!==70)throw fail(400,'Exam must be marked out of 70');",
    "  if(isExam){",
    "    const existingExam=await maybeOne<any>(db,`SELECT ax.id,ax.name FROM assessments ax",
    "      LEFT JOIN assessment_categories acx ON acx.id=ax.category_id",
    "      WHERE ax.organisation_id=$1 AND ax.term_id=$2 AND ax.classroom_id=$3 AND ax.subject_id=$4",
    "        AND (COALESCE(acx.code,'')='EXAM' OR lower(COALESCE(ax.assessment_type,''))='exam' OR lower(COALESCE(ax.name,'')) LIKE '%exam%')",
    "      LIMIT 1`,[a.core.organisation_id,b.termId,b.classroomId,b.subjectId]);",
    "    if(existingExam)throw fail(409,'Only one Exam is allowed for this subject in the term. Edit the existing exam instead of creating another one.');",
    "  }"
  ].join('\n'),
  'exam and exercise rule block'
);

// Report calculations already average assessments within their category. By forcing all non-exam
// records into CLASSWORK, many exercises become one 30% exercise average, while the single exam is 70%.
replaceOnce(
  "category.weight_percent,b.assessmentDate??null,a.core.id,teacherId]",
  "(isExam?70:30),b.assessmentDate??null,a.core.id,teacherId]",
  'assessment weight value'
);

// Improve report readiness messages so users understand the new two-component model.
source = source
  .replaceAll('Class Assessment (30%) is not configured', 'No exercises have been configured for the 30% class assessment average')
  .replaceAll('Exam (70%) is not configured', 'One Exam score out of 70 is required')
  .replaceAll('Missing score', 'Missing exercise/exam score');

fs.writeFileSync(serverPath, source);
console.log('Minimal exercise/exam flow applied: exercises average to 30%; one exam out of 70.');
