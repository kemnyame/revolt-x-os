import {schoolWorkspaceUrl} from './tenant-ui.js';
import {assertCoreSignInAvailable} from './sign-in-startup.js';
import { schoolRecordId } from './record-id.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {sendOsPasswordReset} from './os-password-email.js';
import {createHash} from 'node:crypto';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';
import { maybeOne } from './db.js';
import { assertPortalLoginAllowed, clearPortalLoginThrottle, recordPortalLoginFailure, throttleFingerprint } from './reliability.js';
import {authorize,schoolRoleProfile,type CoreContext} from './auth.js';

export async function withSchoolAuthThrottle<T>(db: SchoolDb, portal: string, request: any, action: () => Promise<T>) {
  const body = request.body ?? {};
  const ipKey = throttleFingerprint('ip:' + request.ip);
  const identityKey = throttleFingerprint([request.ip, body.schoolId ?? '', body.email ?? body.staffId ?? body.token ?? ''].join(':'));
  await assertPortalLoginAllowed(db, portal, ipKey);
  await assertPortalLoginAllowed(db, portal, identityKey);
  try {
    const result = await action();
    await clearPortalLoginThrottle(db, portal, identityKey);
    return result;
  } catch (error: any) {
    if (error?.statusCode === 401 || error?.statusCode === 403) {
      await recordPortalLoginFailure(db, portal, identityKey, 10, 15);
      await recordPortalLoginFailure(db, portal, ipKey, 50, 15);
    }
    throw error;
  }
}

export const schoolIdentifier = z.string().trim()
  .min(1, 'Select your school before signing in.')
  .max(120, 'The school selection is invalid. Select your school again.');
export const optionalSchoolIdentifier = z.preprocess(
  value => value == null || (typeof value === 'string' && !value.trim()) ? undefined : value,
  schoolIdentifier.optional()
);
export const schoolPassword = z.string()
  .min(12, 'Use at least 12 characters for your new password.')
  .max(128, 'Your new password must be no longer than 128 characters.')
  .regex(/[A-Z]/, 'Your new password must contain an uppercase letter.')
  .regex(/[a-z]/, 'Your new password must contain a lowercase letter.')
  .regex(/[0-9]/, 'Your new password must contain a number.');

export async function ensureSchoolLoginMembership(db: SchoolDb, organisationId: string, userId: string, inferredRole: string, administrator = false) {
  const find = () => maybeOne<any>(db,`SELECT sm.*,sr.name role_name,sr.portal_mode,sr.can_teach,sr.is_active
    FROM school_memberships sm LEFT JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
    WHERE sm.organisation_id=$1 AND sm.os_user_id=$2`,[organisationId,userId]);
  const check = (membership: any) => {
    if(!membership || membership.status!=='active' || !membership.is_active)
      throw Object.assign(new Error('Your School access or assigned role is disabled. Ask your administrator to restore it.'),{statusCode:403});
    return membership;
  };
  const existing = await find();
  if(existing)check(existing);
  if(!existing)await db.query(`INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
    VALUES($1,$2,$3,'active') ON CONFLICT(organisation_id,os_user_id) DO NOTHING`,[organisationId,userId,inferredRole]);
  else if(administrator && existing.role!=='school_admin')await db.query(`UPDATE school_memberships
    SET role='school_admin',updated_at=now() WHERE organisation_id=$1 AND os_user_id=$2 AND status='active'`,[organisationId,userId]);
  // Re-read after the write so a concurrent disable cannot be overwritten by login.
  return check(await find());
}

/** Public authentication errors describe the action needed without exposing validator jargon. */
export function schoolAuthValidationMessage(issues: any[]) {
  return [...new Set(issues.slice(0, 6).map(issue => {
    const field = issue.path?.[0];
    if (field === 'schoolId') return 'Select your school before signing in.';
    if (field === 'token') return 'This password reset link is incomplete or invalid. Generate a new link from Revolt-X OS.';
    if (field === 'email') return 'Enter a valid administrator email address.';
    if (field === 'staffId') return 'Enter the Staff ID assigned to you by your school.';
    if (field === 'password') return 'Enter your password.';
    if (field === 'newPassword' && issue.code === 'invalid_type') return 'Enter your new password.';
    return String(issue.message || 'Check the details entered and try again.');
  }))].join(' ');
}

