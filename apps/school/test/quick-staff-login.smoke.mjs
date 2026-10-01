import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){return readFile(new URL('../dist/'+name,import.meta.url),'utf8')}

test('legacy Quick Login is removed and Staff ID login is canonical',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const config=await read('config.js');

  assert.doesNotMatch(config,/ENABLE_QUICK_STAFF_LOGIN/);
  assert.doesNotMatch(config,/STAFF_GENERIC_PASSWORD/);
  assert.doesNotMatch(server,/\/api\/quick-login\/staff-login/);
  assert.doesNotMatch(server,/validateQuickLoginPassword/);
  assert.match(server,/resolveSchoolForStaffIdLogin/);
  assert.match(server,/handleSchoolStaffIdLogin/);
  assert.match(server,/\/api\/auth\/staff-id-login/);
  assert.match(server,/createSchoolStaffSession\(coreContext,'staff_id'\)/);

  assert.match(login,/School ID/);
  assert.match(login,/Staff ID/);
  assert.match(login,/Sign in to Revolt-X School/);
  assert.doesNotMatch(login,/Quick Login password/);
  assert.doesNotMatch(login,/data-quick-user/);
});
