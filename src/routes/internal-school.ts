import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
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
  app.post('/v1/internal/school/ensure-tenant',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    if(!config.SCHOOL_APP_URL)throw new AppError(503,'SERVICE_UNAVAILABLE','School application URL is not configured');
    const b=z.object({schoolName:z.string().trim().min(2).max(160)}).parse(request.body);
    const q=b.schoolName;
    const slug=q.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

    const matches=(await db.query(
      `SELECT o.id,o.name,o.slug,o.status organisation_status,
              c.provider_organisation_id,c.customer_type,c.school_type,c.primary_contact_name,
              c.primary_contact_email,c.primary_contact_phone,c.address,c.status customer_status,
              s.id subscription_id,s.product_id,s.plan_id,s.billing_frequency,s.status subscription_status,
              s.currency,s.recurring_amount,s.current_period_end,s.trial_ends_at,s.grace_ends_at,s.limits,s.license_code,
              p.product_key,p.name product_name,pl.plan_key,pl.name plan_name
       FROM organisations o
       JOIN saas_customers c ON c.customer_organisation_id=o.id AND c.customer_type='school'
       JOIN LATERAL (
         SELECT * FROM saas_subscriptions sx
         WHERE sx.customer_organisation_id=o.id AND sx.status IN('trial','active','grace')
         ORDER BY sx.created_at DESC LIMIT 1
       ) s ON true
       JOIN saas_products p ON p.id=s.product_id AND p.product_key='school'
       LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id
       WHERE o.status='active'
         AND (lower(o.name)=lower($1) OR lower(o.slug)=lower($2) OR o.name ILIKE $3 OR o.slug ILIKE $3)
       ORDER BY CASE WHEN lower(o.name)=lower($1) THEN 0 WHEN lower(o.slug)=lower($2) THEN 1 ELSE 2 END,o.name
       LIMIT 3`,
      [q,slug,'%'+q+'%']
    )).rows;
    if(!matches.length)throw notFound('Licensed School organisation');
    if(matches.length>1&&String(matches[0].name).toLowerCase()!==q.toLowerCase()&&String(matches[0].slug).toLowerCase()!==slug)
      throw conflict('More than one licensed School matches that name');
    const customer=matches[0] as any;

    const members=(await db.query(
      `SELECT u.id,u.email,u.first_name,u.last_name,u.status user_status,
              m.id membership_id,m.job_title,m.employee_number,m.login_staff_id,m.status membership_status,
              COALESCE(array_agg(DISTINCT r.key) FILTER(WHERE r.key IS NOT NULL),'{}') roles
       FROM organisation_memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id
       WHERE m.organisation_id=$1 AND m.status='active'
       GROUP BY u.id,m.id
       ORDER BY u.first_name,u.last_name`,
      [customer.id]
    )).rows as any[];

    const usableMembers=members.filter((u:any)=>String(u.email||'').toLowerCase()!=='preview@revolt-x.local');
    const admin=usableMembers.find((u:any)=>Array.isArray(u.roles)&&u.roles.includes('owner')&&String(u.email||'').includes('@')&&!String(u.email).endsWith('@revolt-x.local'))
      || usableMembers.find((u:any)=>String(u.email||'').toLowerCase()===String(customer.primary_contact_email||'').toLowerCase())
      || usableMembers.find((u:any)=>String(u.user_status)==='active'&&String(u.email||'').includes('@')&&!String(u.email).endsWith('@revolt-x.local'));
    if(!admin)throw new AppError(409,'SCHOOL_ADMIN_REQUIRED','No usable School administrator exists for this organisation');

    const modules=(await db.query(
      `SELECT pm.module_key,COALESCE(sm.enabled,COALESCE(ppm.included,false)) enabled
       FROM saas_product_modules pm
       LEFT JOIN saas_plan_modules ppm ON ppm.module_id=pm.id AND ppm.plan_id=$1
       LEFT JOIN saas_subscription_modules sm ON sm.module_id=pm.id AND sm.subscription_id=$2
       WHERE pm.product_id=$3 AND pm.is_active=true
       ORDER BY pm.sort_order,pm.name`,
      [customer.plan_id,customer.subscription_id,customer.product_id]
    )).rows;
    const entitlement={
      licensed:true,status:customer.subscription_status,subscriptionId:customer.subscription_id,
      licenseCode:customer.license_code,product:customer.product_key,productName:customer.product_name,
      plan:customer.plan_key,planName:customer.plan_name,billingFrequency:customer.billing_frequency,
      recurringAmount:Number(customer.recurring_amount||0),currency:customer.currency,
      periodEnd:customer.current_period_end,trialEndsAt:customer.trial_ends_at,graceEndsAt:customer.grace_ends_at,
      limits:customer.limits||{},modules:modules.filter((m:any)=>m.enabled).map((m:any)=>m.module_key)
    };

    const base=config.SCHOOL_APP_URL.replace(/\/$/,'');
    const response=await fetch(base+'/api/internal/provision',{
      method:'POST',
      headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY!,'content-type':'application/json'},
      body:JSON.stringify({
        organisationId:customer.id,tenantSlug:customer.slug,schoolName:customer.name,
        schoolType:customer.school_type??null,adminUserId:admin.id,adminEmail:admin.email,
        adminFirstName:admin.first_name,adminLastName:admin.last_name,
        phone:customer.primary_contact_phone??null,address:customer.address??null,entitlement
      }),
      signal:AbortSignal.timeout(30000)
    }).catch(()=>null);
    if(!response)throw new AppError(503,'SCHOOL_UNAVAILABLE','School provisioning service could not be reached');
    const payload=await response.json().catch(()=>null) as any;
    if(!response.ok)throw new AppError(response.status,'SCHOOL_PROVISION_FAILED',payload?.error?.message||'School provisioning failed');

    const staffPayload=usableMembers.map((u:any)=>({
      osUserId:u.id,
      email:String(u.email||'').endsWith('@revolt-x.local')?null:u.email,
      firstName:u.first_name,lastName:u.last_name,userStatus:u.user_status,
      jobTitle:u.job_title??null,employeeNumber:u.employee_number??null,loginStaffId:u.login_staff_id??null,coreRoles:u.roles||[]
    }));
    const staffSyncResponse=await fetch(base+'/api/internal/sync-staff',{
      method:'POST',
      headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY!,'content-type':'application/json'},
      body:JSON.stringify({organisationId:customer.id,members:staffPayload}),
      signal:AbortSignal.timeout(30000)
    }).catch(()=>null);
    if(!staffSyncResponse)throw new AppError(503,'SCHOOL_UNAVAILABLE','School staff sync service could not be reached');
    const staffSync=await staffSyncResponse.json().catch(()=>null) as any;
    if(!staffSyncResponse.ok)throw new AppError(staffSyncResponse.status,'SCHOOL_STAFF_SYNC_FAILED',staffSync?.error?.message||'School staff sync failed');

    await db.query('UPDATE saas_subscriptions SET provisioned_at=COALESCE(provisioned_at,now()),last_synced_at=now(),updated_at=now() WHERE id=$1',[customer.subscription_id]);
    return{
      organisation:{id:customer.id,name:customer.name,slug:customer.slug},
      entitlement,
      provisioning:payload,
      staffSync,
      members:usableMembers.map((u:any)=>({
        id:u.id,email:String(u.email||'').endsWith('@revolt-x.local')?null:u.email,
        first_name:u.first_name,last_name:u.last_name,user_status:u.user_status,
        membership_status:u.membership_status,job_title:u.job_title,employee_number:u.employee_number,login_staff_id:u.login_staff_id,roles:u.roles
      }))
    };
  });

  app.post('/v1/internal/school/authenticate-staff',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const b=z.object({
      staffId:z.string().trim().min(4).max(120),
      password:z.string().min(1).max(200)
    }).parse(request.body);

    const row=await maybeOne<any>(db,`SELECT
        u.id user_id,u.email,u.first_name,u.last_name,u.status user_status,u.password_hash,
        m.id membership_id,m.organisation_id,m.job_title,m.employee_number,m.login_staff_id,m.status membership_status,
        o.name organisation_name,o.slug organisation_slug,o.status organisation_status,
        COALESCE(array_agg(DISTINCT r.key) FILTER(WHERE r.key IS NOT NULL),'{}') roles
      FROM organisation_memberships m
      JOIN users u ON u.id=m.user_id
      JOIN organisations o ON o.id=m.organisation_id
      LEFT JOIN membership_roles mr ON mr.membership_id=m.id
      LEFT JOIN roles r ON r.id=mr.role_id
      WHERE lower(m.login_staff_id)=lower($1)
      GROUP BY u.id,m.id,o.id
      LIMIT 1`,[b.staffId]);

    if(!row)throw new AppError(401,'INVALID_CREDENTIALS','Invalid Staff ID or password');
    if(row.user_status!=='active'||row.membership_status!=='active'||row.organisation_status!=='active')
      throw new AppError(403,'ACCOUNT_INACTIVE','This staff account is not active');

    const valid=await bcrypt.compare(b.password,row.password_hash);
    if(!valid)throw new AppError(401,'INVALID_CREDENTIALS','Invalid Staff ID or password');

    await audit(db,{
      organisationId:row.organisation_id,actorUserId:row.user_id,sessionId:null,
      action:'school_service.staff_id_authenticated',resourceType:'membership',resourceId:row.membership_id,
      afterState:{staffId:row.login_staff_id}
    });

    return{
      id:row.user_id,
      membership_id:row.membership_id,
      organisation_id:row.organisation_id,
      organisation_name:row.organisation_name,
      organisation_slug:row.organisation_slug,
      email:String(row.email||'').endsWith('@revolt-x.local')?null:row.email,
      first_name:row.first_name,
      last_name:row.last_name,
      job_title:row.job_title,
      employee_number:row.employee_number,
      staff_id:row.login_staff_id,
      status:row.user_status,
      membership_status:row.membership_status,
      roles:row.roles
    };
  });

  app.get('/v1/internal/school/users',{config:{rateLimit:{max:1200,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const q=scopeSchema.parse(request.query);
    return (await db.query(
      `SELECT u.id,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END email,u.first_name,u.last_name,u.status,
              m.id membership_id,m.job_title,m.employee_number,m.login_staff_id,m.status membership_status,m.joined_at,
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
      roleKey:z.string().default('member'),
      temporaryPassword:z.string().min(12).max(200)
        .regex(/[A-Z]/,'Password must contain an uppercase letter')
        .regex(/[a-z]/,'Password must contain a lowercase letter')
        .regex(/[0-9]/,'Password must contain a number').optional()
    }).parse(request.body);

    try{
      const result=await transaction(db,async c=>{
        const generated=b.temporaryPassword||randomBytes(24).toString('base64url');
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

        // Staff numbers are generated centrally by Core OS. The transaction lock keeps
        // the organisation-local sequence safe when staff are created concurrently.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`school-staff-number:${b.organisationId}`]);
        const staffSequence=await one<{next_no:number}>(
          c,
          `SELECT COALESCE(MAX(
             CASE WHEN employee_number ~ '^STF-[0-9]{6}$'
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
          afterState:{email:b.email??null,role:b.roleKey,emailPending:!b.email,employeeNumber:membership.employee_number,staffId:membership.login_staff_id}
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

  app.post('/v1/internal/school/users/:membershipId/password-reset',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    requireSchoolService(request,config);
    const p=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      organisationId:z.string().uuid(),
      actorUserId:z.string().uuid(),
      temporaryPassword:z.string().min(12).max(200)
        .regex(/[A-Z]/,'Password must contain an uppercase letter')
        .regex(/[a-z]/,'Password must contain a lowercase letter')
        .regex(/[0-9]/,'Password must contain a number')
    }).parse(request.body);

    return transaction(db,async c=>{
      const membership=await one<any>(c,`SELECT m.*,u.email,u.first_name,u.last_name,u.status user_status
        FROM organisation_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.id=$1 AND m.organisation_id=$2 FOR UPDATE OF m,u`,[p.membershipId,b.organisationId]);
      const passwordHash=await bcrypt.hash(b.temporaryPassword,12);
      await c.query("UPDATE users SET password_hash=$1,status='active',updated_at=now() WHERE id=$2",[passwordHash,membership.user_id]);
      await c.query("UPDATE organisation_memberships SET status='active' WHERE id=$1",[membership.id]);
      await c.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND organisation_id=$2 AND revoked_at IS NULL',
        [membership.user_id,b.organisationId]);
      await c.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[membership.user_id]);
      await audit(c,{
        organisationId:b.organisationId,actorUserId:b.actorUserId,sessionId:null,
        action:'school_service.password_reset_to_temporary',resourceType:'user',resourceId:membership.user_id,
        afterState:{email:String(membership.email||'').endsWith('@revolt-x.local')?null:membership.email,membershipId:membership.id,staffId:membership.login_staff_id,sessionsRevoked:true}
      });
      return{reset:true,userId:membership.user_id,membershipId:membership.id,email:String(membership.email||'').endsWith('@revolt-x.local')?null:membership.email,staffId:membership.login_staff_id};
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