/** Password changes revoke only the affected school; an omitted scope is reserved for explicit global revocation. */
export async function revokeSchoolUserSessions(db: SchoolDb, userId: string, keepSessionHash?: string,organisationId?:string) {
  const result = await db.query(`UPDATE school_sessions SET revoked_at=now()
    WHERE os_user_id=$1 AND revoked_at IS NULL
      AND ($2::text IS NULL OR token_hash<>$2) AND ($3::uuid IS NULL OR organisation_id=$3) RETURNING id`, [userId, keepSessionHash ?? null,organisationId??null]);
  return result.rowCount ?? 0;
}

export function registerSchoolAccessRoutes(app: FastifyInstance, options: {
  db: SchoolDb; config: SchoolConfig; requireCoreServiceRequest: (request: any) => void;
  fetchCore?: typeof fetch;
  passwordChangedAudit?: (context:CoreContext,staffId:string|null)=>Promise<void>;
}) {
  app.get('/api/auth/admin-login-context',async(request,reply)=>{
    reply.header('cache-control','no-store');
    const query=z.object({schoolId:schoolIdentifier,adminUserId:schoolRecordId}).parse(request.query);
    if(!options.config.CORE_SERVICE_KEY)throw Object.assign(new Error('Core service authentication is not configured'),{statusCode:503});
    await assertCoreSignInAvailable(options.config,options.fetchCore);
    const q=new URLSearchParams(query);
    const response=await(options.fetchCore??fetch)(options.config.CORE_OS_URL.replace(/\/$/,'')+'/v1/internal/school/admin-login-context?'+q,{
      headers:{'x-revolt-service-key':options.config.CORE_SERVICE_KEY},signal:AbortSignal.timeout(20000)
    }).catch(()=>null);
    const user:any=await response?.json().catch(()=>null);
    if(!response?.ok){
      const retryAfter=response?.headers.get('retry-after');if(retryAfter)reply.header('retry-after',retryAfter);
      throw Object.assign(new Error(user?.error?.message||user?.message||'The sign-in service is starting or unavailable. Your administrator link will be checked when it reconnects.'),{statusCode:response?.status||503});
    }
    if(user?.id!==query.adminUserId||typeof user.email!=='string'||!user.organisation_slug)throw Object.assign(new Error('The school administrator link could not be verified'),{statusCode:503});
    return{administrator:{id:user.id,email:user.email,name:[user.first_name,user.last_name].filter(Boolean).join(' ')},school:{id:user.organisation_slug,name:user.organisation_name}};
  });
  app.post('/api/auth/change-password',async(request,reply)=>{
    reply.header('cache-control','no-store');
    const access=await authorize(request,options.db,options.config,undefined,{allowPasswordChange:true});
    const body=z.object({newPassword:schoolPassword}).parse(request.body),token=access.schoolToken||'';
    if(!options.config.CORE_SERVICE_KEY)throw Object.assign(new Error('Core service authentication is not configured'),{statusCode:503});
    const keepSessionHash=token&&!access.core.dedicated_admin?createHash('sha256').update(token).digest('hex'):undefined;
    const changed=await(options.fetchCore??fetch)(options.config.CORE_OS_URL.replace(/\/$/,'')+'/v1/internal/school/change-staff-password',{
      method:'POST',headers:{'content-type':'application/json','x-revolt-service-key':options.config.CORE_SERVICE_KEY},
      body:JSON.stringify({schoolId:access.core.organisation_slug||access.core.organisation_id,userId:access.core.id,newPassword:body.newPassword,keepSessionHash}),signal:AbortSignal.timeout(20000)
    }).catch(()=>null);
    const payload:any=await changed?.json().catch(()=>null);
    if(!changed?.ok||payload?.changed!==true)throw Object.assign(new Error(payload?.error?.message||'Core Revolt-X OS could not update the password. Please try again.'),{statusCode:changed?.status&&changed.status>=400?changed.status:503});
    await revokeSchoolUserSessions(options.db,access.core.id,keepSessionHash,access.core.organisation_id);
    try{await options.passwordChangedAudit?.(access.core,payload.staffId??access.core.employee_number??null)}
    catch(error){request.log.error({err:error},'School password changed but its local audit could not be written');}
    if(access.core.dedicated_admin){
      const secure=options.config.NODE_ENV==='production'?'; Secure':'';
      reply.header('set-cookie','rx_school_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+secure);
      return{changed:true,requiresSignIn:true,schoolId:access.core.organisation_slug,redirectTo:'/s/'+encodeURIComponent(access.core.organisation_slug)+'/admin-login?admin='+encodeURIComponent(access.core.id)};
    }
    if(keepSessionHash)await options.db.query(`UPDATE school_sessions SET core_context=jsonb_set(core_context,'{must_change_password}','false'::jsonb,true),last_used_at=now()
      WHERE token_hash=$1 AND revoked_at IS NULL`,[keepSessionHash]);
    const profile=await schoolRoleProfile(options.db,access.core.organisation_id,access.role);
    return{changed:true,redirectTo:schoolWorkspaceUrl(access.core.organisation_slug,profile?.portal_mode==='teacher'?'/teacher':'/')};
  });
  app.post('/api/internal/os-password-reset-email',async(request,reply)=>{
    options.requireCoreServiceRequest(request);
    reply.header('cache-control','no-store');
    const body=z.object({email:z.string().trim().toLowerCase().email(),resetToken:z.string().min(32).max(500).regex(/^[A-Za-z0-9_-]+$/)}).parse(request.body);
    try{await sendOsPasswordReset(options.config,body.email,body.resetToken)}
    catch{throw Object.assign(new Error('OS recovery email delivery is unavailable'),{statusCode:503});}
    return{sent:true};
  });
  app.post('/api/internal/revoke-user-sessions', async request => {
    options.requireCoreServiceRequest(request);
    const body = z.object({ userId: schoolRecordId, keepSessionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),organisationId:schoolRecordId.optional() }).parse(request.body);
    return { revoked: await revokeSchoolUserSessions(options.db, body.userId, body.keepSessionHash,body.organisationId) };
  });

  app.post('/api/auth/admin-password-reset', async (request, reply) => withSchoolAuthThrottle(options.db, 'admin_reset', request, async () => {
    reply.header('cache-control', 'no-store, max-age=0');
    const body = z.object({
      token: z.string().trim().min(32).max(500).regex(/^[A-Za-z0-9_-]+$/),
      newPassword: schoolPassword,
      schoolId: optionalSchoolIdentifier
    }).parse(request.body);
    const result = await (options.fetchCore ?? fetch)(options.config.CORE_OS_URL.replace(/\/$/, '') + '/v1/auth/password-reset/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: body.token, password: body.newPassword, schoolId: body.schoolId, purpose:'school_admin' }),
      signal: AbortSignal.timeout(20000)
    }).catch(() => null);
    if (!result) throw Object.assign(new Error('Core Revolt-X OS could not complete the password reset. Please try again.'), { statusCode: 503 });
    const payload: any = await result.json().catch(() => null);
    if (!result.ok) throw Object.assign(new Error(payload?.error?.message || payload?.message || 'Reset link is invalid or has expired. Generate a new reset link.'), { statusCode: result.status });
    if (payload?.reset !== true || typeof payload?.email !== 'string' || typeof payload?.userId !== 'string' || typeof payload?.organisationId !== 'string')
      throw Object.assign(new Error('The password-reset response could not be verified. Please contact your administrator.'), { statusCode: 503 });

    // Core also calls the trusted revocation endpoint before consuming a reset token.
    // Revocation always includes the resolved school; matching an email globally
    // would sign out independent accounts in other schools.
    await revokeSchoolUserSessions(options.db,payload.userId,undefined,payload.organisationId);
    const school = typeof payload.organisationSlug === 'string' ? payload.organisationSlug : body.schoolId;
    const adminLoginUrl = (school ? '/s/' + encodeURIComponent(school) + '/admin-login' : '/admin-login')+(payload.userId?'?admin='+encodeURIComponent(payload.userId):'');
    const secure = options.config.NODE_ENV === 'production' ? '; Secure' : '';
    reply.header('set-cookie', 'rx_school_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secure);
    return { reset: true, email: payload.email, schoolId: school ?? null, adminLoginUrl };
  }));
}

