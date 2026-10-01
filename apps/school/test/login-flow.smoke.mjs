import test from 'node:test';
import assert from 'node:assert/strict';
import { loginFrontend } from '../dist/login-ui.js';

test('School login browser script parses', () => {
  const match=loginFrontend.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1]);
  assert.doesNotThrow(()=>new Function(match[1]));
});

test('School staff login uses only School ID and Staff ID', () => {
  assert.match(loginFrontend,/School ID/);
  assert.match(loginFrontend,/Staff ID/);
  assert.match(loginFrontend,/\/api\/auth\/staff-id-login/);
  assert.match(loginFrontend,/Email addresses and passwords are not used for staff sign-in/);
  assert.doesNotMatch(loginFrontend,/type="password"/);
  assert.doesNotMatch(loginFrontend,/Reset administrator password/);
});
