import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('student management exposes 360 and opens the full student page inside the School workspace',async()=>{
  const ui=await read('ui.js');
  assert.match(ui,/data-student-360/);
  assert.match(ui,/function openStudentPage\(id\)/);
  assert.match(ui,/data-open-student/);
  assert.doesNotMatch(ui,/window\.open\('\/students\/[^]*'_blank','noopener'\)/);
  assert.match(ui,/Fee Account/);
  assert.match(ui,/Report Card History/);
  assert.match(ui,/Academic Statement Requests/);
  assert.match(ui,/Application reference/);
});

test('screen access is separated from data dependencies and Student 360 is restricted',async()=>{
  const ui=await read('ui.js');
  const server=await read('server.js');
  assert.match(ui,/screen\.students\.view/);
  assert.match(ui,/students\.360\.view/);
  assert.match(ui,/students\.profile\.view/);
  assert.match(server,/authorize\(request,db,config,'students\.360\.view'\)/);
  assert.match(server,/authorize\(request,db,config,'students\.profile\.view'\)/);
  assert.match(server,/screenDependencies/);
});

test('staff directory survives Core OS sleep through the persistent School cache',async()=>{
  const server=await read('server.js');
  assert.match(server,/school_user_directory/);
  assert.match(server,/readPersistentCoreUsers/);
  assert.match(server,/persistCoreUsers/);
  assert.match(server,/Serve the last complete staff directory immediately/);
});

test('student management paginates large directories in the browser',async()=>{
  const ui=await read('ui.js');
  assert.match(ui,/studentPageSize=100/);
  assert.match(ui,/Showing /);
  assert.match(ui,/studentPrev/);
  assert.match(ui,/studentNext/);
});

test('guardian email is optional in admissions and student onboarding',async()=>{
  const ui=await read('ui.js');
  const admissions=await read('admissions-ui.js');
  const server=await read('server.js');
  assert.match(ui,/Guardian email \(optional/);
  assert.match(ui,/guardianEmail:v\.guardianEmail\|\|undefined/);
  assert.match(admissions,/Email <span class="muted">\(optional\)<\/span>/);
  assert.match(server,/guardianEmail:\s*z\.string\(\)\.email\(\)\.optional\(\)/);
});

test('parent portal supports linked children, alerts, visual timetable and official report PDF',async()=>{
  const parent=await read('parent-ui.js');
  assert.match(parent,/linked children/);
  assert.match(parent,/Select a child to switch dashboard/);
  assert.match(parent,/My Alerts/);
  assert.match(parent,/Weekly Class Timetable/);
  assert.match(parent,/Download Official PDF/);
  assert.match(parent,/report-card\.pdf/);
});

test('parent and student homework stay publish-gated',async()=>{
  const server=await read('server.js');
  const matches=server.match(/h\.status='published'/g)||[];
  assert.ok(matches.length>=2);
});

test('student statements use search instead of a student dropdown',async()=>{
  const ui=await read('ui.js');
  assert.match(ui,/statementStudentSearch/);
  assert.match(ui,/Search by Student ID, first name, surname or class/);
});

test('promotion uses complete three-term academic-year evidence',async()=>{
  const server=await read('server.js');
  const ui=await read('ui.js');
  assert.match(server,/configuredTerms\s*===\s*3\s*&&\s*completeTerms\s*===\s*3\s*&&\s*readyTerms\s*===\s*3/);
  assert.match(server,/academic_year_average/);
  assert.match(ui,/Term 1/);
  assert.match(ui,/Term 2/);
  assert.match(ui,/Term 3/);
});

test('staff login is routed by active role profile and demo access includes active roles',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  assert.match(server,/roleProfile\.portal_mode\s*===\s*'teacher'\s*\?\s*'\/teacher'\s*:\s*'\/'/);
  assert.match(server,/JOIN school_roles sr/);
  assert.match(login,/profile\s*&&\s*profile\.portal_mode\s*===\s*'teacher'/);
});

test('lesson notes support real attachments',async()=>{
  const teacher=await read('teacher-ui.js');
  const server=await read('server.js');
  assert.match(teacher,/📎 Attachments/);
  assert.match(server,/\/api\/lesson-notes\/:id\/attachments/);
  assert.match(server,/\/api\/lesson-note-attachments\/:attachmentId\/download/);
});

test('external admission uses an application reference and only creates Student ID after approval and enrolment',async()=>{
  const admissions=await read('admissions-ui.js');
  const server=await read('server.js');
  assert.match(admissions,/This is not a Student ID/);
  assert.match(admissions,/Student ID will be generated after the school approves and enrols the applicant/);
  assert.match(server,/if\s*\(appRow\.status\s*!==\s*'approved'\)\s*throw fail\(409,\s*'Approve the application before enrolling the student'\s*\)/);
  assert.match(server,/const admissionNo\s*=\s*b\.admissionNo\s*\|\|\s*\('RX\//);
});
