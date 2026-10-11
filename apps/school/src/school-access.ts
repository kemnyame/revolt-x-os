import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';
import { maybeOne } from './db.js';
import { assertPortalLoginAllowed, clearPortalLoginThrottle, recordPortalLoginFailure, throttleFingerprint } from './reliability.js';

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

/** Passwords belong to the Core user, so revoke that user's sessions across every School tenant. */
export async function revokeSchoolUserSessions(db: SchoolDb, userId: string, keepSessionHash?: string) {
  const result = await db.query(`UPDATE school_sessions SET revoked_at=now()
    WHERE os_user_id=$1 AND revoked_at IS NULL
      AND ($2::text IS NULL OR token_hash<>$2) RETURNING id`, [userId, keepSessionHash ?? null]);
  return result.rowCount ?? 0;
}

export function registerSchoolAccessRoutes(app: FastifyInstance, options: {
  db: SchoolDb; config: SchoolConfig; requireCoreServiceRequest: (request: any) => void;
  fetchCore?: typeof fetch;
}) {
  app.post('/api/internal/revoke-user-sessions', async request => {
    options.requireCoreServiceRequest(request);
    const body = z.object({ userId: z.string().uuid(), keepSessionHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(request.body);
    return { revoked: await revokeSchoolUserSessions(options.db, body.userId, body.keepSessionHash) };
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
      body: JSON.stringify({ token: body.token, password: body.newPassword, schoolId: body.schoolId }),
      signal: AbortSignal.timeout(20000)
    }).catch(() => null);
    if (!result) throw Object.assign(new Error('Core Revolt-X OS could not complete the password reset. Please try again.'), { statusCode: 503 });
    const payload: any = await result.json().catch(() => null);
    if (!result.ok) throw Object.assign(new Error(payload?.error?.message || 'Reset link is invalid or has expired. Generate a new reset link.'), { statusCode: result.status });
    if (payload?.reset !== true || typeof payload?.email !== 'string')
      throw Object.assign(new Error('The password-reset response could not be verified. Please contact your administrator.'), { statusCode: 503 });

    // Core also calls the trusted revocation endpoint before consuming a reset token.
    // Retain a local fallback for a rolling deployment against an older Core response.
    if (payload.userId) await revokeSchoolUserSessions(options.db, payload.userId);
    else await options.db.query("UPDATE school_sessions SET revoked_at=now() WHERE lower(core_context->>'email')=lower($1) AND revoked_at IS NULL", [payload.email]);
    const school = typeof payload.organisationSlug === 'string' ? payload.organisationSlug : body.schoolId;
    const adminLoginUrl = school ? '/s/' + encodeURIComponent(school) + '/admin-login' : '/admin-login';
    const secure = options.config.NODE_ENV === 'production' ? '; Secure' : '';
    reply.header('set-cookie', 'rx_school_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secure);
    return { reset: true, email: payload.email, schoolId: school ?? null, adminLoginUrl };
  }));
}
