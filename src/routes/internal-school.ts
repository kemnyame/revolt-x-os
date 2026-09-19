import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { one, transaction } from '../db/index.js';
import { audit, emitEvent } from '../core/audit.js';
import { AppError, conflict, notFound } from '../core/errors.js';

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
  app.get('/v1/internal/school/users',{config:{rateLimit:{max:1200,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const q=scopeSchema.parse(request.query);
    return (await db.query(
      `SELECT u.id,u.email,u.first_name,u.last_name,u.status,
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
      email:z.string().email(),
      firstName:z.string().min(1).max(100),
      lastName:z.string().min(1).max(100),
      jobTitle:z.string().max(160).optional(),
      employeeNumber:z.string().max(80).optional(),
      roleKey:z.string().default('member')
    }).parse(request.body);

    try{
      const result=await transaction(db,async c=>{
        const generated=randomBytes(24).toString('base64url');
        const user=await one<{id:string}>(
          c,
          `INSERT INTO users(email,password_hash,first_name,last_name,status)
           VALUES($1,$2,$3,$4,'invited')
           ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,updated_at=now()
           RETURNING id`,
          [b.email.toLowerCase(),await bcrypt.hash(generated,12),b.firstName,b.lastName]
        );
        const existing=await c.query(
          'SELECT id FROM organisation_memberships WHERE organisation_id=$1 AND user_id=$2',
          [b.organisationId,user.id]
        );
        if(existing.rowCount)throw conflict('User is already a member');

        const membership=await one<any>(
          c,
          `INSERT INTO organisation_memberships(organisation_id,user_id,job_title,employee_number,status)
           VALUES($1,$2,$3,$4,'invited')
           RETURNING *`,
          [b.organisationId,user.id,b.jobTitle??null,b.employeeNumber??null]
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
          afterState:{email:b.email,role:b.roleKey}
        });
        await emitEvent(c,b.organisationId,'core.user.invited.v1','membership',membership.id,{membershipId:membership.id,email:b.email});
        return membership;
      });
      return reply.code(201).send(result);
    }catch(e:any){
      if(e.code==='23505')throw conflict('User is already a member or employee number is in use');
      throw e;
    }
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
      await audit(c,{
        organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.membership_status_changed',resourceType:'membership',resourceId:p.membershipId,
        beforeState:before,afterState:row
      });
      return row;
    });
  });
}
