import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('assessment flow is fixed to system-managed 30/70 components without category weight setup',async()=>{
  const server=await read('server.js');
  const ui=await read('ui.js');
  const teacher=await read('teacher-ui.js');

  assert.doesNotMatch(server,/Assessment category weights cannot exceed 100% for a term/);
  assert.match(server,/systemCode\s*=\s*isEndTermExam\s*\?\s*'EXAM'\s*:\s*'CONTINUOUS'/);
  assert.match(server,/systemWeight\s*=\s*isEndTermExam\s*\?\s*70\s*:\s*30/);
  assert.match(server,/End-of-Term Exam is fixed at 70 marks/);
  assert.match(server,/category_average\s*\*\s*assessment_count/);
  assert.match(server,/class_assessment_raw\s*\*\s*0\.30/);
  assert.match(server,/exam_raw\s*\*\s*0\.70/);

  assert.doesNotMatch(ui,/id="newCategory"/);
  assert.doesNotMatch(ui,/Term weight %/);
  assert.match(ui,/id="exType"/);
  assert.match(ui,/30% \+ 70% = 100%/);
  assert.match(ui,/No category weights are required/);

  assert.match(teacher,/id="taType"/);
  assert.match(teacher,/automatically calculates Continuous Assessment at 30%/);
  assert.doesNotMatch(teacher,/id="taCat"/);
});
