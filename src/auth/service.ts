import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { audit, emitEvent } from '../core/audit.js';
import { conflict, unauthorized } from '../core/errors.js';
import type { AuthContext } from '../core/types.js';

interface LoginRow { user_id: string; password_hash: string; user_status: string; organisation_id: string; membership_status: string; }
export interface RequestMeta { ipAddress?: string | undefined; userAgent?: string | undefined; }

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);

async function permissions(db: Db, userId: string, organisationId: string): Promise<string[]> {
  const result = await db.query<{ key: string }>(`SELECT DISTINCT p.key FROM organisation_memberships m
    JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id
    JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
    WHERE m.user_id=$1 AND m.organisation_id=$2 AND m.status='active'`, [userId, organisationId]);
  return result.rows.map((row) => row.key);
}

async function issueAccessToken(db: Db, config: Config, userId: string, organisationId: string, sessionId: string): Promise<string> {
  const granted = await permissions(db, userId, organisationId);
  return new SignJWT({ organisationId, sessionId, permissions: granted }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId).setIssuedAt().setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`).sign(secret(config));
}

export async function verifyAccessToken(config: Config, token: string): Promise<AuthContext> {
  try {
    const { payload } = await jwtVerify(token, secret(config), { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.organisationId !== 'string' || typeof payload.sessionId !== 'string' || !Array.isArray(payload.permissions)) throw new Error('Malformed token');
    return { userId: payload.sub, organisationId: payload.organisationId, sessionId: payload.sessionId, permissions: payload.permissions.filter((v): v is string => typeof v === 'string') };
  } catch { throw unauthorized('Invalid or expired access token'); }
}

export async function registerOrganisation(db: Db, config: Config, input: { organisationName: string; slug: string; firstName: string; lastName: string; email: string; password: string }, meta: RequestMeta = {}) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    const result = await transaction(db, async (client) => {
      const org = await one<{ id: string }>(client, 'INSERT INTO organisations(name,slug) VALUES($1,$2) RETURNING id', [input.organisationName.trim(), input.slug]);
      const user = await one<{ id: string }>(client, `INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at)
        VALUES($1,$2,$3,$4,'active',now()) RETURNING id`, [email, passwordHash, input.firstName.trim(), input.lastName.trim()]);
      const membership = await one<{ id: string }>(client, `INSERT INTO organisation_memberships(organisation_id,user_id) VALUES($1,$2) RETURNING id`, [org.id, user.id]);
      await client.query(`INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
        SELECT $1,id,'organisation',$2,$3 FROM roles WHERE organisation_id IS NULL AND key='owner'`, [membership.id, org.id, user.id]);
      await audit(client, { organisationId: org.id, actorUserId: user.id, action: 'organisation.created', resourceType: 'organisation', resourceId: org.id, afterState: { name: input.organisationName, slug: input.slug }, ...meta });
      await emitEvent(client, org.id, 'core.organisation.created.v1', 'organisation', org.id, { organisationId: org.id, ownerUserId: user.id });
      return { organisationId: org.id, userId: user.id };
    });
    return await login(db, config, { email, password: input.password, organisationId: result.organisationId }, meta);
  } catch (error: any) {
    if (error.code === '23505') throw conflict('Organisation slug or email is already in use');
    throw error;
  }
}

export async function login(db: Db, config: Config, input: { email: string; password: string; organisationId?: string | undefined }, meta: RequestMeta = {}) {
  const row = await maybeOne<LoginRow>(db, `SELECT u.id user_id,u.password_hash,u.status user_status,m.organisation_id,m.status membership_status
    FROM users u JOIN organisation_memberships m ON m.user_id=u.id
    WHERE u.email=$1 AND ($2::uuid IS NULL OR m.organisation_id=$2) ORDER BY m.joined_at LIMIT 1`, [input.email.trim().toLowerCase(), input.organisationId ?? null]);
  if (!row || !await bcrypt.compare(input.password, row.password_hash) || row.user_status !== 'active' || row.membership_status !== 'active') {
    await audit(db, { organisationId: row?.organisation_id ?? null, actorUserId: row?.user_id ?? null, action: 'auth.login', resourceType: 'session', outcome: 'failure', ...meta });
    throw unauthorized('Invalid credentials or inactive account');
  }
  const refreshToken = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const session = await one<{ id: string }>(db, `INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,ip_address,user_agent,expires_at)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [row.user_id, row.organisation_id, hashToken(refreshToken), meta.ipAddress ?? null, meta.userAgent ?? null, expiresAt]);
  await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [row.user_id]);
  await audit(db, { organisationId: row.organisation_id, actorUserId: row.user_id, sessionId: session.id, action: 'auth.login', resourceType: 'session', resourceId: session.id, ...meta });
  return { accessToken: await issueAccessToken(db, config, row.user_id, row.organisation_id, session.id), refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, organisationId: row.organisation_id };
}

export async function refresh(db: Db, config: Config, refreshToken: string, meta: RequestMeta = {}) {
  const session = await maybeOne<{ id:string;user_id:string;organisation_id:string }>(db, `SELECT id,user_id,organisation_id FROM sessions
    WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, [hashToken(refreshToken)]);
  if (!session) throw unauthorized('Invalid or expired refresh token');
  const next = randomBytes(48).toString('base64url');
  await db.query('UPDATE sessions SET refresh_token_hash=$1,last_used_at=now(),ip_address=$2,user_agent=$3 WHERE id=$4', [hashToken(next), meta.ipAddress ?? null, meta.userAgent ?? null, session.id]);
  return { accessToken: await issueAccessToken(db, config, session.user_id, session.organisation_id, session.id), refreshToken: next, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
}

export async function logout(db: Db, auth: AuthContext, meta: RequestMeta = {}) {
  await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2', [auth.sessionId, auth.userId]);
  await audit(db, { organisationId: auth.organisationId, actorUserId: auth.userId, sessionId: auth.sessionId, action: 'auth.logout', resourceType: 'session', resourceId: auth.sessionId, ...meta });
}
