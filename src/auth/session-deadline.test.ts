import {beforeAll,afterAll,it,expect} from 'vitest';
import {SignJWT} from 'jose';
import type {FastifyInstance} from 'fastify';
import type {Db} from '../db/index.js';
import {buildApp} from '../app.js';
import {loadConfig} from '../config.js';

const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'session-deadline-test-secret-at-least-32-characters'});
const expiry='2030-01-01T00:00:00.000Z';
let active=true,app:FastifyInstance,token:string;
const db={query:async(sql:string)=>{
  if(sql.includes('FROM sessions s'))return{rows:active?[{expires_at:new Date(expiry)}]:[],rowCount:active?1:0};
  return{rows:[{id:'11111111-1111-4111-8111-111111111111',organisation_id:'22222222-2222-4222-8222-222222222222'}],rowCount:1};
}} as unknown as Db;
beforeAll(async()=>{
  app=await buildApp({db,config});await app.ready();
  token=await new SignJWT({organisationId:'22222222-2222-4222-8222-222222222222',sessionId:'33333333-3333-4333-8333-333333333333',permissions:[]}).setProtectedHeader({alg:'HS256'}).setSubject('11111111-1111-4111-8111-111111111111').setExpirationTime('5m').sign(new TextEncoder().encode(config.JWT_SECRET));
});
afterAll(()=>app.close());
it('authenticated OS responses include the actual session deadline for browser expiry',async()=>{
  const response=await app.inject({url:'/v1/auth/context',headers:{authorization:'Bearer '+token}});
  expect(response.statusCode).toBe(200);expect(response.headers['x-revolt-session-expires-at']).toBe(expiry);
});
it('an ended OS session returns 401 without a future browser deadline',async()=>{
  active=false;
  const response=await app.inject({url:'/v1/auth/context',headers:{authorization:'Bearer '+token}});
  expect(response.statusCode).toBe(401);expect(response.headers['x-revolt-session-expires-at']).toBeUndefined();expect(response.json().error.message).toBe('Session is no longer active');
});
