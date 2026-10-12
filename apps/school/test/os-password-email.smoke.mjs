import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSchoolConfig} from '../dist/config.js';
import {osPasswordResetMessage,sendOsPasswordReset} from '../dist/os-password-email.js';
const config=loadSchoolConfig({NODE_ENV:'test',SCHOOL_DATABASE_URL:'postgresql://localhost/test',CORE_OS_URL:'https://core.example.test',EMAIL_PROVIDER:'resend',EMAIL_DELIVERY_MODE:'production',RESEND_API_KEY:'test-only-mail-api-key',RESEND_FROM_EMAIL:'Revolt-X <no-reply@example.test>'});
const token='t'.repeat(43);
test('OS recovery email uses its trusted origin, both content formats, expiry and a hashed idempotency key',()=>{
  const message=osPasswordResetMessage(config,'owner@example.test',token);
  assert.equal(message.subject,'Reset your Revolt-X OS password');assert.equal(message.to,'owner@example.test');
  assert.ok(message.body.includes('https://core.example.test/password-reset?token='+token));assert.match(message.body,/30 minutes/);assert.match(message.body,/school passwords will stay the same/);assert.match(message.html,/Reset OS password/);assert.match(message.html,/padding:15px 24px/);assert.match(message.messageKey,/^os-password-reset\/[a-f0-9]{64}$/);assert.ok(!message.messageKey.includes(token));
  assert.equal(osPasswordResetMessage(config,'owner@example.test',token).messageKey,message.messageKey);
  assert.throws(()=>osPasswordResetMessage({...config,NODE_ENV:'production',CORE_OS_URL:'http://insecure.example'},'owner@example.test',token),/secure configured origin/);
});
test('OS recovery delivery uses the existing email provider with idempotence and no real network calls',async t=>{
  const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({id:'test-email-id'}),{status:200})});
  await sendOsPasswordReset(config,'owner@example.test',token);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');assert.match(calls[0].options.headers['Idempotency-Key'],/^school-message\/os-password-reset\/[a-f0-9]{64}$/);
  const body=JSON.parse(calls[0].options.body);assert.ok(body.text.includes('/password-reset?token='));assert.ok(body.html.includes('Reset OS password'));
});
