import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('assessment and report flow uses one 30 percent continuous bucket and one 70 percent end-term exam',async()=>{
  const server=await read('server.js');
  const teacher=await read('teacher-ui.js');
  const ui=await read('ui.js');

  assert.match(server,/assessmentComponent/);
  assert.match(server,/end_term_exam/);
  assert.match(server,/CONTINUOUS/);
  assert.match(server,/End-of-Term Exam is fixed at 70 marks/);

  // Continuous Assessment is averaged at assessment level and then scaled to 30%.
  assert.match(server,/category_average\s*\*\s*assessment_count/);
  assert.match(server,/SUM\(assessment_count\).*category_code\s*<>\s*'EXAM'/s);
  assert.match(server,/class_assessment_raw\s*\*\s*0\.30/);

  // The final exam contributes the remaining 70%.
  assert.match(server,/exam_raw\s*\*\s*0\.70/);
  assert.match(server,/class_assessment_raw\s*\*\s*0\.30\s*\+\s*exam_raw\s*\*\s*0\.70/);

  // Teachers/admins choose an assessment type, not category weights.
  assert.match(teacher,/id="taType"/);
  assert.match(ui,/id="exType"/);
  assert.doesNotMatch(teacher,/id="taCat"/);
  assert.doesNotMatch(ui,/id="newCategory"/);
});
