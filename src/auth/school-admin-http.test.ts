import {beforeAll,afterAll,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {Db} from '../db/index.js';
import {buildApp} from '../app.js';
import {loadConfig} from '../config.js';

const db={query:async()=>({rows:[],rowCount:0})} as unknown as Db;
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'test-secret-at-least-thirty-two-characters',SCHOOL_SERVICE_KEY:'s'.repeat(32)});
let app:FastifyInstance;
beforeAll(async()=>{app=await buildApp({db,config});await app.ready()});
afterAll(()=>app.close());
it('School login failures use the Core error envelope after real application registration',async()=>{
  const r=await app.inject({method:'POST',url:'/v1/internal/school/authenticate-admin',headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY},payload:{schoolId:'alpha',email:'primary@example.test',password:'IncorrectResetPass123'}});
  expect(r.statusCode).toBe(401);expect(r.json()).toMatchObject({error:{code:'INVALID_CREDENTIALS',message:'Invalid school administrator email or password'}});
});
it('invalid administrator links and service credentials retain their precise errors across plugins',async()=>{
  const path='/v1/internal/school/admin-login-context?schoolId=alpha&adminUserId=11111111-1111-4111-8111-111111111111';
  const denied=await app.inject({url:path});expect(denied.statusCode).toBe(401);expect(denied.json()).toMatchObject({error:{code:'UNAUTHORIZED',message:'School service credential required'}});
  const missing=await app.inject({url:path,headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY}});expect(missing.statusCode).toBe(404);expect(missing.json().error.code).toBe('NOT_FOUND');expect(missing.json().error.message).toContain('School administrator login link');
});
it('expired reset tokens return their real reset error instead of a generic credentials message',async()=>{
  const r=await app.inject({method:'POST',url:'/v1/auth/password-reset/confirm',payload:{token:'test-only-reset-token-'.repeat(3),password:'PersonalResetPass123',purpose:'school_admin'}});
  expect(r.statusCode).toBe(401);expect(r.json().error.message).toContain('Reset link is invalid, expired');
});

it('Core request throttling retains HTTP 429 and a usable retry message instead of becoming an internal or credential error',async()=>{
  const limited=await buildApp({db,config});
  try{
    limited.get('/fixture-login-rate-limit',{config:{rateLimit:{max:1,timeWindow:'1 minute'}}},async()=>({ready:true}));
    expect((await limited.inject('/fixture-login-rate-limit')).statusCode).toBe(200);
    const response=await limited.inject('/fixture-login-rate-limit');
    expect(response.statusCode).toBe(429);expect(response.json()).toMatchObject({error:{code:'RATE_LIMITED'}});
    expect(response.json().error.message).toContain('Try again');expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  }finally{await limited.close()}
});
