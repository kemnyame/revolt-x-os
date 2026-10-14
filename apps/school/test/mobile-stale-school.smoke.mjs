import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerSchoolMobile} from '../dist/mobile-app.js';

function staleSchool(){
  throw Object.assign(new Error('School code was not found'),{statusCode:404});
}

test('mobile entry ignores a stale remembered school instead of returning a 404',async t=>{
  const app=Fastify();t.after(()=>app.close());
  await registerSchoolMobile(app,{resolveSchool:async request=>{
    if(request.headers.cookie?.includes('rx_school_login='))return staleSchool();
    return null;
  }});
  const response=await app.inject({url:'/mobile',headers:{cookie:'rx_school_login=%2Fs%2Fold-school%2Flogin'}});
  assert.equal(response.statusCode,200);
  assert.match(String(response.headers['set-cookie']||''),/rx_school_login=;/);
  assert.doesNotMatch(response.body,/School code was not found/);
});

test('mobile entry clears an explicit stale school hint without exposing the raw tenant error',async t=>{
  const app=Fastify();t.after(()=>app.close());
  await registerSchoolMobile(app,{resolveSchool:async request=>request.query?.school?staleSchool():null});
  const response=await app.inject('/mobile/teacher?school=old-school');
  assert.equal(response.statusCode,200);
  assert.match(response.body,/localStorage\.removeItem\('rx_school_id'\)/);
  assert.match(response.body,/searchParams\.delete\('school'\)/);
  assert.doesNotMatch(response.body,/School code was not found/);
});
