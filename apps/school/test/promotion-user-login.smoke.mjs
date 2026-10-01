import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('year promotion and School plus Staff ID plus password login are wired',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const ui=await read('ui.js');

  assert.match(server,/term_no IN \(1,2,3\)/);
  assert.match(server,/academic_aggregate_score/);
  assert.match(server,/promotionScore:\s*annualAverage/);
  assert.match(server,/\/api\/auth\/schools/);
  assert.match(server,/\/api\/auth\/staff-id-login/);
  assert.match(server,/authenticate-staff/);
  assert.match(server,/staff\.signed_in/);
  assert.match(server,/requiresPasswordChange/);
  assert.match(server,/\/api\/auth\/change-password/);
  assert.match(server,/STAFF_GENERIC_PASSWORD/);
  assert.match(server,/\/api\/staff\/users\/:membershipId\/password-reset/);

  assert.match(login,/<select id="schoolId"/);
  assert.match(login,/Staff ID/);
  assert.match(login,/Password/);
  assert.match(login,/type="password"/);
  assert.match(login,/passwordChangeUrl/);
  assert.doesNotMatch(login,/Email address/);

  assert.match(ui,/3-Term Aggregate/);
  assert.match(ui,/Aggregate ÷ 3/);
  assert.match(ui,/Staff ID \+ Password/);
  assert.match(ui,/Reset password/);
});

