import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('assessment and report flow uses homework-aware 30 percent CA and a raw exam scaled to 70 percent',async()=>{
  const server=await read('server.js');
  const teacher=await read('teacher-ui.js');
  const ui=await read('ui.js');

  assert.match(server,/assessmentComponent/);
  assert.match(server,/end_term_exam/);
  assert.match(server,/CONTINUOUS/);

  // Homework from the Homework module is a real Continuous Assessment item.
  assert.match(server,/homework_summary/);
  assert.match(server,/homework_assignments/);
  assert.match(server,/h\.status IN\('published','closed'\)/);
  assert.match(server,/homework_scored_count/);

  // Every raw CA item is normalised, averaged, then scaled to 30%.
  assert.match(server,/class_assessment_raw\*0\.30/);

  // The final exam can be entered out of 100 and is normalised before contributing 70%.
  assert.match(server,/systemDefaultMax\s*=\s*100/);
  assert.match(server,/exam_raw\*0\.70/);
  assert.doesNotMatch(server,/End-of-Term Exam is fixed at 70 marks/);
  assert.match(teacher,/exam:100/);
  assert.match(ui,/exam:100/);

  // Teachers/admins choose an assessment type, not category weights.
  assert.match(teacher,/id="taType"/);
  assert.match(ui,/id="exType"/);
  assert.doesNotMatch(teacher,/id="taCat"/);
  assert.doesNotMatch(ui,/id="newCategory"/);
});

test('promotion appears only on cumulative Third Term reports',async()=>{
  const server=await read('server.js');
  const teacher=await read('teacher-ui.js');
  const parent=await read('parent-ui.js');
  const student=await read('student-ui.js');

  assert.match(server,/Number\(term\.term_no\)!==3/);
  assert.match(server,/annualAverage/);
  assert.match(server,/academic_year_average/);
  assert.match(teacher,/promo\.applicable/);
  assert.match(parent,/Number\(t\.term_no\)===3/);
  assert.match(student,/Number\(r\.term&&r\.term\.term_no\)===3/);
});

test('academic years use fixed terms and rollover prepares destination classes',async()=>{
  const server=await read('server.js');
  const ui=await read('ui.js');

  assert.match(server,/ensureFixedAcademicYearTerms/);
  assert.match(server,/First Term/);
  assert.match(server,/Second Term/);
  assert.match(server,/Third Term/);
  assert.match(server,/Academic terms are fixed and cannot be deleted/);
  assert.match(server,/ensureRolloverClassStructure/);
  assert.match(server,/INSERT INTO classrooms/);
  assert.match(server,/INSERT INTO class_subjects/);
  assert.match(ui,/Destination-year classes are prepared automatically/);
});

test('admin dashboard has a recovery path instead of staying on Loading',async()=>{
  const server=await read('server.js');
  const ui=await read('ui.js');
  assert.match(server,/screen\.dashboard\.view/);
  assert.match(server,/degraded:warnings\.length>0/);
  assert.match(ui,/Dashboard loaded in recovery mode/);
});
