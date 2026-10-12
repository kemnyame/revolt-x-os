import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { AppError } from '../core/errors.js';

/** Complete School session revocation before a Core password change consumes its token.
 * A failed bridge call leaves the Core transaction rollback-safe, so the same reset
 * link can be retried. Users who have no School membership do not depend on School. */
export async function revokeLinkedSchoolSessions(db: Db, config: Config, userId: string, keepSessionHash?: string, organisationId?:string) {
  const schoolUser = await db.query(`SELECT 1 FROM organisation_memberships m
    JOIN saas_customers c ON c.customer_organisation_id=m.organisation_id
    WHERE m.user_id=$1 AND c.customer_type='school' AND ($2::uuid IS NULL OR m.organisation_id=$2) LIMIT 1`, [userId,organisationId??null]);
  if (!schoolUser.rowCount) return;
  if (!config.SCHOOL_APP_URL || !config.SCHOOL_SERVICE_KEY)
    throw new AppError(503, 'SCHOOL_SESSION_REVOCATION_FAILED', 'School session security is not configured. Ask your administrator to check the School connection.');
  const response = await fetch(config.SCHOOL_APP_URL.replace(/\/$/, '') + '/api/internal/revoke-user-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-revolt-service-key': config.SCHOOL_SERVICE_KEY },
    body: JSON.stringify({ userId, keepSessionHash, organisationId }), signal: AbortSignal.timeout(15000)
  }).catch(() => null);
  const payload: any = response?.ok ? await response.json().catch(() => null) : null;
  if (!Number.isInteger(payload?.revoked) || payload.revoked < 0)
    throw new AppError(503, 'SCHOOL_SESSION_REVOCATION_FAILED', 'School security could not finish signing out older sessions. Please try the password change again.');
}

