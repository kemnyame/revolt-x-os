import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){return readFile(new URL('../dist/'+name,import.meta.url),'utf8')}

test('Quick Login finds staff by school name and requires the shared password to enter a profile',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const config=await read('config.js');

  assert.match(config,/ENABLE_QUICK_STAFF_LOGIN/);
  assert.match(server,/resolveQuickLoginSchool/);
  assert.match(server,/school_name ILIKE/);
  assert.match(server,/\/api\/quick-login\/staff/);
  assert.match(server,/\/api\/quick-login\/staff-login/);
  assert.match(server,/validateQuickLoginPassword/);
  assert.match(server,/staff\.quick_authenticated/);

  assert.match(login,/School name \/ code/);
  assert.match(login,/Select your name/);
  assert.match(login,/Enter the school name to display users/);
  assert.match(login,/Quick Login password/);
  assert.match(login,/data-quick-user/);
  assert.match(login,/configureQuickLogin/);
});
