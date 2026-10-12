import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRequestUrl} from '../dist/request-log.js';
test('password-reset tokens are removed from logged URLs while school paths remain useful',()=>{
  for(const path of ['/s/alpha/admin-password-reset?token=test-only-reset-secret','/admin-password-reset?school=alpha&token=test-only-reset-secret&mode=setup']){
    const safe=safeRequestUrl(path);assert.equal(safe.includes('test-only-reset-secret'),false);assert.match(safe,/token=\[redacted\]/);assert.match(safe,/password-reset/);
  }
  assert.equal(safeRequestUrl('/s/alpha/admin-login?admin=user-id'),'/s/alpha/admin-login?admin=user-id');
});
