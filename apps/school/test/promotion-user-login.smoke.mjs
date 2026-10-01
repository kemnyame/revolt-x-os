import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('year promotion and canonical Staff ID login are wired',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const ui=await read('ui.js');

  assert.match(server,/term_no IN \(1,2,3\)/);
  assert.match(server,/academic_aggregate_score/);
  assert.match(server,/promotionScore:\s*annualAverage/);
  assert.match(server,/\/api\/auth\/staff-id-login/);
  assert.match(server,/school\.staff_id_authenticated/);
  assert.doesNotMatch(server,/\/api\/auth\/admin-reset\/request/);
  assert.doesNotMatch(server,/\/api\/auth\/teacher-login/);

  assert.match(login,/School ID/);
  assert.match(login,/Staff ID/);
  assert.doesNotMatch(login,/temporary generic password/);
  assert.doesNotMatch(login,/Email address.*Password/);

  assert.match(ui,/3-Term Aggregate/);
  assert.match(ui,/Aggregate ÷ 3/);
  assert.match(ui,/School ID \+ Staff ID/);
  assert.match(ui,/Staff ID/);
});
