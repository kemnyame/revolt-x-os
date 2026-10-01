import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('year promotion and Staff ID plus password login are wired',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const ui=await read('ui.js');

  assert.match(server,/term_no IN \(1,2,3\)/);
  assert.match(server,/academic_aggregate_score/);
  assert.match(server,/promotionScore:\s*annualAverage/);
  assert.match(server,/\/api\/auth\/staff-id-login/);
  assert.match(server,/authenticate-staff/);
  assert.match(server,/school\.staff_id_authenticated/);
  assert.match(server,/STAFF_GENERIC_PASSWORD/);
  assert.match(server,/\/api\/staff\/users\/:membershipId\/password-reset/);

  assert.match(login,/Staff ID/);
  assert.match(login,/Password/);
  assert.match(login,/type="password"/);
  assert.doesNotMatch(login,/School ID/);

  assert.match(ui,/3-Term Aggregate/);
  assert.match(ui,/Aggregate ÷ 3/);
  assert.match(ui,/Staff ID \+ Password/);
  assert.match(ui,/Reset password/);
});
