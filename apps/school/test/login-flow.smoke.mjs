import test from 'node:test';
import assert from 'node:assert/strict';
import { loginFrontend } from '../dist/login-ui.js';

test('School login browser script parses', () => {
  const match=loginFrontend.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1]);
  assert.doesNotThrow(()=>new Function(match[1]));
});

test('School staff login uses school selection, Staff ID and password', () => {
  assert.match(loginFrontend,/Select your school/);
  assert.match(loginFrontend,/<select id="schoolId"/);
  assert.match(loginFrontend,/Staff ID/);
  assert.match(loginFrontend,/Password/);
  assert.match(loginFrontend,/\/api\/auth\/staff-id-login/);
  assert.match(loginFrontend,/type="password"/);
  assert.match(loginFrontend,/schoolId:schoolId,staffId:staffId,password:password/);
  assert.doesNotMatch(loginFrontend,/Email address/);
});
