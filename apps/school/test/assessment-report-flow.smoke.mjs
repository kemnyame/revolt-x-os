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
  assert.match(server,/Continuous Assessment cannot use the End-of-Term Exam category/);
  assert.match(server,/End-of-Term Exam must be marked out of 70/);
  assert.match(server,/isMidTerm/);

  // The continuous component is an assessment-level arithmetic average, then scaled to 30%.
  assert.match(server,/category_average\*assessment_count/);
  assert.match(server,/SUM\(assessment_count\).*category_code<>'EXAM'/);
  assert.match(server,/class_assessment_raw\*0\.30/);

  // The final exam is the 70% component and the report requires both components.
  assert.match(server,/exam_raw\*0\.70/);
  assert.match(server,/class_assessment_raw\*0\.30\+exam_raw\*0\.70/);

  // Both teacher and admin entry flows make the two report components explicit.
  assert.match(teacher,/Continuous Assessment \(30%\)/);
  assert.match(teacher,/End-of-Term Exam \(70%\)/);
  assert.match(teacher,/assessmentComponent:E\('taComponent'\)\.value/);
  assert.match(ui,/Continuous Assessment \(30%\)/);
  assert.match(ui,/End-of-Term Exam \(70%\)/);
  assert.match(ui,/assessmentComponent:E\('exComponent'\)\.value/);
});
