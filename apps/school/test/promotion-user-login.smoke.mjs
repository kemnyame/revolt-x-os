import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){
  return readFile(new URL('../dist/'+name,import.meta.url),'utf8');
}

test('year promotion and School user login/reset flow are wired',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const ui=await read('ui.js');

  assert.match(server,/term_no IN \(1,2,3\)/);
  assert.match(server,/academic_aggregate_score/);
  assert.match(server,/promotionScore:\s*annualAverage/);
  assert.match(server,/STAFF_GENERIC_PASSWORD/);
  assert.match(server,/\/api\/auth\/admin-reset\/request/);
  assert.match(server,/\/api\/staff\/users\/:membershipId\/password-reset/);
  assert.match(server,/\/teacher-login/);
  assert.match(server,/\/admin-login/);

  assert.match(login,/Teacher Sign In/);
  assert.match(login,/Reset administrator password/);
  assert.match(login,/temporary generic password/);

  assert.match(ui,/3-Term Aggregate/);
  assert.match(ui,/Aggregate ÷ 3/);
  assert.match(ui,/Password reset complete/);
});
