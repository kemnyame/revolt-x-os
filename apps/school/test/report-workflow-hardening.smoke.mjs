import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('report workflow hardening is present',async()=>{
  const server=await read('server.js');
  const teacher=await read('teacher-ui.js');
  const ui=await read('ui.js');
  const parent=await read('parent-ui.js');
  const providers=await read('providers.js');

  assert.match(server,/COALESCE\(rc\.workflow_status,'not_started'\) IN \('not_started','draft','returned'\)/);
  assert.match(server,/report_signatures/);
  assert.match(server,/promotion_override_reason/);
  assert.match(server,/reviewer_override/);
  assert.match(server,/\/api\/fees\/create/);
  assert.match(server,/Student ID is required/);

  assert.match(teacher,/My Report Signature/);
  assert.match(teacher,/removed from your remaining-work queue/);
  assert.match(teacher,/System Promotion Decision/);
  assert.match(teacher,/Returned reports will reappear here/);

  assert.match(ui,/Report Signatures/);
  assert.match(ui,/Add fee and assign/);
  assert.match(ui,/Reason for promotion override/);

  assert.match(parent,/studentId:E\('admission'\)\.value/);
  assert.match(parent,/Class Teacher Signature/);

  assert.match(providers,/RESEND_TEST_RECIPIENT/);
});
