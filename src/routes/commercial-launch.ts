import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { requirePermission } from '../core/http.js';
import { audit } from '../core/audit.js';
import { AppError, notFound } from '../core/errors.js';

/**
 * Commercial-launch controls that sit above the generic SaaS CRUD routes.
 *
 * Why this module exists:
 * - Plan/module composition is a commercial policy, not just a row update.
 * - Core School modules may never be disabled by a plan or per-school override.
 * - Core OS needs a supported read path into School audit activity without sharing databases.
 * - User-facing School links need one predictable naming policy.
 */
export async function commercialLaunchRoutes(
  app: FastifyInstance,
  { db, config }: { db: Db; config: Config }
) {
  /** Return a stable public identifier containing both the School name and its immutable ID. */
  const schoolPublicKey=(name:string,id:string)=>{
    const slug=String(name||'school').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,56)||'school';
    return `${slug}-${String(id).replace(/-/g,'').slice(0,8)}`;
  };

  const schoolBase=()=>{
    const base=String(config.SCHOOL_APP_URL||'').replace(/\/$/,'');
    if(!base)throw new AppError(503,'SCHOOL_APP_NOT_CONFIGURED','Revolt-X School application URL is not configured');
    return base;
  };

  const serviceHeaders=()=>{
    if(!config.SCHOOL_SERVICE_KEY)throw new AppError(503,'SCHOOL_SERVICE_NOT_CONFIGURED','School service authentication is not configured');
    return {'x-revolt-service-key':config.SCHOOL_SERVICE_KEY};
  };

  /**
   * Replace the module composition of a plan in one transaction.
   * Core modules are added automatically even if the caller omits them. This is the server-side
   * control that ensures every plan remains at least as capable as the Basic foundation.
   */
  app.put('/v1/commercial-control/plans/:id/modules',async request=>{
    const a=requirePermission(request,'commercial.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({moduleKeys:z.array(z.string().min(3).max(120)).max(100)}).parse(request.body);

    const result=await transaction(db,async client=>{
      const plan=await one<any>(client,`SELECT pl.*,p.product_key FROM saas_pricing_plans pl
        JOIN saas_products p ON p.id=pl.product_id WHERE pl.id=$1 FOR UPDATE`,[id]);
      const modules=(await client.query(`SELECT id,module_key,name,is_core FROM saas_product_modules
        WHERE product_id=$1 AND is_active=true ORDER BY sort_order,name`,[plan.product_id])).rows;
      const known=new Set(modules.map((m:any)=>String(m.module_key)));
      const unknown=b.moduleKeys.filter(key=>!known.has(key));
      if(unknown.length)throw new AppError(400,'UNKNOWN_MODULE','Unknown module(s): '+unknown.join(', '));

      const selected=new Set(b.moduleKeys);
      for(const module of modules)if(module.is_core)selected.add(module.module_key);

      await client.query('DELETE FROM saas_plan_modules WHERE plan_id=$1',[id]);
      for(const module of modules){
        await client.query(`INSERT INTO saas_plan_modules(plan_id,module_id,included)
          VALUES($1,$2,$3)`,[id,module.id,selected.has(module.module_key)]);
      }
      return{
        plan,
        modules:modules.map((m:any)=>({...m,included:selected.has(m.module_key)})),
        baseline:modules.filter((m:any)=>m.is_core).map((m:any)=>m.module_key)
      };
    });

    await audit(db,{
      organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,
      action:'commercial.plan.modules_updated',resourceType:'saas_plan',resourceId:id,
      afterState:{moduleKeys:result.modules.filter((m:any)=>m.included).map((m:any)=>m.module_key),baseline:result.baseline}
    });
    return result;
  });

  /** Edit catalogue metadata without requiring a database migration for every commercial change. */
  app.patch('/v1/commercial-control/modules/:id',async request=>{
    const a=requirePermission(request,'commercial.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({
      name:z.string().trim().min(2).max(160).optional(),
      description:z.string().trim().max(1000).nullable().optional(),
      baseMonthlyPrice:z.coerce.number().min(0).optional(),
      sortOrder:z.coerce.number().int().min(0).max(10000).optional(),
      isActive:z.boolean().optional()
    }).refine(v=>Object.keys(v).length>0).parse(request.body);
    const before=await one<any>(db,'SELECT * FROM saas_product_modules WHERE id=$1',[id]);
    const row=await one<any>(db,`UPDATE saas_product_modules SET
      name=COALESCE($1,name),
      description=CASE WHEN $2 THEN $3 ELSE description END,
      base_monthly_price=COALESCE($4,base_monthly_price),
      sort_order=COALESCE($5,sort_order),
      is_active=COALESCE($6,is_active),updated_at=now()
      WHERE id=$7 RETURNING *`,[
        b.name??null,Object.hasOwn(b,'description'),b.description??null,b.baseMonthlyPrice??null,
        b.sortOrder??null,b.isActive??null,id
      ]);
    await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,
      action:'commercial.module.updated',resourceType:'saas_product_module',resourceId:id,beforeState:before,afterState:row});
    return row;
  });

  /**
   * Return customer-specific module controls. A core module is marked locked so the Commercial
   * UI can explain why it cannot be disabled. Non-core modules remain adjustable per School.
   */
  app.get('/v1/commercial-control/schools/:id/modules',async request=>{
    const a=requirePermission(request,'commercial.read');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const customer=await maybeOne<any>(db,'SELECT 1 FROM saas_customers WHERE provider_organisation_id=$1 AND customer_organisation_id=$2',[a.organisationId,id]);
    if(!customer)throw notFound('School customer');
    const sub=await maybeOne<any>(db,`SELECT * FROM saas_subscriptions
      WHERE provider_organisation_id=$1 AND customer_organisation_id=$2
      ORDER BY created_at DESC LIMIT 1`,[a.organisationId,id]);
    if(!sub)throw notFound('School subscription');
    return (await db.query(`SELECT m.id,m.module_key,m.name,m.description,m.is_core,
      COALESCE(sm.enabled,COALESCE(pm.included,false),m.is_core) enabled,
      CASE WHEN m.is_core THEN true ELSE false END locked
      FROM saas_product_modules m
      LEFT JOIN saas_plan_modules pm ON pm.module_id=m.id AND pm.plan_id=$1
      LEFT JOIN saas_subscription_modules sm ON sm.module_id=m.id AND sm.subscription_id=$2
      WHERE m.product_id=$3 AND m.is_active=true ORDER BY m.sort_order,m.name`,[sub.plan_id,sub.id,sub.product_id])).rows;
  });

  /** User-facing School links contain a readable School name plus the immutable ID prefix. */
  app.get('/v1/commercial-control/schools/:id/access-links',async request=>{
    const a=requirePermission(request,'commercial.read');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const school=await maybeOne<any>(db,`SELECT o.id,o.name,o.slug FROM saas_customers c
      JOIN organisations o ON o.id=c.customer_organisation_id
      WHERE c.provider_organisation_id=$1 AND c.customer_organisation_id=$2`,[a.organisationId,id]);
    if(!school)throw notFound('School customer');
    const key=schoolPublicKey(school.name,school.id),base=schoolBase();
    return{
      schoolKey:key,
      loginUrl:`${base}/school/${encodeURIComponent(key)}/login?school=${encodeURIComponent(school.slug)}`,
      adminLoginUrl:`${base}/school/${encodeURIComponent(key)}/admin-login?school=${encodeURIComponent(school.slug)}`,
      canonicalSubdomain:`${key}.school.revolt-x.app`
    };
  });

  /**
   * Core OS does not query the School database directly. It asks the School service for its audit
   * trail through a service-authenticated endpoint, preserving the product/database boundary.
   */
  app.get('/v1/commercial-control/schools/:id/activity',async request=>{
    const a=requirePermission(request,'commercial.read');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const q=z.object({limit:z.coerce.number().int().min(1).max(250).default(100)}).parse(request.query);
    const customer=await maybeOne<any>(db,'SELECT 1 FROM saas_customers WHERE provider_organisation_id=$1 AND customer_organisation_id=$2',[a.organisationId,id]);
    if(!customer)throw notFound('School customer');

    const response=await fetch(`${schoolBase()}/api/internal/audit?organisationId=${encodeURIComponent(id)}&limit=${q.limit}`,{
      headers:serviceHeaders(),signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    if(!response)throw new AppError(503,'SCHOOL_UNAVAILABLE','Revolt-X School could not be reached to retrieve administrator activity');
    const payload=await response.json().catch(()=>null) as any;
    if(!response.ok)throw new AppError(response.status,'SCHOOL_AUDIT_LOOKUP_FAILED',payload?.error?.message||'Could not read School administrator activity');
    return payload;
  });
}
