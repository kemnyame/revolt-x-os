import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { one, transaction } from '../db/index.js';
import { audit, emitEvent } from '../core/audit.js';
import { AppError, conflict, notFound } from '../core/errors.js';
import { buildPreviewContext } from '../auth/preview.js';

function requireSchoolService(request:FastifyRequest,config:Config){
  if(!config.SCHOOL_SERVICE_KEY)throw new AppError(503,'SERVICE_UNAVAILABLE','School service authentication is not configured');
  const supplied=String(request.headers['x-revolt-service-key']||'');
  const expected=config.SCHOOL_SERVICE_KEY;
  if(!supplied)throw new AppError(401,'UNAUTHORIZED','School service credential required');
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))throw new AppError(401,'UNAUTHORIZED','Invalid School service credential');
}

const scopeSchema=z.object({
  organisationId:z.string().uuid()
});

export async function internalSchoolRoutes(app:FastifyInstance,{db,config}:{db:Db;config:Config}){
  app.get('/v1/internal/school/preview-context',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    if(!config.ENABLE_PREVIEW_ACCESS)throw new AppError(403,'PREVIEW_DISABLED','Development preview access is disabled');
    return buildPreviewContext(db);
  });
  app.get('/v1/internal/school/users',{config:{rateLimit:{max:1200,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const q=scopeSchema.parse(request.query);
    return (await db.query(
      `SELECT u.id,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END email,u.first_name,u.last_name,u.status,
              m.id membership_id,m.job_title,m.employee_number,m.status membership_status,m.joined_at,
              COALESCE(array_agg(DISTINCT r.key) FILTER(WHERE r.key IS NOT NULL),'{}') roles
       FROM organisation_memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id
       WHERE m.organisation_id=$1
       GROUP BY u.id,m.id
       ORDER BY u.first_name,u.last_name`,
      [q.organisationId]
    )).rows;
  });

  app.post('/v1/internal/school/users',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async(request,reply)=>{
    requireSchoolService(request,config);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid(),
      email:z.string().trim().toLowerCase().email().optional(),
      firstName:z.string().min(1).max(100),
      lastName:z.string().min(1).max(100),
      jobTitle:z.string().max(160).optional(),
      roleKey:z.string().default('member')
    }).parse(request.body);

    try{
      const result=await transaction(db,async c=>{
        const generated=randomBytes(24).toString('base64url');
        const internalEmail=b.email||('staff-'+randomBytes(12).toString('hex')+'@revolt-x.local');
        const user=await one<{id:string}>(
          c,
          `INSERT INTO users(email,password_hash,first_name,last_name,status)
           VALUES($1,$2,$3,$4,'invited')
           ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,updated_at=now()
           RETURNING id`,
          [internalEmail,await bcrypt.hash(generated,12),b.firstName,b.lastName]
        );
        const existing=await c.query(
          'SELECT id FROM organisation_memberships WHERE organisation_id=$1 AND user_id=$2',
          [b.organisationId,user.id]
        );
        if(existing.rowCount)throw conflict('User is already a member');

        // Staff numbers are owned by Core OS, not typed by School users. The advisory
        // transaction lock makes the sequence safe when multiple staff are created concurrently.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`school-staff-number:${b.organisationId}`]);
        const staffSequence=await one<{next_no:number}>(
          c,
          `SELECT COALESCE(MAX(
             CASE WHEN employee_number ~ '^STF-[0-9]{6}
        const assigned=await c.query(
          `INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
           SELECT $1,id,'organisation',$2,$3
           FROM roles
           WHERE key=$4 AND (organisation_id IS NULL OR organisation_id=$2)
           ORDER BY organisation_id NULLS LAST
           LIMIT 1`,
          [membership.id,b.organisationId,b.actorUserId,b.roleKey]
        );
        if(!assigned.rowCount)throw notFound('Role');
        await audit(c,{
          organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
          action:'school_service.user_invited',resourceType:'membership',resourceId:membership.id,
          afterState:{email:b.email??null,role:b.roleKey,emailPending:!b.email,employeeNumber:membership.employee_number}
        });
        await emitEvent(c,b.organisationId,'core.user.invited.v1','membership',membership.id,{membershipId:membership.id,email:b.email??null,emailPending:!b.email});
        return membership;
      });
      return reply.code(201).send(result);
    }catch(e:any){
      if(e.code==='23505')throw conflict('User is already a member or employee number is in use');
      throw e;
    }
  });

  app.patch('/v1/internal/school/users/:membershipId',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid(),
      firstName:z.string().trim().min(1).max(100).optional(),
      lastName:z.string().trim().min(1).max(100).optional(),
      email:z.string().trim().toLowerCase().email().nullable().optional(),
      jobTitle:z.string().trim().max(160).nullable().optional(),
      employeeNumber:z.string().trim().max(80).nullable().optional()
    }).refine(v=>Object.keys(v).some(k=>!['organisationId','actorUserId'].includes(k))).parse(request.body);

    try{
      return transaction(db,async q=>{
        const before=await one<any>(q,`SELECT m.*,u.email,u.first_name,u.last_name,u.status user_status
          FROM organisation_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.id=$1 AND m.organisation_id=$2 FOR UPDATE OF m,u`,[p.membershipId,b.organisationId]);

        if(b.firstName!==undefined||b.lastName!==undefined||Object.hasOwn(b,'email')){
          const nextEmail=Object.hasOwn(b,'email')
            ?(b.email??('staff-'+randomBytes(12).toString('hex')+'@revolt-x.local'))
            :before.email;
          await q.query(`UPDATE users SET
            first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),email=$3,updated_at=now()
            WHERE id=$4`,[b.firstName??null,b.lastName??null,nextEmail,before.user_id]);
        }
        await q.query(`UPDATE organisation_memberships SET
          job_title=CASE WHEN $1 THEN $2 ELSE job_title END,
          employee_number=CASE WHEN $3 THEN $4 ELSE employee_number END
          WHERE id=$5`,[
          Object.hasOwn(b,'jobTitle'),b.jobTitle??null,Object.hasOwn(b,'employeeNumber'),b.employeeNumber??null,p.membershipId
        ]);
        const row=await one<any>(q,`SELECT u.id,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END email,
          u.first_name,u.last_name,u.status,m.id membership_id,m.job_title,m.employee_number,m.status membership_status,m.joined_at
          FROM organisation_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.id=$1 AND m.organisation_id=$2`,[p.membershipId,b.organisationId]);
        await audit(q,{organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
          action:'school_service.user_updated',resourceType:'membership',resourceId:p.membershipId,beforeState:before,afterState:row});
        return row;
      });
    }catch(e:any){
      if(e.code==='23505')throw conflict('Email or employee number is already in use');
      throw e;
    }
  });

  app.post('/v1/internal/school/users/:membershipId/unlock',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({organisationId:z.string().uuid(),actorUserId:z.string().uuid()}).parse(request.body);
    return transaction(db,async q=>{
      const before=await one<any>(q,`SELECT m.*,u.status user_status FROM organisation_memberships m
        JOIN users u ON u.id=m.user_id WHERE m.id=$1 AND m.organisation_id=$2 FOR UPDATE OF m,u`,
        [p.membershipId,b.organisationId]);
      await q.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1",[before.user_id]);
      const row=await one<any>(q,"UPDATE organisation_memberships SET status='active' WHERE id=$1 AND organisation_id=$2 RETURNING *",
        [p.membershipId,b.organisationId]);
      await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND organisation_id=$2 AND revoked_at IS NULL',
        [before.user_id,b.organisationId]);
      await audit(q,{organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.user_unlocked',resourceType:'membership',resourceId:p.membershipId,beforeState:before,afterState:row});
      return row;
    });
  });

  app.post('/v1/internal/school/users/:membershipId/password-setup',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid()
    }).parse(request.body);

    return transaction(db,async c=>{
      const membership=await one<any>(
        c,
        `SELECT m.*,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END email,u.first_name,u.last_name,u.status user_status
         FROM organisation_memberships m
         JOIN users u ON u.id=m.user_id
         WHERE m.id=$1 AND m.organisation_id=$2
         FOR UPDATE OF m,u`,
        [p.membershipId,b.organisationId]
      );
      if(!membership.email)throw conflict('Add a real email address before creating a password setup invitation');
      await c.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1",[membership.user_id]);
      const token=randomBytes(32).toString('base64url');
      const tokenHash=createHash('sha256').update(token).digest('hex');
      await c.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[membership.user_id]);
      await c.query(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at)
        VALUES($1,$2,now()+interval '24 hours')`,[membership.user_id,tokenHash]);
      await audit(c,{
        organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.teacher_password_setup_created',resourceType:'user',resourceId:membership.user_id,
        afterState:{email:membership.email,membershipId:membership.id,expiresInHours:24}
      });
      return{
        userId:membership.user_id,
        membershipId:membership.id,
        email:membership.email,
        firstName:membership.first_name,
        lastName:membership.last_name,
        setupToken:token,
        expiresInHours:24
      };
    });
  });

  app.patch('/v1/internal/school/users/:membershipId/status',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid(),
      status:z.enum(['active','suspended'])
    }).parse(request.body);

    return transaction(db,async c=>{
      const before=await one<any>(
        c,
        'SELECT * FROM organisation_memberships WHERE id=$1 AND organisation_id=$2 FOR UPDATE',
        [p.membershipId,b.organisationId]
      );
      const row=await one<any>(
        c,
        'UPDATE organisation_memberships SET status=$1 WHERE id=$2 AND organisation_id=$3 RETURNING *',
        [b.status,p.membershipId,b.organisationId]
      );
      await c.query(
        "UPDATE users SET status=CASE WHEN $1='active' THEN 'active' ELSE status END,updated_at=now() WHERE id=$2",
        [b.status,row.user_id]
      );
      await audit(c,{
        organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.membership_status_changed',resourceType:'membership',resourceId:p.membershipId,
        beforeState:before,afterState:row
      });
      return row;
    });
  });
}

                  THEN substring(employee_number from 5)::int
                  ELSE NULL END
           ),0)+1 AS next_no
           FROM organisation_memberships
           WHERE organisation_id=$1`,
          [b.organisationId]
        );
        const employeeNumber='STF-'+String(staffSequence.next_no).padStart(6,'0');
        const membership=await one<any>(
          c,
          `INSERT INTO organisation_memberships(organisation_id,user_id,job_title,employee_number,status)
           VALUES($1,$2,$3,$4,'invited')
           RETURNING *`,
          [b.organisationId,user.id,b.jobTitle??null,employeeNumber]
        );
        const assigned=await c.query(
          `INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
           SELECT $1,id,'organisation',$2,$3
           FROM roles
           WHERE key=$4 AND (organisation_id IS NULL OR organisation_id=$2)
           ORDER BY organisation_id NULLS LAST
           LIMIT 1`,
          [membership.id,b.organisationId,b.actorUserId,b.roleKey]
        );
        if(!assigned.rowCount)throw notFound('Role');
        await audit(c,{
          organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
          action:'school_service.user_invited',resourceType:'membership',resourceId:membership.id,
          afterState:{email:b.email??null,role:b.roleKey,emailPending:!b.email}
        });
        await emitEvent(c,b.organisationId,'core.user.invited.v1','membership',membership.id,{membershipId:membership.id,email:b.email??null,emailPending:!b.email});
        return membership;
      });
      return reply.code(201).send(result);
    }catch(e:any){
      if(e.code==='23505')throw conflict('User is already a member or employee number is in use');
      throw e;
    }
  });

  app.patch('/v1/internal/school/users/:membershipId',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid(),
      firstName:z.string().trim().min(1).max(100).optional(),
      lastName:z.string().trim().min(1).max(100).optional(),
      email:z.string().trim().toLowerCase().email().nullable().optional(),
      jobTitle:z.string().trim().max(160).nullable().optional(),
      employeeNumber:z.string().trim().max(80).nullable().optional()
    }).refine(v=>Object.keys(v).some(k=>!['organisationId','actorUserId'].includes(k))).parse(request.body);

    try{
      return transaction(db,async q=>{
        const before=await one<any>(q,`SELECT m.*,u.email,u.first_name,u.last_name,u.status user_status
          FROM organisation_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.id=$1 AND m.organisation_id=$2 FOR UPDATE OF m,u`,[p.membershipId,b.organisationId]);

        if(b.firstName!==undefined||b.lastName!==undefined||Object.hasOwn(b,'email')){
          const nextEmail=Object.hasOwn(b,'email')
            ?(b.email??('staff-'+randomBytes(12).toString('hex')+'@revolt-x.local'))
            :before.email;
          await q.query(`UPDATE users SET
            first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),email=$3,updated_at=now()
            WHERE id=$4`,[b.firstName??null,b.lastName??null,nextEmail,before.user_id]);
        }
        await q.query(`UPDATE organisation_memberships SET
          job_title=CASE WHEN $1 THEN $2 ELSE job_title END,
          employee_number=CASE WHEN $3 THEN $4 ELSE employee_number END
          WHERE id=$5`,[
          Object.hasOwn(b,'jobTitle'),b.jobTitle??null,Object.hasOwn(b,'employeeNumber'),b.employeeNumber??null,p.membershipId
        ]);
        const row=await one<any>(q,`SELECT u.id,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END email,
          u.first_name,u.last_name,u.status,m.id membership_id,m.job_title,m.employee_number,m.status membership_status,m.joined_at
          FROM organisation_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.id=$1 AND m.organisation_id=$2`,[p.membershipId,b.organisationId]);
        await audit(q,{organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
          action:'school_service.user_updated',resourceType:'membership',resourceId:p.membershipId,beforeState:before,afterState:row});
        return row;
      });
    }catch(e:any){
      if(e.code==='23505')throw conflict('Email or employee number is already in use');
      throw e;
    }
  });

  app.post('/v1/internal/school/users/:membershipId/unlock',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({organisationId:z.string().uuid(),actorUserId:z.string().uuid()}).parse(request.body);
    return transaction(db,async q=>{
      const before=await one<any>(q,`SELECT m.*,u.status user_status FROM organisation_memberships m
        JOIN users u ON u.id=m.user_id WHERE m.id=$1 AND m.organisation_id=$2 FOR UPDATE OF m,u`,
        [p.membershipId,b.organisationId]);
      await q.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1",[before.user_id]);
      const row=await one<any>(q,"UPDATE organisation_memberships SET status='active' WHERE id=$1 AND organisation_id=$2 RETURNING *",
        [p.membershipId,b.organisationId]);
      await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND organisation_id=$2 AND revoked_at IS NULL',
        [before.user_id,b.organisationId]);
      await audit(q,{organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.user_unlocked',resourceType:'membership',resourceId:p.membershipId,beforeState:before,afterState:row});
      return row;
    });
  });

  app.post('/v1/internal/school/users/:membershipId/password-setup',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid()
    }).parse(request.body);

    return transaction(db,async c=>{
      const membership=await one<any>(
        c,
        `SELECT m.*,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END email,u.first_name,u.last_name,u.status user_status
         FROM organisation_memberships m
         JOIN users u ON u.id=m.user_id
         WHERE m.id=$1 AND m.organisation_id=$2
         FOR UPDATE OF m,u`,
        [p.membershipId,b.organisationId]
      );
      if(!membership.email)throw conflict('Add a real email address before creating a password setup invitation');
      await c.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1",[membership.user_id]);
      const token=randomBytes(32).toString('base64url');
      const tokenHash=createHash('sha256').update(token).digest('hex');
      await c.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[membership.user_id]);
      await c.query(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at)
        VALUES($1,$2,now()+interval '24 hours')`,[membership.user_id,tokenHash]);
      await audit(c,{
        organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.teacher_password_setup_created',resourceType:'user',resourceId:membership.user_id,
        afterState:{email:membership.email,membershipId:membership.id,expiresInHours:24}
      });
      return{
        userId:membership.user_id,
        membershipId:membership.id,
        email:membership.email,
        firstName:membership.first_name,
        lastName:membership.last_name,
        setupToken:token,
        expiresInHours:24
      };
    });
  });

  app.patch('/v1/internal/school/users/:membershipId/status',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid(),
      status:z.enum(['active','suspended'])
    }).parse(request.body);

    return transaction(db,async c=>{
      const before=await one<any>(
        c,
        'SELECT * FROM organisation_memberships WHERE id=$1 AND organisation_id=$2 FOR UPDATE',
        [p.membershipId,b.organisationId]
      );
      const row=await one<any>(
        c,
        'UPDATE organisation_memberships SET status=$1 WHERE id=$2 AND organisation_id=$3 RETURNING *',
        [b.status,p.membershipId,b.organisationId]
      );
      await c.query(
        "UPDATE users SET status=CASE WHEN $1='active' THEN 'active' ELSE status END,updated_at=now() WHERE id=$2",
        [b.status,row.user_id]
      );
      await audit(c,{
        organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.membership_status_changed',resourceType:'membership',resourceId:p.membershipId,
        beforeState:before,afterState:row
      });
      return row;
    });
  });
}
