import {createHash} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import type {Db} from '../db/index.js';
import {requestPasswordReset,resetPassword} from './service.js';
import {revokeLinkedSchoolSessions} from './school-sessions.js';
import {deliverOsPasswordReset} from './password-reset-email.js';
import {safeRequestUrl} from './request-log.js';
import {loadConfig} from '../config.js';

const pg=new PGlite(),user='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const token='test-reset-token-'.repeat(3),hash=createHash('sha256').update(token).digest('hex');
const client={query:async(sql:string,params?:unknown[])=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0}},release(){}};
const db={...client,connect:async()=>client} as unknown as Db;
const config=loadConfig({DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'12345678901234567890123456789012',SCHOOL_APP_URL:'https://school.example.test',SCHOOL_SERVICE_KEY:'s'.repeat(32)});
beforeAll(async()=>pg.exec(`
 CREATE TABLE organisations(id uuid PRIMARY KEY,slug text,status text,settings jsonb DEFAULT '{}');
 CREATE TABLE users(id uuid PRIMARY KEY,email text,password_hash text,status text,must_change_password boolean,updated_at timestamptz,school_password_bootstrapped_at timestamptz);
 CREATE TABLE organisation_memberships(id uuid,user_id uuid,organisation_id uuid,status text,joined_at timestamptz);
 CREATE TABLE roles(id uuid,key text); CREATE TABLE membership_roles(membership_id uuid,role_id uuid);
 CREATE TABLE password_reset_tokens(id serial,user_id uuid,token_hash text,used_at timestamptz,expires_at timestamptz,organisation_id uuid,purpose text DEFAULT 'account',requested_ip inet,created_at timestamptz DEFAULT now());
 CREATE TABLE school_accounts(organisation_id uuid,user_id uuid,email text,status text);
 CREATE TABLE school_credentials(organisation_id uuid,user_id uuid,password_hash text,must_change_password boolean,initialized_at timestamptz,updated_at timestamptz DEFAULT now(),PRIMARY KEY(organisation_id,user_id));
 CREATE TABLE sessions(user_id uuid,organisation_id uuid,revoked_at timestamptz);
 CREATE TABLE saas_customers(customer_organisation_id uuid,customer_type text);
 CREATE TABLE audit_logs(id serial,organisation_id uuid,actor_user_id uuid,session_id uuid,action text,resource_type text,resource_id uuid,outcome text,ip_address text,user_agent text,before_state jsonb,after_state jsonb,metadata jsonb,severity text,source text,previous_event_hash text,event_hash text,integrity_version int,created_at timestamptz);`));
beforeEach(async()=>{
  await pg.exec('TRUNCATE organisations,users,organisation_memberships,password_reset_tokens,school_accounts,school_credentials,sessions,saas_customers,audit_logs,roles,membership_roles;');
  await client.query("INSERT INTO organisations(id,slug,status,settings) VALUES($1,'alpha','active',jsonb_build_object('primaryAdminUserId',$3::text)),($2,'beta','active',jsonb_build_object('primaryAdminUserId',$3::text))",[org,other,user]);
  await client.query("INSERT INTO users(id,email,password_hash,status,must_change_password,updated_at) VALUES($1,'admin@example.test','os-hash','active',true,now())",[user]);
  await client.query("INSERT INTO organisation_memberships(id,user_id,organisation_id,status,joined_at) VALUES($2,$1,$2,'active',now()-interval '1 day'),($3,$1,$3,'active',now())",[user,org,other]);
  await client.query("INSERT INTO roles VALUES($1,'owner');",[user]);
  await client.query('INSERT INTO membership_roles VALUES($1,$3),($2,$3)',[org,other,user]);
  await client.query("INSERT INTO saas_customers VALUES($1,'school'),($2,'school')",[org,other]);
  await client.query("INSERT INTO school_accounts VALUES($1,$3,'admin@example.test','active'),($2,$3,'admin@example.test','active')",[org,other,user]);
  await client.query("INSERT INTO school_credentials VALUES($1,$3,'alpha-hash',true,now(),now()),($2,$3,'beta-hash',false,now(),now())",[org,other,user]);
  await client.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,organisation_id,purpose) VALUES($1,$2,now()+interval '30 minutes',$3,'school_admin')",[user,hash,org]);
  await client.query('INSERT INTO sessions VALUES($1,$2,NULL),($1,$3,NULL)',[user,org,other]);
});
afterEach(()=>vi.restoreAllMocks());afterAll(()=>pg.close());
const state=async()=>({user:(await client.query('SELECT * FROM users')).rows[0] as any,token:(await client.query('SELECT * FROM password_reset_tokens ORDER BY id')).rows[0] as any,sessions:(await client.query('SELECT * FROM sessions')).rows as any[],schools:(await client.query('SELECT * FROM school_credentials ORDER BY organisation_id')).rows as any[]});
const reset=(schoolId?:string,revokeSchoolSessions?:any)=>resetPassword(db,token,'NewSecurePass123',{}, {purpose:'school_admin',schoolId,revokeSchoolSessions});

