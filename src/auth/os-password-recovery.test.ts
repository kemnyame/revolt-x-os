import {readFileSync,readdirSync} from 'node:fs';
import bcrypt from 'bcryptjs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import type {Db} from '../db/index.js';
import {applyOsPasswordRecovery} from './os-password-recovery.js';
import {loadConfig} from '../config.js';

const pg=new PGlite(),provider='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
const requestId='55555555-5555-4555-8555-555555555555';
const password='TestOwnerRecovery123!';
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows as any[],rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
beforeAll(async()=>{
  const dir=new URL('../../migrations/',import.meta.url);for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())await pg.exec(readFileSync(new URL(file,dir),'utf8'));
},60000);
beforeEach(async()=>{
  await pg.exec('TRUNCATE organisations,users CASCADE; TRUNCATE auth_configuration_state;');
  await client.query("INSERT INTO organisations(id,name,slug) VALUES($1,'Provider','provider'),($2,'School','school')",[provider,school]);
  await client.query("INSERT INTO users(id,email,password_hash,first_name,last_name) VALUES($1,'owner@example.test','owner-original','Owner','One'),($2,'other@example.test','other-original','Owner','Two')",[user,other]);
  await pg.exec("INSERT INTO roles(key,name,is_system) VALUES('owner','Owner',true)");
  for(const uid of [user,other]){
    const m=(await client.query('INSERT INTO organisation_memberships(organisation_id,user_id) VALUES($1,$2) RETURNING id',[provider,uid])).rows[0];
    await client.query("INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id) SELECT $1,id,'organisation',$2 FROM roles WHERE key='owner'",[m.id,provider]);
    await client.query("INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[uid,provider,uid]);
  }
  await client.query("INSERT INTO saas_customers(provider_organisation_id,customer_organisation_id,customer_type,primary_contact_name,primary_contact_email) VALUES($1,$2,'school','Owner','owner@example.test')",[provider,school]);
  await client.query('INSERT INTO organisation_memberships(organisation_id,user_id) VALUES($1,$2)',[school,user]);
  await client.query("INSERT INTO school_credentials(organisation_id,user_id,password_hash,must_change_password,initialized_at) VALUES($1,$2,'school-original',false,now())",[school,user]);
  await client.query("INSERT INTO password_reset_tokens(user_id,token_hash,organisation_id,purpose,expires_at) VALUES($1,'os-token',$2,'account',now()+interval '1 hour'),($1,'school-token',$3,'school_admin',now()+interval '1 hour')",[user,provider,school]);
});
afterAll(()=>pg.close());
const userState=async(uid=user)=>(await client.query('SELECT password_hash,updated_at FROM users WHERE id=$1',[uid])).rows[0];

describe('one-time targeted OS owner recovery',()=>{
  it('changes only the requested owner, verifies the password and leaves school credentials and links intact',async()=>{
    expect(await applyOsPasswordRecovery(db,{userId:user,requestId,password})).toBe(1);
    expect(await bcrypt.compare(password,(await userState()).password_hash)).toBe(true);expect((await userState(other)).password_hash).toBe('other-original');
    expect((await client.query('SELECT password_hash FROM school_credentials')).rows[0].password_hash).toBe('school-original');
    const tokens=(await client.query('SELECT purpose,used_at FROM password_reset_tokens')).rows;expect(tokens.find(x=>x.purpose==='account').used_at).not.toBeNull();expect(tokens.find(x=>x.purpose==='school_admin').used_at).toBeNull();
    const sessions=(await client.query('SELECT user_id,revoked_at FROM sessions')).rows;expect(sessions.find(x=>x.user_id===user).revoked_at).not.toBeNull();expect(sessions.find(x=>x.user_id===other).revoked_at).toBeNull();
    const event=(await client.query("SELECT metadata FROM audit_logs WHERE action='auth.password_reset.operator_recovery'")).rows[0];expect(event.metadata).toMatchObject({passwordVerified:true,credentialScope:'os'});expect(JSON.stringify(event)).not.toContain(password);
  });
  it('does not repeat after restart and cannot undo a later password reset, even with an older deployment',async()=>{
    await applyOsPasswordRecovery(db,{userId:user,requestId,password});const later=await bcrypt.hash('PersonalLaterPassword123',12);await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[later,user]);
    expect(await applyOsPasswordRecovery(db,{userId:user,requestId,password})).toBe(0);expect((await userState()).password_hash).toBe(later);
    const second='66666666-6666-4666-8666-666666666666';expect(await applyOsPasswordRecovery(db,{userId:user,requestId:second,password})).toBe(1);
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[later,user]);expect(await applyOsPasswordRecovery(db,{userId:user,requestId,password})).toBe(0);expect((await userState()).password_hash).toBe(later);
  });
  it('rejects a disabled user or inactive provider membership without consuming recovery',async()=>{
    await client.query("UPDATE users SET status='disabled' WHERE id=$1",[user]);await expect(applyOsPasswordRecovery(db,{userId:user,requestId,password})).rejects.toThrow('active commercial owner');
    await client.query("UPDATE users SET status='active' WHERE id=$1",[user]);await client.query("UPDATE organisation_memberships SET status='suspended' WHERE user_id=$1 AND organisation_id=$2",[user,provider]);await expect(applyOsPasswordRecovery(db,{userId:user,requestId,password})).rejects.toThrow('active commercial owner');expect((await userState()).password_hash).toBe('owner-original');expect((await client.query('SELECT count(*) count FROM auth_configuration_state')).rows[0].count).toBe(0);
  });
  it('rejects a school-only account and reuse of the request for another account',async()=>{
    await client.query('DELETE FROM organisation_memberships WHERE user_id=$1 AND organisation_id=$2',[user,provider]);await expect(applyOsPasswordRecovery(db,{userId:user,requestId,password})).rejects.toThrow('active commercial owner');
    await applyOsPasswordRecovery(db,{userId:other,requestId,password});await expect(applyOsPasswordRecovery(db,{userId:user,requestId,password})).rejects.toThrow('different account');expect((await userState()).password_hash).toBe('owner-original');
  });
  it('does nothing without a recovery request and accepts cleared configuration',async()=>{
    expect(await applyOsPasswordRecovery(db)).toBe(0);const base={DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'test-secret-with-at-least-thirty-two-characters'};
    expect(loadConfig({...base,OS_PASSWORD_RECOVERY_USER_ID:'',OS_PASSWORD_RECOVERY_REQUEST_ID:'',OS_PASSWORD_RECOVERY_VALUE:''}).OS_PASSWORD_RECOVERY_VALUE).toBeUndefined();expect(()=>loadConfig({...base,OS_PASSWORD_RECOVERY_USER_ID:user})).toThrow('requires an account');
    await expect(applyOsPasswordRecovery(db,{userId:user,requestId,password:'short'})).rejects.toThrow('Invalid OS password recovery');expect((await userState()).password_hash).toBe('owner-original');
  });
});
