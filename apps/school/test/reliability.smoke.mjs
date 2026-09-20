import test from 'node:test';
import assert from 'node:assert/strict';
import {
  communicationBackoffMinutes,
  normalizeDeliveryPhone,
  throttleFingerprint
} from '../dist/reliability.js';

test('communication retry backoff grows safely',()=>{
  assert.equal(communicationBackoffMinutes(1),1);
  assert.equal(communicationBackoffMinutes(2),5);
  assert.equal(communicationBackoffMinutes(3),15);
  assert.equal(communicationBackoffMinutes(4),60);
  assert.equal(communicationBackoffMinutes(8),240);
});

test('Ghana local numbers normalize for delivery',()=>{
  assert.equal(normalizeDeliveryPhone('024 123 4567'),'+233241234567');
  assert.equal(normalizeDeliveryPhone('+233241234567'),'+233241234567');
});

test('throttle fingerprints are stable and non-reversible identifiers',()=>{
  const a=throttleFingerprint('Parent@Example.COM');
  const b=throttleFingerprint(' parent@example.com ');
  assert.equal(a,b);
  assert.equal(a.length,64);
  assert.notEqual(a,'parent@example.com');
});
