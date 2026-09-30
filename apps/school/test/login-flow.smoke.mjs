import test from 'node:test';
import assert from 'node:assert/strict';
import { loginFrontend } from '../dist/login-ui.js';

test('School login browser script parses', () => {
  const match=loginFrontend.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1]);
  assert.doesNotThrow(()=>new Function(match[1]));
});

test('first administrator setup explains and continues into sign-in', () => {
  assert.match(loginFrontend,/What do I use to sign in\?/);
  assert.match(loginFrontend,/administrator email entered in Revolt-X OS/);
  assert.match(loginFrontend,/There is no separate default School password/);
  assert.match(loginFrontend,/E\('signin'\)\.onclick=signIn/);
  assert.match(loginFrontend,/await signIn\(\)/);
});
