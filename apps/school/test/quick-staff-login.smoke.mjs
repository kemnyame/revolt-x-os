import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name){return readFile(new URL('../dist/'+name,import.meta.url),'utf8')}

test('Quick Login exposes every active School staff profile behind the generic password',async()=>{
  const server=await read('server.js');
  const login=await read('login-ui.js');
  const config=await read('config.js');

  assert.match(config,/ENABLE_QUICK_STAFF_LOGIN/);
  assert.match(server,/\/api\/quick-login\/status/);
  assert.match(server,/\/api\/quick-login\/unlock/);
  assert.match(server,/\/api\/quick-login\/staff/);
  assert.match(server,/\/api\/quick-login\/staff-login/);
  assert.match(server,/staff\.quick_authenticated/);
  assert.match(server,/quick_login/);

  assert.match(login,/Quick Login/);
  assert.match(login,/Open any staff profile/);
  assert.match(login,/Generic staff password/);
  assert.match(login,/data-quick-user/);
  assert.match(login,/configureQuickLogin/);
});
