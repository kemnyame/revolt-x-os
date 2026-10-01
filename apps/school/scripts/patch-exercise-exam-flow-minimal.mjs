import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.join(process.cwd(), 'src', 'server.ts');
if (!fs.existsSync(serverPath)) throw new Error(`Missing source file: ${serverPath}`);
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(from, to, label) {
  if (!source.includes(from)) throw new Error(`Missing patch anchor: ${label}`);
  source = source.replace(from, to);
}

// After patch-assessment-score-readiness runs, the report engine may still classify any name
// containing "exam" as the 70% exam. That is wrong for "mid-term exam". Only the actual
// end-of-term/terminal/final exam should be treated as the 70% exam.
const broadExamPredicate = "(upper(COALESCE(ac.code,''))='EXAM' OR lower(COALESCE(a.assessment_type,''))='exam' OR lower(COALESCE(a.name,'')) LIKE '%exam%')";
const endTermExamPredicate = "(upper(COALESCE(ac.code,''))='EXAM' OR lower(COALESCE(a.assessment_type,''))='exam' OR lower(COALESCE(a.name,'')) LIKE '%end%term%' OR lower(COALESCE(a.name,'')) LIKE '%terminal%' OR lower(COALESCE(a.name,'')) LIKE '%final exam%')";
source = source.split(broadExamPredicate).join(endTermExamPredicate);

// Treat classwork, homework, assignments, projects, class tests and mid-term exams as one
// continuous assessment bucket. These are averaged and contribute 30% to the report.
source = source.replace(
  "const code=({classwork:'CLASSWORK',homework:'HOMEWORK',project:'PROJECT',test:'MIDTERM',exam:'EXAM',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];",
  "const code=({classwork:'CLASSWORK',homework:'CLASSWORK',project:'CLASSWORK',test:'CLASSWORK',exam:'EXAM',other:'CLASSWORK'} as Record<string,string>)[b.assessmentType||'classwork'];"
);

// Force the creation flow into the two-component model:
// - non-exam records remain classwork/exercise and contribute to the 30% average
// - the end-of-term exam is one record marked out of 70
const currentBlock = "  const type=category.code==='CLASSWORK'?'classwork':category.code==='HOMEWORK'?'homework':category.code==='PROJECT'?'project':category.code==='EXAM'?'exam':category.code==='MIDTERM'?'test':'other';\n  const maxScore=type==='exam'?70:(b.maxScore??Number(category.default_max_score));\n  const cleanName=b.name.trim();";
const newBlock = [
  "  const cleanName=b.name.trim();",
  "  const lowerName=cleanName.toLowerCase();",
  "  const isEndTermExam=category.code==='EXAM'||b.assessmentType==='exam'||lowerName.includes('end of term')||lowerName.includes('end-term')||lowerName.includes('terminal')||lowerName.includes('final exam');",
  "  const type=isEndTermExam?'exam':'classwork';",
  "  const maxScore=b.maxScore??(isEndTermExam?70:Number(category.default_max_score||30));",
  "  if(isEndTermExam&&Number(maxScore)!==70)throw fail(400,'End-of-Term Exam must be marked out of 70');",
  "  if(!isEndTermExam&&Number(maxScore)<=0)throw fail(400,'Continuous assessment maximum mark must be greater than zero');",
  "  if(isEndTermExam){",
  "    const existingExam=await maybeOne<any>(db,`SELECT ax.id,ax.name FROM assessments ax",
  "      LEFT JOIN assessment_categories acx ON acx.id=ax.category_id",
  "      WHERE ax.organisation_id=$1 AND ax.term_id=$2 AND ax.classroom_id=$3 AND ax.subject_id=$4",
  "        AND (upper(COALESCE(acx.code,''))='EXAM' OR lower(COALESCE(ax.assessment_type,''))='exam' OR lower(COALESCE(ax.name,'')) LIKE '%end%term%' OR lower(COALESCE(ax.name,'')) LIKE '%terminal%' OR lower(COALESCE(ax.name,'')) LIKE '%final exam%')",
  "      LIMIT 1`,[a.core.organisation_id,b.termId,b.classroomId,b.subjectId]);",
  "    if(existingExam)throw fail(409,'Only one End-of-Term Exam is allowed for this subject in the term. Edit the existing exam instead of creating another one.');",
  "  }"
].join('\n');
if (source.includes(currentBlock)) {
  source = source.replace(currentBlock, newBlock);
} else if (!source.includes('const isEndTermExam=')) {
  throw new Error('Missing patch anchor: exam and continuous assessment creation block');
}

// Use fixed report weights: continuous assessment bucket = 30%, end-of-term exam = 70%.
source = source.replaceAll('(isExam?70:30)', '(isEndTermExam?70:30)');
source = source.replaceAll('category.weight_percent,b.assessmentDate??null,a.core.id,teacherId]', '(isEndTermExam?70:30),b.assessmentDate??null,a.core.id,teacherId]');

// Correct labels/messages.
source = source
  .replaceAll('Only one Exam is allowed for this subject in the term. Edit the existing exam instead of creating another one.', 'Only one End-of-Term Exam is allowed for this subject in the term. Edit the existing exam instead of creating another one.')
  .replaceAll('No exercises have been configured for the 30% class assessment average', 'No continuous assessment records have been configured for the 30% average')
  .replaceAll('No exercises have been configured or scored for the 30% exercise average', 'No continuous assessment records have been configured or scored for the 30% average')
  .replaceAll('One Exam score out of 70 is required', 'One End-of-Term Exam score out of 70 is required')
  .replaceAll('Missing exercise/exam score', 'Missing continuous assessment or exam score');

fs.writeFileSync(serverPath, source);
console.log('Assessment flow applied: homework/classwork/assignments/mid-term average into 30%; one end-of-term exam contributes 70%.');
