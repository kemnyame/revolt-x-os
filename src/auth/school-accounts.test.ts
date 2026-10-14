import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
import type {Db} from '../db/index.js';
import {createSchoolAccount,findSchoolAccount} from './school-accounts.js';

const pg=new PGlite(),provider='11111111-1111-4111-8111-111111111111',alpha='22222222-2222-4222-8222-222222222222',beta='33333333-3333-4333-8333-333333333333',legacy='44444444-4444-4444-8444-444444444444';
const db={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0}}} as unknown as Db;
beforeAll(async()=>{
  const dir=new URL('../../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')&&x<'016').sort())await pg.exec(readFileSync(new URL(file,dir),'utf8'));
  await pg.query("INSERT INTO organisations(id,name,slug) VALUES($1,'Provider','provider'),($2,'Alpha','alpha'),($3,'Beta','beta')",[provider,alpha,beta]);
  await pg.query("INSERT INTO users(id,email,password_hash,first_name,last_name) VALUES($1,'legacy@example.test','unchanged-os-hash','Original','Profile')",[legacy]);
  await pg.query("INSERT INTO saas_customers(provider_organisation_id,customer_organisation_id,customer_type) VALUES($1,$2,'school'),($1,$3,'school')",[provider,alpha,beta]);
  for(const org of [provider,alpha,beta])await pg.query("INSERT INTO organisation_memberships(organisation_id,user_id,employee_number) VALUES($1,$2,'STF-000001')",[org,legacy]);
  await pg.query("INSERT INTO school_credentials(organisation_id,user_id,password_hash,must_change_password,initialized_at) VALUES($1,$3,'alpha-original-hash',false,now()),($2,$3,'beta-original-hash',false,now())",[alpha,beta,legacy]);
  await pg.exec(readFileSync(new URL('016_school_account_identity.sql',dir),'utf8'));
});
afterAll(()=>pg.close());

it('migrates legacy shared identities without changing their keys, memberships or password hashes',async()=>{
  const accounts=(await pg.query('SELECT * FROM school_accounts WHERE user_id=$1 ORDER BY organisation_id',[legacy])).rows as any[];
  expect(accounts).toHaveLength(2);expect(accounts.every(a=>a.email==='legacy@example.test'&&a.user_id===legacy)).toBe(true);
  expect((await pg.query('SELECT count(*) count FROM organisation_memberships WHERE user_id=$1',[legacy])).rows[0]).toMatchObject({count:3});
  expect((await pg.query('SELECT password_hash FROM users WHERE id=$1',[legacy])).rows[0]).toMatchObject({password_hash:'unchanged-os-hash'});
  expect((await pg.query('SELECT password_hash FROM school_credentials ORDER BY organisation_id')).rows).toEqual([{password_hash:'alpha-original-hash'},{password_hash:'beta-original-hash'}]);
});

it('changing one legacy school profile or account status leaves the OS and other school profile intact',async()=>{
  await pg.query("UPDATE school_accounts SET first_name='Alpha only',status='disabled' WHERE organisation_id=$1 AND user_id=$2",[alpha,legacy]);
  expect(await findSchoolAccount(db,alpha,'LEGACY@example.test')).toMatchObject({id:legacy,first_name:'Alpha only',status:'disabled'});
  expect(await findSchoolAccount(db,beta,'legacy@example.test')).toMatchObject({id:legacy,first_name:'Original',status:'active'});
  expect((await pg.query('SELECT first_name,status FROM users WHERE id=$1',[legacy])).rows[0]).toMatchObject({first_name:'Original',status:'active'});
  await pg.query("UPDATE users SET first_name='OS change',status='suspended' WHERE id=$1",[legacy]);
  expect(await findSchoolAccount(db,beta,'legacy@example.test')).toMatchObject({first_name:'Original',status:'active'});
});

it('allows an existing email in another school while enforcing normalized uniqueness within this school',async()=>{
  const a=await createSchoolAccount(db,alpha,{email:' NEW@example.test ',firstName:'Alpha',lastName:'Staff'});
  const b=await createSchoolAccount(db,beta,{email:'new@example.test',firstName:'Beta',lastName:'Staff'});
  expect(a.id).not.toBe(b.id);expect(a.email).toBe(b.email);expect(await findSchoolAccount(db,beta,' NEW@example.test ')).toMatchObject({id:b.id});
  await expect(createSchoolAccount(db,alpha,{email:'NEW@example.test',firstName:'Duplicate',lastName:'Staff'})).rejects.toMatchObject({code:'23505'});
  // Missing email is valid for multiple staff accounts; Staff ID remains their login identifier.
  await createSchoolAccount(db,alpha,{firstName:'No email',lastName:'One'});await createSchoolAccount(db,alpha,{firstName:'No email',lastName:'Two'});
});
