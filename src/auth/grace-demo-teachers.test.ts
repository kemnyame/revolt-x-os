import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import type {Db} from '../db/index.js';
import {repairGraceDemoTeachers,graceDemoTeachers} from './grace-demo-teachers.js';
import {databaseRecordId} from '../core/record-id.js';

const pg=new PGlite(),school='f0941926-e7cf-46cf-b994-888ba642dd7d';
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows as any[],rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
beforeAll(async()=>{for(const file of readdirSync(new URL('../../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())await pg.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'))},60000);
beforeEach(async()=>{
  await pg.exec('CREATE SCHEMA IF NOT EXISTS revolt_x_os;SET search_path TO public;TRUNCATE organisations,users CASCADE;DELETE FROM roles;');
  await client.query("INSERT INTO organisations(id,slug,name) VALUES($1,'grace-prep-school','Grace Prep School')",[school]);
  await pg.exec("INSERT INTO roles(key,name,is_system) VALUES('member','Member',true)");
});
afterAll(()=>pg.close());

it('links all requested demo profiles and their existing keys with separate random School credentials',async()=>{
  expect(await repairGraceDemoTeachers(db)).toBe(15);
  expect((await client.query('SELECT count(*) count FROM organisation_memberships WHERE organisation_id=$1',[school])).rows[0].count).toBe(15);
  const rows=(await client.query('SELECT u.id,u.password_hash os_hash,sc.password_hash school_hash,sc.must_change_password,m.employee_number FROM users u JOIN school_credentials sc ON sc.user_id=u.id JOIN organisation_memberships m ON m.user_id=u.id ORDER BY m.employee_number')).rows;
  expect(rows).toHaveLength(15);
  rows.forEach((row,i)=>{expect(databaseRecordId.parse(row.id)).toBe(graceDemoTeachers[i]![0]);expect(row.school_hash).not.toBe(row.os_hash);expect(row.must_change_password).toBe(true);expect(row.employee_number).toBe('STF-'+String(100001+i))});
  expect((await client.query("SELECT after_state FROM audit_logs WHERE action='school_demo.teachers_linked'")).rows[0].after_state).toEqual({created:15,profiles:15});
},30000);

it('preserves existing passwords and account status and never repeats after a later change or restart',async()=>{
  const id=graceDemoTeachers[0][0];
  await client.query("INSERT INTO users(id,email,password_hash,first_name,last_name,status) VALUES($1,'teacher01.demo@graceprep.example','existing-os-hash','Akosua','Boateng','disabled')",[id]);
  await client.query("INSERT INTO school_credentials(organisation_id,user_id,password_hash,must_change_password) VALUES($1,$2,'existing-school-hash',false)",[school,id]);
  expect(await repairGraceDemoTeachers(db)).toBe(14);
  let row=(await client.query('SELECT password_hash,status FROM users WHERE id=$1',[id])).rows[0];expect(row).toMatchObject({password_hash:'existing-os-hash',status:'disabled'});
  expect((await client.query('SELECT password_hash FROM school_credentials WHERE user_id=$1',[id])).rows[0].password_hash).toBe('existing-school-hash');
  await client.query("UPDATE school_credentials SET password_hash='later-school-hash' WHERE user_id=$1",[id]);
  expect(await repairGraceDemoTeachers(db)).toBe(0);
  expect((await client.query('SELECT password_hash FROM school_credentials WHERE user_id=$1',[id])).rows[0].password_hash).toBe('later-school-hash');
},30000);

it('leaves other schools untouched and rolls back a mismatched teacher key',async()=>{
  await client.query("UPDATE organisations SET slug='another-school' WHERE id=$1",[school]);expect(await repairGraceDemoTeachers(db)).toBe(0);
  await client.query("UPDATE organisations SET slug='grace-prep-school' WHERE id=$1",[school]);
  await client.query("INSERT INTO users(id,email,password_hash,first_name,last_name) VALUES($1,'someone@example.test','existing-hash','Other','User')",[graceDemoTeachers[0][0]]);
  await expect(repairGraceDemoTeachers(db)).rejects.toThrow('belongs to another account');
  expect((await client.query('SELECT count(*) count FROM users')).rows[0].count).toBe(1);
  expect((await client.query('SELECT count(*) count FROM organisation_memberships')).rows[0].count).toBe(0);
});
