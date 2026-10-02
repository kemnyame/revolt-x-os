import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('October School workflow hardening is installed',async()=>{
  const server=await read('server.js');
  const teacher=await read('teacher-ui.js');
  const ui=await read('ui.js');
  const providers=await read('providers.js');
  const migration=await readFile(new URL('../migrations/050_workflow_notifications_email_branding.sql',import.meta.url),'utf8');

  assert.match(server,/function randomTemporaryPassword\(\)/);
  assert.match(server,/function dateOnlyValue\(value\)/);
  assert.match(server,/promotion_basis=\$5::text/);
  assert.match(server,/const optionalEmailSchema\s*=\s*z\.preprocess/);
  assert.match(server,/assessment\.scores_missing/);
  assert.match(server,/\/api\/notifications/);
  assert.match(server,/\/api\/teacher\/notifications/);
  assert.match(server,/COALESCE\(rc\.workflow_status,'not_started'\) IN \('not_started','draft','returned'\)/);
  assert.match(server,/This class already exists for the selected academic year/);
  assert.match(server,/portal_mode === 'teacher'/);
  assert.match(server,/OFFICIAL ACADEMIC RECORD/);
  assert.match(server,/Headteacher \/ Reviewer/);

  assert.match(teacher,/rx_teacher_page/);
  assert.match(teacher,/Pending assessment scores/);
  assert.match(teacher,/Notifications & Pending Work/);
  assert.match(teacher,/removed from your remaining-work queue/);
  assert.doesNotMatch(teacher,/Class teacher \/ all subjects/i);
  assert.doesNotMatch(teacher,/View school timetable/i);

  assert.match(ui,/rx_school_admin_page/);
  assert.match(ui,/Email Branding/);
  assert.match(ui,/Save & Approve/);
  assert.match(ui,/OFFICIAL ACADEMIC RECORD/);
  assert.match(ui,/Notifications & Pending Work/);

  assert.match(providers,/html\?: string/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS staff_notifications/);
  assert.match(migration,/email_accent_color/);
  assert.match(migration,/lesson_notes\.review/);
});
