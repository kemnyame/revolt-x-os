import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {Db} from '../db/index.js';
import {buildApp} from '../app.js';
import {loadConfig} from '../config.js';
import {registerOrganisation,verifyAccessToken} from './service.js';
import {osPasswordChangeFrontend} from '../os-password-change-ui.js';

const pg=new PGlite();
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows as any[],rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'temporary-password-test-secret-at-least-32-characters'});
const temporaryPassword='AssignedTemporary123!',personalPassword='MyPersonalPassword456!';
let app:FastifyInstance,owner:any;
const headers=(token:string)=>({authorization:'Bearer '+token});
const signIn=(password=temporaryPassword)=>app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'new-admin@example.test',password}});
const create=()=>app.inject({method:'POST',url:'/v1/users',headers:headers(owner.accessToken),payload:{email:'new-admin@example.test',firstName:'New',lastName:'Admin',roleKey:'owner',temporaryPassword}});
beforeAll(async()=>{
  for(const file of readdirSync(new URL('../../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())
    await pg.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await pg.exec('CREATE SCHEMA IF NOT EXISTS revolt_x_os;SET search_path TO public');
  app=await buildApp({db,config});await app.ready();
},60000);
beforeEach(async()=>{
  await pg.exec('SET search_path TO public;DELETE FROM organisations;DELETE FROM users;DELETE FROM audit_logs');
  owner=await registerOrganisation(db,config,{organisationName:'Provider',slug:'provider',firstName:'Existing',lastName:'Owner',email:'owner@example.test',password:'ExistingOwnerPassword123!'});
});
afterAll(async()=>{await app.close();await pg.close()});

it('keeps a new administrator restricted until a personal password is set, then invalidates every temporary session',async()=>{
  expect((await create()).statusCode).toBe(201);
  const initial=await signIn();expect(initial.statusCode).toBe(200);
  const session=initial.json();expect(session.requiresPasswordChange).toBe(true);expect(session.expiresIn).toBe(300);
  const auth=await verifyAccessToken(config,session.accessToken);expect(auth.permissions).toEqual([]);expect(auth.passwordChangeRequired).toBe(true);
  const h=headers(session.accessToken);
  expect((await app.inject({url:'/v1/auth/context',headers:h})).json().requiresPasswordChange).toBe(true);
  const denied=await app.inject({url:'/v1/executive/overview',headers:h});expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  expect((await app.inject({method:'POST',url:'/v1/auth/refresh',payload:{refreshToken:session.refreshToken}})).statusCode).toBe(403);
  for(const [currentPassword,newPassword] of [[temporaryPassword,temporaryPassword],['WrongTemporary123!',personalPassword],[temporaryPassword,'weak']]){
    expect((await app.inject({method:'POST',url:'/v1/auth/change-password',headers:h,payload:{currentPassword,newPassword}})).statusCode).toBe(400);
  }
  const changed=await app.inject({method:'POST',url:'/v1/auth/change-password',headers:h,payload:{currentPassword:temporaryPassword,newPassword:personalPassword}});
  expect(changed.statusCode).toBe(200);expect(changed.json()).toEqual({changed:true,requiresSignIn:true});
  expect((await app.inject({url:'/v1/auth/context',headers:h})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/v1/auth/refresh',payload:{refreshToken:session.refreshToken}})).statusCode).toBe(401);
  expect((await signIn()).statusCode).toBe(401);
  const fresh=await signIn(personalPassword);expect(fresh.statusCode).toBe(200);expect(fresh.json().requiresPasswordChange).toBe(false);
  expect((await app.inject({url:'/v1/executive/overview',headers:headers(fresh.json().accessToken)})).statusCode).toBe(200);
  const user=(await client.query("SELECT password_hash,must_change_password FROM users WHERE email='new-admin@example.test'")).rows[0];
  expect(user.must_change_password).toBe(false);expect(await bcrypt.compare(personalPassword,user.password_hash)).toBe(true);
  const audit=JSON.stringify((await client.query('SELECT before_state,after_state,metadata FROM audit_logs')).rows);
  expect(audit).not.toContain(temporaryPassword);expect(audit).not.toContain(personalPassword);
});

it('cannot upgrade a temporary session by refreshing after another request changes the account flag',async()=>{
  await create();const session=(await signIn()).json();
  await client.query("UPDATE users SET must_change_password=false WHERE email='new-admin@example.test'");
  expect((await app.inject({method:'POST',url:'/v1/auth/refresh',payload:{refreshToken:session.refreshToken}})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/users',headers:headers(session.accessToken)})).statusCode).toBe(403);
});

it('requires an administrator-supplied strong temporary password and never overwrites an existing OS account',async()=>{
  const duplicate=await app.inject({method:'POST',url:'/v1/users',headers:headers(owner.accessToken),payload:{email:'owner@example.test',firstName:'Changed',lastName:'Elsewhere',temporaryPassword,roleKey:'admin'}});
  expect(duplicate.statusCode).toBe(409);
  expect((await client.query("SELECT first_name FROM users WHERE email='owner@example.test'")).rows[0].first_name).toBe('Existing');
  const missing=await app.inject({method:'POST',url:'/v1/users',headers:headers(owner.accessToken),payload:{email:'new-admin@example.test',firstName:'New',lastName:'Admin'}});
  expect(missing.statusCode).toBe(400);
  expect(new Function(osPasswordChangeFrontend.match(/<script>([\s\S]*?)<\/script>/)![1]!)).toBeTypeOf('function');
});
