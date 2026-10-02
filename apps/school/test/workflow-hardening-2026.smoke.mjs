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
  const accessBackfill=await readFile(new URL('../migrations/051_lesson_note_review_access_backfill.sql',import.meta.url),'utf8');
  const config=await read('config.js');

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
  assert.doesNotMatch(server,/\/api\/test-access\//);
  assert.doesNotMatch(server,/provisionDemoTeachers/);
  assert.match(server,/app\.get\('\/demo'.*redirect\('\/login'/);
  assert.match(server,/app\.get\('\/main'.*redirect\('\/login'/);
  assert.match(server,/app\.get\('\/quick-login'.*redirect\('\/login'/);

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

  assert.match(providers,/input\.html\s*\|\|/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS staff_notifications/);
  assert.match(migration,/email_accent_color/);
  assert.match(migration,/lesson_notes\.review/);
  assert.match(accessBackfill,/headteacher','lesson_notes\.review',true/);
  assert.match(accessBackfill,/teacher','lesson_notes\.review',false/);
  assert.doesNotMatch(config,/STAFF_GENERIC_PASSWORD/);
  assert.doesNotMatch(config,/ENABLE_TEST_PORTAL_ACCESS/);
  assert.doesNotMatch(config,/TEST_ACCESS_PASSWORD/);
  assert.doesNotMatch(config,/Welcome@2026!/);
});
