import {setSchoolCredential,clearSchoolResetTokens} from './school-credentials.js';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { audit, emitEvent } from '../core/audit.js';
import { conflict, unauthorized } from '../core/errors.js';
import type { AuthContext } from '../core/types.js';
interface LoginRow{user_id:string;password_hash:string;user_status:string;organisation_id:string;membership_status:string;organisation_status:string}export interface RequestMeta{ipAddress?:string|undefined;userAgent?:string|undefined}const hashToken=(t:string)=>createHash('sha256').update(t).digest('hex'),secret=(c:Config)=>new TextEncoder().encode(c.JWT_SECRET);
async function permissions(db:Db,u:string,o:string){const r=await db.query<{key:string}>(`SELECT DISTINCT p.key FROM organisation_memberships m JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE m.user_id=$1 AND m.organisation_id=$2 AND m.status='active'`,[u,o]);return r.rows.map(x=>x.key)}async function issueAccessToken(db:Db,c:Config,u:string,o:string,s:string){return new SignJWT({organisationId:o,sessionId:s,permissions:await permissions(db,u,o)}).setProtectedHeader({alg:'HS256'}).setSubject(u).setIssuedAt().setExpirationTime(`${c.ACCESS_TOKEN_TTL_SECONDS}s`).sign(secret(c))}export async function verifyAccessToken(c:Config,t:string):Promise<AuthContext>{try{const{payload}=await jwtVerify(t,secret(c),{algorithms:['HS256']});if(!payload.sub||typeof payload.organisationId!=='string'||typeof payload.sessionId!=='string'||!Array.isArray(payload.permissions))throw 0;return{userId:payload.sub,organisationId:payload.organisationId,sessionId:payload.sessionId,permissions:payload.permissions.filter((v):v is string=>typeof v==='string'),preview:payload.preview===true}}catch{throw unauthorized('Invalid or expired access token')}}
export async function registerOrganisation(db:Db,c:Config,i:{organisationName:string;slug:string;firstName:string;lastName:string;email:string;password:string},m:RequestMeta={}){const email=i.email.trim().toLowerCase(),ph=await bcrypt.hash(i.password,12);try{const x=await transaction(db,async q=>{const o=await one<{id:string}>(q,'INSERT INTO organisations(name,slug) VALUES($1,$2) RETURNING id',[i.organisationName.trim(),i.slug]),u=await one<{id:string}>(q,`INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,$3,$4,'active',now()) RETURNING id`,[email,ph,i.firstName.trim(),i.lastName.trim()]),mm=await one<{id:string}>(q,'INSERT INTO organisation_memberships(organisation_id,user_id) VALUES($1,$2) RETURNING id',[o.id,u.id]);await q.query(`INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by) SELECT $1,id,'organisation',$2,$3 FROM roles WHERE organisation_id IS NULL AND key='owner'`,[mm.id,o.id,u.id]);await audit(q,{organisationId:o.id,actorUserId:u.id,action:'organisation.created',resourceType:'organisation',resourceId:o.id,...m});await emitEvent(q,o.id,'core.organisation.created.v1','organisation',o.id,{organisationId:o.id,ownerUserId:u.id});return o.id});return login(db,c,{email,password:i.password,organisationId:x},m)}catch(e:any){if(e.code==='23505')throw conflict('Organisation slug or email is already in use');throw e}}
export async function login(db:Db,c:Config,i:{email:string;password:string;organisationId?:string|undefined},m:RequestMeta={}){const r=await maybeOne<LoginRow>(db,`SELECT u.id user_id,u.password_hash,u.status user_status,m.organisation_id,m.status membership_status,o.status organisation_status FROM users u JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id WHERE u.email=$1 AND ($2::uuid IS NULL OR m.organisation_id=$2) ORDER BY (m.status='active' AND o.status='active') DESC,EXISTS(SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school'),m.joined_at LIMIT 1`,[i.email.trim().toLowerCase(),i.organisationId??null]);if(!r||!await bcrypt.compare(i.password,r.password_hash)||r.user_status!=='active'||r.membership_status!=='active'||r.organisation_status!=='active'){await audit(db,{organisationId:r?.organisation_id??null,actorUserId:r?.user_id??null,action:'auth.login',resourceType:'session',outcome:'failure',...m});throw unauthorized('Invalid credentials or inactive account')}const rt=randomBytes(48).toString('base64url'),s=await one<{id:string}>(db,`INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,ip_address,user_agent,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[r.user_id,r.organisation_id,hashToken(rt),m.ipAddress??null,m.userAgent??null,new Date(Date.now()+c.REFRESH_TOKEN_TTL_DAYS*86400000)]);await db.query('UPDATE users SET last_login_at=now() WHERE id=$1',[r.user_id]);return{accessToken:await issueAccessToken(db,c,r.user_id,r.organisation_id,s.id),refreshToken:rt,expiresIn:c.ACCESS_TOKEN_TTL_SECONDS,organisationId:r.organisation_id}}
export async function requestPasswordReset(db:Db,email:string,m:RequestMeta={}):Promise<{accepted:boolean;resetToken?:string;expiresInMinutes?:number}>{
  const u=await maybeOne<{id:string;organisation_id:string}>(db,`SELECT u.id,m.organisation_id FROM users u
    JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id
    WHERE u.email=$1 AND u.status='active' AND m.status='active' AND o.status='active'
    ORDER BY EXISTS(SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school'),m.joined_at LIMIT 1`,[email.trim().toLowerCase()]);
  if(!u)return{accepted:true};
  return transaction(db,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))',['os-password-reset:'+u.id]);
    const recent=await q.query(`SELECT 1 FROM password_reset_tokens WHERE user_id=$1 AND purpose='account'
      AND created_at>now()-interval '1 hour' HAVING count(*)>=3 OR max(created_at)>now()-interval '60 seconds'`,[u.id]);
    if(recent.rowCount)return{accepted:true};
    const t=randomBytes(32).toString('base64url');
    await q.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND purpose='account' AND used_at IS NULL",[u.id]);
    await q.query(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,requested_ip,organisation_id,purpose)
      VALUES($1,$2,now()+interval '30 minutes',$3,$4,'account')`,[u.id,hashToken(t),m.ipAddress??null,u.organisation_id]);
    await audit(q,{organisationId:u.organisation_id,actorUserId:u.id,action:'auth.password_reset.requested',resourceType:'user',resourceId:u.id,...m});
    return{accepted:true,resetToken:t,expiresInMinutes:30};
  });
}
export async function resetPassword(db:Db,t:string,p:string,m:RequestMeta={},options:{
  schoolId?:string|undefined;
  purpose?:'account'|'school_admin'|undefined;
  revokeSchoolSessions?:(userId:string,organisationId?:string)=>Promise<void>;
}={}){
  const ph=await bcrypt.hash(p,12);
  return transaction(db,async q=>{
    const r=await maybeOne<{id:string;user_id:string;organisation_id:string;organisation_slug:string;email:string;purpose:string}>(q,`
      SELECT pr.id,pr.user_id,pr.purpose,m.organisation_id,o.slug organisation_slug,u.email
      FROM password_reset_tokens pr JOIN users u ON u.id=pr.user_id
      JOIN organisation_memberships m ON m.user_id=pr.user_id
      JOIN organisations o ON o.id=m.organisation_id
      WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at>now()
        AND u.status='active' AND (m.status='active' OR (pr.purpose='school_staff' AND m.status='invited')) AND o.status='active'
        AND ($2::text IS NULL OR lower(o.slug)=lower($2) OR o.id::text=$2)
        AND pr.organisation_id=o.id
        AND ($3::text IS NULL OR pr.purpose=$3)
        AND (pr.purpose='account' OR (
          EXISTS(SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school')
          AND (pr.purpose='school_staff' OR (pr.purpose='school_admin'
            AND $3::text='school_admin' AND o.settings->>'primaryAdminUserId'=u.id::text
            AND EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.membership_id=m.id AND r.key='owner')))))
      ORDER BY m.joined_at LIMIT 1 FOR UPDATE OF pr`,[hashToken(t),options.schoolId?.trim()||null,options.purpose??null]);
    if(!r)throw unauthorized('Reset link is invalid, expired, or does not belong to this school. Generate a new link.');
    const schoolReset=r.purpose==='school_admin'||r.purpose==='school_staff'||options.purpose==='school_admin';
    if(schoolReset){
      await options.revokeSchoolSessions?.(r.user_id,r.organisation_id);
      await setSchoolCredential(q,r.organisation_id,r.user_id,ph,false);
      await clearSchoolResetTokens(q,r.user_id,r.organisation_id);
      if(r.purpose==='school_staff')await q.query("UPDATE organisation_memberships SET status='active' WHERE user_id=$1 AND organisation_id=$2 AND status='invited'",[r.user_id,r.organisation_id]);
      await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND organisation_id=$2 AND revoked_at IS NULL',[r.user_id,r.organisation_id]);
    }else{
      await q.query('UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2',[ph,r.user_id]);
      await q.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND purpose='account' AND used_at IS NULL",[r.user_id]);
      await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[r.user_id]);
    }
    await audit(q,{organisationId:r.organisation_id,actorUserId:r.user_id,action:'auth.password_reset.completed',resourceType:'user',resourceId:r.user_id,...m});
    return{reset:true,email:r.email,userId:r.user_id,organisationId:r.organisation_id,organisationSlug:r.organisation_slug};
  });
}
export async function refresh(db:Db,c:Config,t:string,m:RequestMeta={}){const s=await maybeOne<{id:string;user_id:string;organisation_id:string}>(db,'SELECT id,user_id,organisation_id FROM sessions WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[hashToken(t)]);if(!s)throw unauthorized('Invalid or expired refresh token');const n=randomBytes(48).toString('base64url');await db.query('UPDATE sessions SET refresh_token_hash=$1,last_used_at=now(),ip_address=$2,user_agent=$3 WHERE id=$4',[hashToken(n),m.ipAddress??null,m.userAgent??null,s.id]);return{accessToken:await issueAccessToken(db,c,s.user_id,s.organisation_id,s.id),refreshToken:n,expiresIn:c.ACCESS_TOKEN_TTL_SECONDS}}export async function logout(db:Db,a:AuthContext,m:RequestMeta={}){await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2',[a.sessionId,a.userId]);await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'auth.logout',resourceType:'session',resourceId:a.sessionId,...m})}

