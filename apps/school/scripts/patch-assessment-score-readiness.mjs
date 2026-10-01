import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.join(process.cwd(), 'src', 'server.ts');

if (!fs.existsSync(serverPath)) {
  throw new Error(`Missing source file: ${serverPath}`);
}

let source = fs.readFileSync(serverPath, 'utf8');

const examExpression = "(upper(COALESCE(ac.code,''))='EXAM' OR lower(COALESCE(a.assessment_type,''))='exam' OR lower(COALESCE(a.name,'')) LIKE '%exam%')";
const oldExam = "COALESCE(ac.code,upper(a.assessment_type))='EXAM'";
const oldNotExam = "COALESCE(ac.code,upper(a.assessment_type))<>'EXAM'";

source = source.split(oldNotExam).join(`NOT ${examExpression}`);
source = source.split(oldExam).join(examExpression);

source = source.split("if(Number(row.exam_count||0)===0)reasons.push('Exam (70%) is not configured');")
  .join("if(Number(row.exam_count||0)===0)reasons.push('Exam score is not set up. Create or record the Exam mark out of 70; any score from 0 to 70 is valid.');");
source = source.split("if(Number(row.class_assessment_count||0)===0)reasons.push('Class Assessment (30%) is not configured');")
  .join("if(Number(row.class_assessment_count||0)===0)reasons.push('Class Assessment score is not set up. Add or record the Class Assessment mark out of 30.');");

source = source.split("const maxScore=b.maxScore??Number(category.default_max_score);")
  .join("const maxScore=type==='exam'?70:(b.maxScore??Number(category.default_max_score));");

source = source.split("for(const s of b.scores)if(Number(s.score)>Number(ass.max_score))throw fail(400,`Score cannot exceed ${ass.max_score}`);")
  .join("for(const s of b.scores)if(Number(s.score)>Number(ass.max_score))throw fail(400,`Score cannot exceed ${ass.max_score}. For Exam, enter a mark from 0 to 70.`);");

fs.writeFileSync(serverPath, source);
console.log('Assessment readiness now accepts any entered Exam score from 0 to 70 and recognises Exam by category, type or name.');
