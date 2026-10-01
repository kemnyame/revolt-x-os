import test from 'node:test';
import assert from 'node:assert/strict';
import { loginFrontend } from '../dist/login-ui.js';

test('School login browser script parses', () => {
  const match=loginFrontend.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1]);
  assert.doesNotThrow(()=>new Function(match[1]));
});

test('School staff login uses Staff ID and password only', () => {
  assert.match(loginFrontend,/Staff ID/);
  assert.match(loginFrontend,/Password/);
  assert.match(loginFrontend,/\/api\/auth\/staff-id-login/);
  assert.match(loginFrontend,/Email is not used/);
  assert.match(loginFrontend,/type="password"/);
  assert.doesNotMatch(loginFrontend,/School ID/);
});
