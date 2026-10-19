import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {newPasswordSchema} from '../auth/password-change.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import {createSchoolAccount,findSchoolAccount,nextSchoolStaffId} from '../auth/school-accounts.js';
import {setSchoolCredential} from '../auth/school-credentials.js';
import { audit, emitEvent } from '../core/audit.js';
import { conflict, notFound } from '../core/errors.js';
import { requirePermission } from '../core/http.js';

export async function userRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/users', async request => {
    const a = requirePermission(request, 'users.read');
    return (await db.query(
      `SELECT u.id,CASE WHEN sa.user_id IS NULL THEN u.email ELSE sa.email END email,
              COALESCE(sa.first_name,u.first_name) first_name,COALESCE(sa.last_name,u.last_name) last_name,COALESCE(sa.status,u.status) status,
              m.id membership_id,m.job_title,m.employee_number,m.status membership_status,m.joined_at,
              COALESCE(array_agg(DISTINCT r.key) FILTER(WHERE r.key IS NOT NULL),'{}') roles
       FROM organisation_memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN school_accounts sa ON sa.organisation_id=m.organisation_id AND sa.user_id=u.id
       LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id
       WHERE m.organisation_id=$1
       GROUP BY u.id,m.id,sa.organisation_id,sa.user_id
       ORDER BY u.first_name,u.last_name`,
      [a.organisationId]
    )).rows;
  });

  app.post('/v1/users', async (request, reply) => {
    const a = requirePermission(request, 'users.manage');
    const b = z.object({
      email: z.string().email(),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      jobTitle: z.string().max(160).optional(),
      employeeNumber: z.string().max(80).optional(),
      roleKey: z.string().default('member'),
      temporaryPassword:newPasswordSchema
    }).parse(request.body);

    try {
      const result = await transaction(db, async c => {
        const passwordHash=await bcrypt.hash(b.temporaryPassword,12);
        const school=await maybeOne(c,`SELECT 1 FROM organisations o WHERE o.id=$1 AND
          (o.settings->>'application'='school' OR EXISTS(SELECT 1 FROM saas_customers sc WHERE sc.customer_organisation_id=o.id AND sc.customer_type='school'))`,[a.organisationId]);
        if(school&&await findSchoolAccount(c,a.organisationId,b.email))throw conflict('Email is already in use in this school');
        const user = school?await createSchoolAccount(c,a.organisationId,{email:b.email,firstName:b.firstName,lastName:b.lastName,status:'active'}):await one<{ id: string }>(
          c,
          `INSERT INTO users(email,password_hash,first_name,last_name,status,must_change_password)
           VALUES($1,$2,$3,$4,'active',true)
           RETURNING id`,
          [b.email.toLowerCase(), passwordHash, b.firstName, b.lastName]
        );
        if(school)await setSchoolCredential(c,a.organisationId,user.id,passwordHash,true);
        const membership = await one<any>(
          c,
          `INSERT INTO organisation_memberships(organisation_id,user_id,job_title,employee_number,status)
           VALUES($1,$2,$3,$4,'active')
           RETURNING *`,
          [a.organisationId, user.id, b.jobTitle ?? null, b.employeeNumber ?? (school?await nextSchoolStaffId(c,a.organisationId):null)]
        );
        const assigned = await c.query(
          `INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
           SELECT $1,id,'organisation',$2,$3
           FROM roles
           WHERE key=$4 AND (organisation_id IS NULL OR organisation_id=$2)
           ORDER BY organisation_id NULLS LAST
           LIMIT 1`,
          [membership.id, a.organisationId, a.userId, b.roleKey]
        );
        if (!assigned.rowCount) throw notFound('Role');
        await audit(c, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          sessionId: a.sessionId,
          action: 'user.created',
          resourceType: 'membership',
          resourceId: membership.id,
          afterState: { email: b.email, role: b.roleKey }
        });
        await emitEvent(c, a.organisationId, 'core.user.created.v1', 'membership', membership.id, { membershipId: membership.id, email: b.email });
        return {...membership,requiresPasswordChange:true};
      });
      return reply.code(201).send(result);
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Email, membership or employee number is already in use in this workspace');
      throw e;
    }
  });

  app.patch('/v1/users/:membershipId', async request => {
    const a = requirePermission(request, 'users.manage');
    const p = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    const b = z.object({
      firstName: z.string().min(1).max(100).optional(),
      lastName: z.string().min(1).max(100).optional(),
      jobTitle: z.string().max(160).nullable().optional(),
      employeeNumber: z.string().max(80).nullable().optional(),
      roleKey: z.string().min(1).max(80).optional()
    }).refine(v => Object.keys(v).length > 0).parse(request.body);

    try {
      return transaction(db, async c => {
        const before = await one<any>(
          c,
          `SELECT m.*,COALESCE(sa.first_name,u.first_name) first_name,COALESCE(sa.last_name,u.last_name) last_name,sa.user_id school_account_id
           FROM organisation_memberships m
           JOIN users u ON u.id=m.user_id
           LEFT JOIN school_accounts sa ON sa.organisation_id=m.organisation_id AND sa.user_id=u.id
           WHERE m.id=$1 AND m.organisation_id=$2
           FOR UPDATE OF m,u`,
          [p.membershipId, a.organisationId]
        );

        if (b.firstName !== undefined || b.lastName !== undefined) {
          if(before.school_account_id){
            await c.query(`UPDATE school_accounts SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),updated_at=now()
              WHERE user_id=$3 AND organisation_id=$4`,[b.firstName??null,b.lastName??null,before.user_id,a.organisationId]);
          }else{
            await c.query(`UPDATE users SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),updated_at=now() WHERE id=$3`,
              [b.firstName??null,b.lastName??null,before.user_id]);
          }
        }

        await c.query(
          `UPDATE organisation_memberships
           SET job_title=CASE WHEN $1 THEN $2 ELSE job_title END,
               employee_number=CASE WHEN $3 THEN $4 ELSE employee_number END
           WHERE id=$5`,
          [Object.hasOwn(b, 'jobTitle'), b.jobTitle ?? null, Object.hasOwn(b, 'employeeNumber'), b.employeeNumber ?? null, p.membershipId]
        );

        if (b.roleKey) {
          const role = await one<{ id: string }>(
            c,
            `SELECT id FROM roles
             WHERE key=$1 AND (organisation_id IS NULL OR organisation_id=$2)
             ORDER BY organisation_id NULLS LAST
             LIMIT 1`,
            [b.roleKey, a.organisationId]
          );
          await c.query('DELETE FROM membership_roles WHERE membership_id=$1 AND scope_type=$2 AND scope_id=$3', [p.membershipId, 'organisation', a.organisationId]);
          await c.query(
            `INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
             VALUES($1,$2,'organisation',$3,$4)`,
            [p.membershipId, role.id, a.organisationId, a.userId]
          );
        }

        const row = await one<any>(
          c,
          `SELECT u.id,CASE WHEN sa.user_id IS NULL THEN u.email ELSE sa.email END email,
            COALESCE(sa.first_name,u.first_name) first_name,COALESCE(sa.last_name,u.last_name) last_name,COALESCE(sa.status,u.status) status,m.id membership_id,m.job_title,m.employee_number,m.status membership_status,m.joined_at,
                  COALESCE(array_agg(DISTINCT r.key) FILTER(WHERE r.key IS NOT NULL),'{}') roles
           FROM organisation_memberships m
           JOIN users u ON u.id=m.user_id
           LEFT JOIN school_accounts sa ON sa.organisation_id=m.organisation_id AND sa.user_id=u.id
           LEFT JOIN membership_roles mr ON mr.membership_id=m.id
           LEFT JOIN roles r ON r.id=mr.role_id
           WHERE m.id=$1 AND m.organisation_id=$2
           GROUP BY u.id,m.id,sa.organisation_id,sa.user_id`,
          [p.membershipId, a.organisationId]
        );

        await audit(c, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          sessionId: a.sessionId,
          action: 'membership.updated',
          resourceType: 'membership',
          resourceId: p.membershipId,
          beforeState: before,
          afterState: row
        });
        return row;
      });
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Employee number is already in use');
      throw e;
    }
  });

  app.patch('/v1/users/:membershipId/status', async request => {
    const a = requirePermission(request, 'users.manage');
    const p = z.object({ membershipId: z.string().uuid() }).parse(request.params);
    const b = z.object({ status: z.enum(['active', 'suspended']) }).parse(request.body);
    return transaction(db, async c => {
      const before = await one<any>(c, 'SELECT * FROM organisation_memberships WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [p.membershipId, a.organisationId]);
      const row = await one<any>(c, 'UPDATE organisation_memberships SET status=$1 WHERE id=$2 RETURNING *', [b.status, p.membershipId]);
      await audit(c, {
        organisationId: a.organisationId,
        actorUserId: a.userId,
        sessionId: a.sessionId,
        action: 'membership.status_changed',
        resourceType: 'membership',
        resourceId: p.membershipId,
        beforeState: before,
        afterState: row
      });
      return row;
    });
  });

  app.get('/v1/roles', async request => {
    const a = requirePermission(request, 'roles.read');
    return (await db.query(
      `SELECT r.id,r.key,r.name,r.description,r.is_system,
              COALESCE(array_agg(p.key) FILTER(WHERE p.key IS NOT NULL),'{}') permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id=r.id
       LEFT JOIN permissions p ON p.id=rp.permission_id
       WHERE r.organisation_id IS NULL OR r.organisation_id=$1
       GROUP BY r.id
       ORDER BY r.is_system DESC,r.name`,
      [a.organisationId]
    )).rows;
  });

  app.get('/v1/permissions', async request => {
    requirePermission(request, 'roles.read');
    return (await db.query('SELECT key,description FROM permissions ORDER BY key')).rows;
  });

  app.post('/v1/roles', async (request, reply) => {
    const a = requirePermission(request, 'roles.manage');
    const b = z.object({
      key: z.string().min(2).max(80).regex(/^[a-z][a-z0-9_.-]*$/),
      name: z.string().min(2).max(120),
      description: z.string().max(1000).optional(),
      permissions: z.array(z.string().min(1)).max(100).default([])
    }).parse(request.body);

    try {
      const row = await transaction(db, async c => {
        const role = await one<any>(
          c,
          `INSERT INTO roles(organisation_id,key,name,description,is_system)
           VALUES($1,$2,$3,$4,false)
           RETURNING *`,
          [a.organisationId, b.key, b.name, b.description ?? null]
        );
        if (b.permissions.length) {
          await c.query(
            `INSERT INTO role_permissions(role_id,permission_id)
             SELECT $1,id FROM permissions WHERE key=ANY($2::text[])
             ON CONFLICT DO NOTHING`,
            [role.id, b.permissions]
          );
        }
        await audit(c, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          sessionId: a.sessionId,
          action: 'role.created',
          resourceType: 'role',
          resourceId: role.id,
          afterState: { ...role, permissions: b.permissions }
        });
        return { ...role, permissions: b.permissions };
      });
      return reply.code(201).send(row);
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Role key is already in use');
      throw e;
    }
  });

  app.patch('/v1/roles/:id', async request => {
    const a = requirePermission(request, 'roles.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().min(2).max(120).optional(),
      description: z.string().max(1000).nullable().optional(),
      permissions: z.array(z.string().min(1)).max(100).optional()
    }).refine(v => Object.keys(v).length > 0).parse(request.body);

    return transaction(db, async c => {
      const before = await one<any>(c, 'SELECT * FROM roles WHERE id=$1 AND organisation_id=$2 AND is_system=false FOR UPDATE', [id, a.organisationId]);
      await c.query(
        `UPDATE roles SET name=COALESCE($1,name),description=CASE WHEN $2 THEN $3 ELSE description END,updated_at=now() WHERE id=$4`,
        [b.name ?? null, Object.hasOwn(b, 'description'), b.description ?? null, id]
      );
      if (b.permissions) {
        await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
        if (b.permissions.length) {
          await c.query(
            `INSERT INTO role_permissions(role_id,permission_id)
             SELECT $1,id FROM permissions WHERE key=ANY($2::text[])
             ON CONFLICT DO NOTHING`,
            [id, b.permissions]
          );
        }
      }
      const row = await one<any>(
        c,
        `SELECT r.id,r.key,r.name,r.description,r.is_system,
                COALESCE(array_agg(p.key) FILTER(WHERE p.key IS NOT NULL),'{}') permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id=r.id
         LEFT JOIN permissions p ON p.id=rp.permission_id
         WHERE r.id=$1
         GROUP BY r.id`,
        [id]
      );
      await audit(c, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'role.updated', resourceType: 'role', resourceId: id, beforeState: before, afterState: row });
      return row;
    });
  });
}
