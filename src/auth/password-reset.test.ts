import {createHash} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import type {Db} from '../db/index.js';
import {resetPassword} from './service.js';
import {revokeLinkedSchoolSessions} from './school-sessions.js';
import {loadConfig} from '../config.js';

const pg=new PGlite(),user='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const token='test-reset-token-'.repeat(3),hash=createHash('sha256').update(token).digest('hex');
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
beforeAll(async()=>pg.exec(`
 CREATE TABLE organisations(id uuid PRIMARY KEY,slug text,status text,settings jsonb DEFAULT '{}');
 CREATE TABLE users(id uuid PRIMARY KEY,email text,password_hash text,status text,must_change_password boolean,updated_at timestamptz,school_password_bootstrapped_at timestamptz);
 CREATE TABLE organisation_memberships(id uuid,user_id uuid,organisation_id uuid,status text,joined_at timestamptz);
 CREATE TABLE roles(id uuid,key text);
 CREATE TABLE membership_roles(membership_id uuid,role_id uuid);
 CREATE TABLE password_reset_tokens(id serial,user_id uuid,token_hash text,used_at timestamptz,expires_at timestamptz,organisation_id uuid,purpose text DEFAULT 'account');
 CREATE TABLE sessions(user_id uuid,organisation_id uuid,revoked_at timestamptz);
 CREATE TABLE saas_customers(customer_organisation_id uuid,customer_type text);
 CREATE TABLE audit_logs(id serial,organisation_id uuid,actor_user_id uuid,session_id uuid,action text,resource_type text,resource_id uuid,outcome text,ip_address text,user_agent text,before_state jsonb,after_state jsonb,metadata jsonb,severity text,source text,previous_event_hash text,event_hash text,integrity_version int,created_at timestamptz);`));
beforeEach(async()=>{
  await pg.exec('TRUNCATE organisations,users,organisation_memberships,password_reset_tokens,sessions,saas_customers,audit_logs;');
  await client.query("INSERT INTO organisations(id,slug,status) VALUES($1,'alpha','active'),($2,'beta','active')",[org,other]);
  await client.query("INSERT INTO users(id,email,password_hash,status,must_change_password,updated_at) VALUES($1,'admin@example.test','old-hash','active',true,now())",[user]);
  await client.query("INSERT INTO organisation_memberships(user_id,organisation_id,status,joined_at) VALUES($1,$2,'active',now()-interval '1 day'),($1,$3,'active',now())",[user,org,other]);
  await client.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 minutes')",[user,hash]);
  await client.query('INSERT INTO sessions VALUES($1,$2,NULL),($1,$3,NULL)',[user,org,other]);
});
afterEach(()=>vi.restoreAllMocks());afterAll(()=>pg.close());
const state=async()=>({user:(await client.query('SELECT * FROM users')).rows[0] as any,token:(await client.query('SELECT * FROM password_reset_tokens')).rows[0] as any,sessions:(await client.query('SELECT * FROM sessions')).rows as any[]});

describe('School password reset security',()=>{
  it('resolves the school from the token, revokes all Core sessions and prevents reuse',async()=>{
    const revoke=vi.fn(async()=>{});
    const result=await resetPassword(db,token,'NewSecurePass123',{}, {revokeSchoolSessions:revoke});
    expect(result).toMatchObject({reset:true,userId:user,organisationSlug:'alpha',organisationId:org});expect(revoke).toHaveBeenCalledWith(user);
    const s=await state();expect(await bcrypt.compare('NewSecurePass123',s.user.password_hash)).toBe(true);expect(s.user.must_change_password).toBe(false);expect(s.token.used_at).not.toBeNull();expect(s.sessions.every(x=>x.revoked_at)).toBe(true);
    await expect(resetPassword(db,token,'AnotherSecurePass123')).rejects.toMatchObject({statusCode:401});
  });
  it.each(['BETA',other])('matches slug or legacy organisation ID %s before changing the password',async schoolId=>{
    expect(await resetPassword(db,token,'NewSecurePass123',{}, {schoolId})).toMatchObject({organisationSlug:'beta',organisationId:other});
  });
  it('rejects a wrong school without consuming the token or revoking any sessions',async()=>{
    const revoke=vi.fn(async()=>{});
    await expect(resetPassword(db,token,'NewSecurePass123',{}, {schoolId:'unrelated',revokeSchoolSessions:revoke})).rejects.toMatchObject({statusCode:401});
    expect(revoke).not.toHaveBeenCalled();const s=await state();expect(s.user.password_hash).toBe('old-hash');expect(s.token.used_at).toBeNull();expect(s.sessions.every(x=>x.revoked_at===null)).toBe(true);
  });
  it('rejects expired tokens and disabled users',async()=>{
    await client.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 minute'");
    await expect(resetPassword(db,token,'NewSecurePass123')).rejects.toMatchObject({statusCode:401});
    await client.query("UPDATE password_reset_tokens SET expires_at=now()+interval '30 minutes'");await client.query("UPDATE users SET status='disabled'");
    await expect(resetPassword(db,token,'NewSecurePass123')).rejects.toMatchObject({statusCode:401});expect((await state()).token.used_at).toBeNull();
  });
  it('keeps the old password and reusable token when School revocation fails',async()=>{
    await expect(resetPassword(db,token,'NewSecurePass123',{}, {revokeSchoolSessions:async()=>{throw Object.assign(new Error('School unavailable'),{statusCode:503})}})).rejects.toMatchObject({statusCode:503});
    const s=await state();expect(s.user.password_hash).toBe('old-hash');expect(s.token.used_at).toBeNull();expect(s.sessions.every(x=>x.revoked_at===null)).toBe(true);
    await expect(resetPassword(db,token,'NewSecurePass123',{}, {revokeSchoolSessions:async()=>{}})).resolves.toMatchObject({reset:true});
  });
  it('calls the authenticated School revocation bridge and preserves only the current first-login session',async()=>{
    await client.query("INSERT INTO saas_customers VALUES($1,'school')",[org]);
    const config=loadConfig({DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'12345678901234567890123456789012',SCHOOL_APP_URL:'https://school.example.test',SCHOOL_SERVICE_KEY:'s'.repeat(32)});
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({revoked:2}),{status:200}));
    await revokeLinkedSchoolSessions(db,config,user,'a'.repeat(64));
    expect(mock).toHaveBeenCalledOnce();const [url,init]=mock.mock.calls[0]!;expect(url).toBe('https://school.example.test/api/internal/revoke-user-sessions');expect(JSON.parse(init?.body as string)).toEqual({userId:user,keepSessionHash:'a'.repeat(64)});
    mock.mockResolvedValue(new Response('{}',{status:503}));await expect(revokeLinkedSchoolSessions(db,config,user)).rejects.toMatchObject({statusCode:503});
    mock.mockResolvedValue(new Response('{}',{status:200}));await expect(revokeLinkedSchoolSessions(db,config,user)).rejects.toMatchObject({statusCode:503});
  });
});