describe('independent OS and School password recovery',()=>{
  it('resolves the bound school, preserves OS and other school passwords and sessions, and prevents reuse',async()=>{
    const revoke=vi.fn(async()=>{});expect(await reset(undefined,revoke)).toMatchObject({reset:true,userId:user,organisationSlug:'alpha',organisationId:org});expect(revoke).toHaveBeenCalledWith(user,org);
    const s=await state();expect(s.user.password_hash).toBe('os-hash');expect(await bcrypt.compare('NewSecurePass123',s.schools[0].password_hash)).toBe(true);expect(s.schools[0].must_change_password).toBe(false);expect(s.schools[1].password_hash).toBe('beta-hash');expect(s.token.used_at).not.toBeNull();expect(s.sessions.find(x=>x.organisation_id===org).revoked_at).not.toBeNull();expect(s.sessions.find(x=>x.organisation_id===other).revoked_at).toBeNull();
    await expect(reset()).rejects.toMatchObject({statusCode:401});
  });
  it.each(['ALPHA',org])('accepts the bound slug or organisation ID %s',async schoolId=>{
    expect(await reset(schoolId)).toMatchObject({organisationSlug:'alpha',organisationId:org});
  });
  it('rejects another school without consuming the token or changing credentials',async()=>{
    const revoke=vi.fn();await expect(reset('beta',revoke)).rejects.toMatchObject({statusCode:401});expect(revoke).not.toHaveBeenCalled();const s=await state();expect(s.schools[0].password_hash).toBe('alpha-hash');expect(s.token.used_at).toBeNull();expect(s.sessions.every(x=>x.revoked_at===null)).toBe(true);
  });
  it('rejects expired tokens, disabled accounts and stale administrator assignments',async()=>{
    await client.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 minute'");await expect(reset()).rejects.toMatchObject({statusCode:401});
    await client.query("UPDATE password_reset_tokens SET expires_at=now()+interval '30 minutes'");await client.query("UPDATE school_accounts SET status='disabled'");await expect(reset()).rejects.toMatchObject({statusCode:401});
    await client.query("UPDATE school_accounts SET status='active'");await client.query("UPDATE organisations SET settings='{}'");await expect(reset()).rejects.toMatchObject({statusCode:401});expect((await state()).token.used_at).toBeNull();
  });
  it('rolls back a school change if its session revocation bridge fails',async()=>{
    await expect(reset(undefined,async()=>{throw Object.assign(new Error('School unavailable'),{statusCode:503})})).rejects.toMatchObject({statusCode:503});
    const s=await state();expect(s.schools[0].password_hash).toBe('alpha-hash');expect(s.token.used_at).toBeNull();expect(s.sessions.every(x=>x.revoked_at===null)).toBe(true);await expect(reset(undefined,async()=>{})).resolves.toMatchObject({reset:true});
  });
  it('OS recovery changes only the OS password, preserves school reset links and never calls School revocation',async()=>{
    const requested=await requestPasswordReset(db,'admin@example.test');expect(requested.resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const revoke=vi.fn();await resetPassword(db,requested.resetToken!,'PersonalOsPass123',{}, {purpose:'account',revokeSchoolSessions:revoke});expect(revoke).not.toHaveBeenCalled();
    const s=await state();expect(await bcrypt.compare('PersonalOsPass123',s.user.password_hash)).toBe(true);expect(s.schools.map(x=>x.password_hash)).toEqual(['alpha-hash','beta-hash']);expect(s.token.used_at).toBeNull();expect(s.sessions.every(x=>x.revoked_at)).toBe(true);
    await expect(resetPassword(db,requested.resetToken!,'AnotherOsPass123',{}, {purpose:'account'})).rejects.toMatchObject({statusCode:401});
  });
  it('enforces reset purpose and invalidates ambiguous unbound links',async()=>{
    await expect(resetPassword(db,token,'NewSecurePass123',{}, {purpose:'account'})).rejects.toMatchObject({statusCode:401});
    const os=await requestPasswordReset(db,'admin@example.test');await expect(resetPassword(db,os.resetToken!,'NewSecurePass123',{}, {purpose:'school_admin'})).rejects.toMatchObject({statusCode:401});
    await client.query('UPDATE password_reset_tokens SET organisation_id=NULL');await expect(reset()).rejects.toMatchObject({statusCode:401});
  });
  it('school staff setup activates only its invited membership and preserves OS credentials',async()=>{
    await client.query("UPDATE password_reset_tokens SET purpose='school_staff'");await client.query("UPDATE organisation_memberships SET status='invited' WHERE organisation_id=$1",[org]);
    expect(await resetPassword(db,token,'StaffPersonalPass123')).toMatchObject({organisationId:org});const s=await state();expect(s.user.password_hash).toBe('os-hash');expect(s.schools[1].password_hash).toBe('beta-hash');expect((await client.query('SELECT status FROM organisation_memberships WHERE organisation_id=$1',[org])).rows[0]).toMatchObject({status:'active'});
  });
  it('uses a 60-second recovery cooldown and a maximum of three requests per hour without exposing unknown users',async()=>{
    expect(await requestPasswordReset(db,'unknown@example.test')).toEqual({accepted:true});
    for(let i=0;i<3;i++){expect((await requestPasswordReset(db,'admin@example.test')).resetToken).toBeTruthy();expect(await requestPasswordReset(db,'admin@example.test')).toEqual({accepted:true});await client.query("UPDATE password_reset_tokens SET created_at=now()-interval '2 minutes' WHERE purpose='account'");}
    expect(await requestPasswordReset(db,'admin@example.test')).toEqual({accepted:true});expect((await client.query("SELECT count(*) count FROM password_reset_tokens WHERE purpose='account'")).rows[0]).toMatchObject({count:3});expect((await state()).token.used_at).toBeNull();
  });
  it('calls the authenticated revocation bridge with the affected school scope',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({revoked:2}),{status:200}));
    await revokeLinkedSchoolSessions(db,config,user,'a'.repeat(64),org);
    const [url,init]=mock.mock.calls[0]!;expect(url).toBe('https://school.example.test/api/internal/revoke-user-sessions');expect(JSON.parse(init?.body as string)).toEqual({userId:user,keepSessionHash:'a'.repeat(64),organisationId:org});
    mock.mockResolvedValue(new Response('{}',{status:503}));await expect(revokeLinkedSchoolSessions(db,config,user,undefined,org)).rejects.toMatchObject({statusCode:503});
  });
  it('delivers recovery through the trusted service and hides provider errors and reset tokens',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{"sent":true}'));
    await deliverOsPasswordReset(config,'admin@example.test',token);const [url,init]=mock.mock.calls[0]!;expect(url).toBe('https://school.example.test/api/internal/os-password-reset-email');expect((init?.headers as any)['x-revolt-service-key']).toBe(config.SCHOOL_SERVICE_KEY);expect(JSON.parse(init?.body as string)).toEqual({email:'admin@example.test',resetToken:token});
    mock.mockResolvedValue(new Response('{"error":"provider failed '+token+'"}',{status:503}));await expect(deliverOsPasswordReset(config,'admin@example.test',token)).rejects.toMatchObject({statusCode:503,message:'OS password recovery is temporarily unavailable.'});
    expect(safeRequestUrl('/password-reset?%74oken='+token+'&next=login')).toBe('/password-reset?token=[redacted]&next=login');
  });
});
