import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { AppError } from '../core/errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function ensurePreviewOwner(db: Db) {
  const existing = await maybeOne<{ user_id: string; organisation_id: string }>(
    db,
    `SELECT m.user_id,m.organisation_id
     FROM organisation_memberships m
     JOIN users u ON u.id=m.user_id
     JOIN membership_roles mr ON mr.membership_id=m.id
     JOIN roles r ON r.id=mr.role_id
     WHERE u.status='active' AND r.key='owner'
     ORDER BY m.joined_at
     LIMIT 1`
  );

  if (existing) {
    await db.query(
      `UPDATE organisation_memberships
       SET status='active'
       WHERE user_id=$1 AND organisation_id=$2`,
      [existing.user_id, existing.organisation_id]
    );
    return existing;
  }

  return transaction(db, async client => {
    const organisation = await one<{ id: string }>(
      client,
      `INSERT INTO organisations(name,slug,status)
       VALUES('Kem Company','kem-company','active')
       ON CONFLICT (slug)
       DO UPDATE SET name=EXCLUDED.name,status='active',updated_at=now()
       RETURNING id`
    );

    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const user = await one<{ id: string }>(
      client,
      `INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at)
       VALUES('preview@revolt-x.local',$1,'Revolt-X','Preview','active',now())
       ON CONFLICT (email)
       DO UPDATE SET status='active',updated_at=now()
       RETURNING id`,
      [passwordHash]
    );

    const membership = await one<{ id: string }>(
      client,
      `INSERT INTO organisation_memberships(organisation_id,user_id,status)
       VALUES($1,$2,'active')
       ON CONFLICT (organisation_id,user_id)
       DO UPDATE SET status='active'
       RETURNING id`,
      [organisation.id, user.id]
    );

    await client.query(
      `INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
       SELECT $1,id,'organisation',$2,$3
       FROM roles
       WHERE organisation_id IS NULL AND key='owner'
       ON CONFLICT DO NOTHING`,
      [membership.id, organisation.id, user.id]
    );

    return { user_id: user.id, organisation_id: organisation.id };
  });
}

export async function previewRoutes(
  app: FastifyInstance,
  { db, config }: { db: Db; config: Config }
) {
  const createPreviewSession = async () => {
    if (!config.ENABLE_PREVIEW_ACCESS) {
      throw new AppError(403, 'PREVIEW_DISABLED', 'Development preview access is disabled');
    }

    const owner = await ensurePreviewOwner(db);
    const permissions = await db.query<{ key: string }>(
      `SELECT DISTINCT p.key
       FROM organisation_memberships m
       JOIN membership_roles mr ON mr.membership_id=m.id
       JOIN role_permissions rp ON rp.role_id=mr.role_id
       JOIN permissions p ON p.id=rp.permission_id
       WHERE m.user_id=$1 AND m.organisation_id=$2 AND m.status='active'`,
      [owner.user_id, owner.organisation_id]
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const session = await one<{ id: string }>(
      db,
      `INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '8 hours')
       RETURNING id`,
      [owner.user_id, owner.organisation_id, hash(refreshToken)]
    );

    const accessToken = await new SignJWT({
      organisationId: owner.organisation_id,
      sessionId: session.id,
      permissions: permissions.rows.map(item => item.key),
      preview: true
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.user_id)
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(new TextEncoder().encode(config.JWT_SECRET));

    return {
      accessToken,
      refreshToken,
      expiresIn: 28800,
      organisationId: owner.organisation_id,
      preview: true
    };
  };

  app.post('/v1/auth/preview-session', createPreviewSession);
  app.post('/v1/auth/preview', createPreviewSession);
}
