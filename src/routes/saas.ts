import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { audit } from '../core/audit.js';
import { AppError, conflict, notFound } from '../core/errors.js';
import { requirePermission } from '../core/http.js';

function requireSchoolService(request: FastifyRequest, config: Config) {
  if (!config.SCHOOL_SERVICE_KEY) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'School service authentication is not configured');
  const supplied = String(request.headers['x-revolt-service-key'] || '');
  if (!supplied) throw new AppError(401, 'UNAUTHORIZED', 'School service credential required');
  const a = Buffer.from(supplied), b = Buffer.from(config.SCHOOL_SERVICE_KEY);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid School service credential');
}

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'school';

function frequencyAmount(plan: any, frequency: string) {
  if (frequency === 'annual') return Number(plan.annual_price || 0);
  if (frequency === 'termly') return Number(plan.termly_price || 0);
  return Number(plan.monthly_price || 0);
}

function nextPeriodEnd(frequency: string) {
  const d = new Date();
  if (frequency === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (frequency === 'termly') d.setUTCMonth(d.getUTCMonth() + 4);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

async function uniqueSlug(db: Db, name: string) {
  const base = slugify(name);
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? base : base + '-' + (i + 1);
    if (!await maybeOne(db, 'SELECT 1 FROM organisations WHERE slug=$1', [slug])) return slug;
  }
  return base + '-' + Date.now();
}

function newLicenseCode() {
  return 'RXS-' + randomBytes(8).toString('hex').toUpperCase();
}

function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function schoolApplicationBase(config: Config) {
  const value = String(config.SCHOOL_APP_URL || '').replace(/\/$/, '');
  if (!value) throw new AppError(503, 'SCHOOL_APP_NOT_CONFIGURED', 'Revolt-X School application URL is not configured');
  return value;
}

function schoolServiceHeaders(config: Config) {
  if (!config.SCHOOL_SERVICE_KEY) throw new AppError(503, 'SCHOOL_SERVICE_NOT_CONFIGURED', 'School service authentication is not configured');
  return { 'content-type': 'application/json', 'x-revolt-service-key': config.SCHOOL_SERVICE_KEY };
}

async function pushLicenseSnapshot(db: Db, config: Config, providerId: string, customerId: string) {
  const entitlement = await getEntitlements(db, providerId, customerId);
  const response = await fetch(schoolApplicationBase(config) + '/api/internal/license-sync', {
    method: 'POST',
    headers: schoolServiceHeaders(config),
    body: JSON.stringify({ organisationId: customerId, entitlement }),
    signal: AbortSignal.timeout(20000)
  }).catch(() => null);
  if (!response) return { ok: false, message: 'Revolt-X School could not be reached' };
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) return { ok: false, status: response.status, message: payload?.error?.message || 'School licence sync failed' };
  await db.query('UPDATE saas_subscriptions SET last_synced_at=now(),updated_at=now() WHERE id=$1', [entitlement.subscriptionId]).catch(() => null);
  return { ok: true, entitlement, school: payload };
}

async function getEntitlements(db: Db, providerId: string, customerId: string) {
  const sub = await maybeOne<any>(db,
    "SELECT s.*,p.product_key,p.name product_name,pl.plan_key,pl.name plan_name FROM saas_subscriptions s JOIN saas_products p ON p.id=s.product_id LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id WHERE s.provider_organisation_id=$1 AND s.customer_organisation_id=$2 AND s.status IN('trial','active','grace','suspended') ORDER BY s.created_at DESC LIMIT 1",
    [providerId, customerId]
  );
  if (!sub) return { licensed: false, status: 'unlicensed', modules: [], limits: {} };

  const modules = (await db.query(
    "SELECT pm.id,pm.module_key,pm.name,COALESCE(sm.enabled,COALESCE(pl.included,false)) enabled FROM saas_product_modules pm LEFT JOIN saas_plan_modules pl ON pl.module_id=pm.id AND pl.plan_id=$1 LEFT JOIN saas_subscription_modules sm ON sm.module_id=pm.id AND sm.subscription_id=$2 WHERE pm.product_id=$3 AND pm.is_active=true ORDER BY pm.sort_order,pm.name",
    [sub.plan_id, sub.id, sub.product_id]
  )).rows;

  let effectiveStatus=String(sub.status);
  const now=Date.now();
  const expiredByDate=
    (effectiveStatus==='trial'&&sub.trial_ends_at&&new Date(sub.trial_ends_at).getTime()<=now)||
    (effectiveStatus==='active'&&sub.current_period_end&&new Date(sub.current_period_end).getTime()<=now)||
    (effectiveStatus==='grace'&&sub.grace_ends_at&&new Date(sub.grace_ends_at).getTime()<=now);
  if(expiredByDate){
    effectiveStatus='expired';
    await db.query("UPDATE saas_subscriptions SET status='expired',updated_at=now() WHERE id=$1 AND status<>'expired'",[sub.id]).catch(()=>null);
  }

  return {
    licensed: !['expired','cancelled','suspended','unlicensed'].includes(effectiveStatus),
    status: effectiveStatus,
    subscriptionId: sub.id,
    licenseCode: sub.license_code,
    product: sub.product_key,
    productName: sub.product_name,
    plan: sub.plan_key,
    planName: sub.plan_name,
    billingFrequency: sub.billing_frequency,
    recurringAmount: Number(sub.recurring_amount),
    currency: sub.currency,
    periodEnd: sub.current_period_end,
    trialEndsAt: sub.trial_ends_at,
    graceEndsAt: sub.grace_ends_at,
    limits: sub.limits || {},
    modules: modules.filter((m: any) => m.enabled).map((m: any) => m.module_key)
  };
}

async function assignSubscription(db: Db, input: {
  providerId: string;
  customerId: string;
  productId: string;
  planId: string;
  frequency: 'monthly' | 'termly' | 'annual';
  status: 'trial' | 'active' | 'grace' | 'suspended' | 'expired' | 'cancelled';
  actorId: string;
}) {
  const plan = await one<any>(db, 'SELECT * FROM saas_pricing_plans WHERE id=$1 AND product_id=$2 AND is_active=true', [input.planId, input.productId]);
  const price = frequencyAmount(plan, input.frequency);
  const limits = { students: plan.student_limit, staff: plan.staff_limit, campuses: plan.campus_limit, storageGb: Number(plan.storage_gb || 0) };
  const existing = await maybeOne<any>(db,
    "SELECT * FROM saas_subscriptions WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 AND product_id=$3 AND status IN('trial','active','grace','suspended') ORDER BY created_at DESC LIMIT 1",
    [input.providerId, input.customerId, input.productId]
  );
  const trialEnd = input.status === 'trial' ? new Date(Date.now() + 14 * 86400000).toISOString() : null;
  const periodEnd = input.status === 'trial' ? trialEnd : nextPeriodEnd(input.frequency);
  const licenseCode = existing?.license_code || newLicenseCode();

  if (existing) {
    return one<any>(db,
      'UPDATE saas_subscriptions SET plan_id=$1,billing_frequency=$2,status=$3,currency=$4,recurring_amount=$5,trial_ends_at=$6,current_period_start=now(),current_period_end=$7,grace_ends_at=NULL,limits=$8,license_code=COALESCE(license_code,$9),updated_at=now() WHERE id=$10 RETURNING *',
      [plan.id, input.frequency, input.status, plan.currency, price, trialEnd, periodEnd, JSON.stringify(limits), licenseCode, existing.id]
    );
  }

  return one<any>(db,
    'INSERT INTO saas_subscriptions(provider_organisation_id,customer_organisation_id,product_id,plan_id,billing_frequency,status,currency,recurring_amount,trial_ends_at,current_period_end,limits,license_code,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
    [input.providerId, input.customerId, input.productId, plan.id, input.frequency, input.status, plan.currency, price, trialEnd, periodEnd, JSON.stringify(limits), licenseCode, input.actorId]
  );
}

export async function saasRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.get('/v1/commercial-control/overview', async request => {
    const a = requirePermission(request, 'commercial.read');
    const row = (await db.query(
      "SELECT (SELECT count(*) FROM saas_customers c WHERE c.provider_organisation_id=$1 AND c.status<>'archived')::int schools, (SELECT count(*) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='active')::int active_licences, (SELECT count(*) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='trial')::int trials, (SELECT count(*) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status IN('grace','suspended','expired'))::int attention, (SELECT COALESCE(sum(CASE s.billing_frequency WHEN 'annual' THEN s.recurring_amount/12 WHEN 'termly' THEN s.recurring_amount/4 ELSE s.recurring_amount END),0) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='active')::numeric monthly_recurring_revenue, (SELECT COALESCE(sum(i.total-i.amount_paid),0) FROM saas_invoices i WHERE i.provider_organisation_id=$1 AND i.status IN('issued','part_paid','overdue'))::numeric outstanding_invoices",
      [a.organisationId]
    )).rows[0];
    const subscriptionStatus = (await db.query('SELECT status,count(*)::int count FROM saas_subscriptions WHERE provider_organisation_id=$1 GROUP BY status ORDER BY status', [a.organisationId])).rows;
    const renewals = (await db.query(
      "SELECT o.name,s.current_period_end,s.status,pl.name plan_name,s.currency,s.recurring_amount FROM saas_subscriptions s JOIN organisations o ON o.id=s.customer_organisation_id LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id WHERE s.provider_organisation_id=$1 AND s.current_period_end IS NOT NULL AND s.current_period_end<=now()+interval '60 days' AND s.status IN('active','trial','grace') ORDER BY s.current_period_end LIMIT 20",
      [a.organisationId]
    )).rows;
    return { ...row, subscriptionStatus, renewals };
  });

  app.get('/v1/commercial-control/catalog', async request => {
    requirePermission(request, 'commercial.read');
    const product = await one<any>(db, "SELECT * FROM saas_products WHERE product_key='school'");
    const modules = (await db.query('SELECT * FROM saas_product_modules WHERE product_id=$1 ORDER BY sort_order,name', [product.id])).rows;
    const plans = (await db.query(
      "SELECT pl.*,COALESCE(array_agg(pm.module_key ORDER BY pm.sort_order) FILTER(WHERE x.included=true),'{}') modules FROM saas_pricing_plans pl LEFT JOIN saas_plan_modules x ON x.plan_id=pl.id LEFT JOIN saas_product_modules pm ON pm.id=x.module_id WHERE pl.product_id=$1 GROUP BY pl.id ORDER BY pl.sort_order,pl.monthly_price",
      [product.id]
    )).rows;
    return { product, modules, plans };
  });

  app.patch('/v1/commercial-control/plans/:id', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      monthlyPrice: z.coerce.number().min(0).optional(),
      termlyPrice: z.coerce.number().min(0).optional(),
      annualPrice: z.coerce.number().min(0).optional(),
      studentLimit: z.coerce.number().int().positive().nullable().optional(),
      staffLimit: z.coerce.number().int().positive().nullable().optional(),
      campusLimit: z.coerce.number().int().positive().nullable().optional(),
      isActive: z.boolean().optional()
    }).parse(request.body);
    const before = await one<any>(db, 'SELECT * FROM saas_pricing_plans WHERE id=$1', [id]);
    const row = await one<any>(db,
      'UPDATE saas_pricing_plans SET monthly_price=COALESCE($1,monthly_price),termly_price=COALESCE($2,termly_price),annual_price=COALESCE($3,annual_price),student_limit=CASE WHEN $4 THEN $5 ELSE student_limit END,staff_limit=CASE WHEN $6 THEN $7 ELSE staff_limit END,campus_limit=CASE WHEN $8 THEN $9 ELSE campus_limit END,is_active=COALESCE($10,is_active),updated_at=now() WHERE id=$11 RETURNING *',
      [b.monthlyPrice ?? null, b.termlyPrice ?? null, b.annualPrice ?? null, Object.hasOwn(b, 'studentLimit'), b.studentLimit ?? null, Object.hasOwn(b, 'staffLimit'), b.staffLimit ?? null, Object.hasOwn(b, 'campusLimit'), b.campusLimit ?? null, b.isActive ?? null, id]
    );
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.plan.updated', resourceType: 'saas_plan', resourceId: id, beforeState: before, afterState: row });
    return row;
  });

  app.get('/v1/commercial-control/schools', async request => {
    const a = requirePermission(request, 'commercial.read');
    return (await db.query(
      "SELECT o.id,o.name,o.slug,o.status organisation_status,c.customer_type,c.school_type,c.primary_contact_name,c.primary_contact_email,c.primary_contact_phone,c.status customer_status,c.created_at,s.id subscription_id,s.status licence_status,s.billing_frequency,s.currency,s.recurring_amount,s.current_period_end,s.trial_ends_at,s.grace_ends_at,s.limits,pl.name plan_name,pl.plan_key FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id LEFT JOIN LATERAL (SELECT * FROM saas_subscriptions x WHERE x.provider_organisation_id=c.provider_organisation_id AND x.customer_organisation_id=c.customer_organisation_id ORDER BY x.created_at DESC LIMIT 1) s ON true LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id WHERE c.provider_organisation_id=$1 ORDER BY c.created_at DESC,o.name",
      [a.organisationId]
    )).rows;
  });

  app.post('/v1/commercial-control/schools', async (request, reply) => {
    const a = requirePermission(request, 'commercial.manage');
    const b = z.object({
      name: z.string().trim().min(2).max(200),
      slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
      schoolType: z.string().max(80).optional(),
      adminFirstName: z.string().trim().min(1).max(100),
      adminLastName: z.string().trim().min(1).max(100),
      adminEmail: z.string().trim().toLowerCase().email(),
      contactPhone: z.string().max(50).optional(),
      address: z.string().max(1000).optional(),
      planId: z.string().uuid(),
      billingFrequency: z.enum(['monthly', 'termly', 'annual']).default('monthly'),
      licenceStatus: z.enum(['trial', 'active']).default('trial')
    }).parse(request.body);

    const product = await one<any>(db, "SELECT id FROM saas_products WHERE product_key='school'");
    const created = await transaction(db, async c => {
      const slug = b.slug || await uniqueSlug(c, b.name);
      if (await maybeOne(c, 'SELECT id FROM organisations WHERE slug=$1', [slug])) throw conflict('School slug is already in use');

      const org = await one<any>(
        c,
        "INSERT INTO organisations(name,slug,status,settings) VALUES($1,$2,'active',$3) RETURNING *",
        [b.name, slug, JSON.stringify({ application: 'school', managedBy: a.organisationId })]
      );

      let admin = await maybeOne<any>(c, 'SELECT id,email,first_name,last_name,status FROM users WHERE email=$1', [b.adminEmail]);
      let setupToken: string | null = null;
      let newAdministrator = false;

      if (!admin) {
        const generatedPassword = randomBytes(48).toString('base64url');
        admin = await one<any>(
          c,
          "INSERT INTO users(email,password_hash,first_name,last_name,status) VALUES($1,$2,$3,$4,'active') RETURNING id,email,first_name,last_name,status",
          [b.adminEmail, await bcrypt.hash(generatedPassword, 12), b.adminFirstName, b.adminLastName]
        );
        setupToken = randomBytes(32).toString('base64url');
        await c.query(
          "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')",
          [admin.id, tokenHash(setupToken)]
        );
        newAdministrator = true;
      } else {
        if (admin.status !== 'active') throw conflict('The administrator email belongs to an inactive OS user');
        await c.query(
          'UPDATE users SET first_name=$1,last_name=$2,updated_at=now() WHERE id=$3',
          [b.adminFirstName, b.adminLastName, admin.id]
        );
      }

      const membership = await one<any>(
        c,
        "INSERT INTO organisation_memberships(organisation_id,user_id,status,job_title,employee_number) VALUES($1,$2,'active','School Administrator','SCH-ADMIN-001') ON CONFLICT(organisation_id,user_id) DO UPDATE SET status='active',job_title='School Administrator' RETURNING id",
        [org.id, admin.id]
      );
      await c.query(
        "INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by) SELECT $1,r.id,'organisation',$2,$3 FROM roles r WHERE r.organisation_id IS NULL AND r.key='owner' ON CONFLICT DO NOTHING",
        [membership.id, org.id, a.userId]
      );
      await c.query(
        'UPDATE organisations SET settings=$1,updated_at=now() WHERE id=$2',
        [JSON.stringify({ application: 'school', managedBy: a.organisationId, primaryAdminUserId: admin.id }), org.id]
      );

      await c.query(
        "INSERT INTO saas_customers(provider_organisation_id,customer_organisation_id,customer_type,school_type,primary_contact_name,primary_contact_email,primary_contact_phone,address,status,created_by) VALUES($1,$2,'school',$3,$4,$5,$6,$7,$8,$9)",
        [a.organisationId, org.id, b.schoolType ?? null, b.adminFirstName + ' ' + b.adminLastName, b.adminEmail, b.contactPhone ?? null, b.address ?? null, b.licenceStatus === 'trial' ? 'trial' : 'active', a.userId]
      );

      const subscription = await assignSubscription(c, {
        providerId: a.organisationId,
        customerId: org.id,
        productId: product.id,
        planId: b.planId,
        frequency: b.billingFrequency,
        status: b.licenceStatus,
        actorId: a.userId
      });

      const domain = slug + '.school.revolt-x.app';
      await c.query(
        "INSERT INTO saas_customer_domains(provider_organisation_id,customer_organisation_id,domain,domain_type,status) VALUES($1,$2,$3,'subdomain','pending') ON CONFLICT(domain) DO NOTHING",
        [a.organisationId, org.id, domain]
      );
      const job = await one<any>(
        c,
        "INSERT INTO saas_provisioning_jobs(provider_organisation_id,customer_organisation_id,product_id,action,status,details,created_by) VALUES($1,$2,$3,'create_school_tenant','queued',$4,$5) RETURNING id",
        [a.organisationId, org.id, product.id, JSON.stringify({ organisationId: org.id, slug, subscriptionId: subscription.id }), a.userId]
      );

      return { organisation: org, subscription, domain, jobId: job.id, admin, setupToken, newAdministrator };
    });

    const entitlement = await getEntitlements(db, a.organisationId, created.organisation.id);
    const accessUrl = schoolApplicationBase(config) + '/login?school=' + encodeURIComponent(created.organisation.slug);
    const setupUrl = created.setupToken
      ? accessUrl + '&setup=' + encodeURIComponent(created.setupToken)
      : null;

    let provisioning: any = { status: 'failed', message: 'Revolt-X School provisioning did not complete' };
    try {
      const response = await fetch(schoolApplicationBase(config) + '/api/internal/provision', {
        method: 'POST',
        headers: schoolServiceHeaders(config),
        body: JSON.stringify({
          organisationId: created.organisation.id,
          tenantSlug: created.organisation.slug,
          schoolName: created.organisation.name,
          schoolType: b.schoolType ?? null,
          adminUserId: created.admin.id,
          adminEmail: b.adminEmail,
          adminFirstName: b.adminFirstName,
          adminLastName: b.adminLastName,
          phone: b.contactPhone ?? null,
          address: b.address ?? null,
          entitlement
        }),
        signal: AbortSignal.timeout(30000)
      });
      const payload = await response.json().catch(() => null) as any;
      if (!response.ok) throw new Error(payload?.error?.message || 'Revolt-X School rejected the provisioning request');
      provisioning = { status: 'completed', ...payload };
      await db.query(
        "UPDATE saas_provisioning_jobs SET status='completed',details=$1,error=NULL,completed_at=now(),updated_at=now() WHERE id=$2",
        [JSON.stringify(payload ?? {}), created.jobId]
      );
      await db.query(
        'UPDATE saas_subscriptions SET provisioned_at=COALESCE(provisioned_at,now()),last_synced_at=now(),updated_at=now() WHERE id=$1',
        [created.subscription.id]
      );
    } catch (error: any) {
      provisioning = { status: 'failed', message: String(error?.message || error) };
      await db.query(
        "UPDATE saas_provisioning_jobs SET status='failed',error=$1,updated_at=now() WHERE id=$2",
        [provisioning.message, created.jobId]
      );
    }

    const result = {
      organisation: created.organisation,
      subscription: created.subscription,
      entitlement,
      domain: created.domain,
      accessUrl,
      setupUrl,
      administrator: {
        id: created.admin.id,
        email: created.admin.email,
        firstName: b.adminFirstName,
        lastName: b.adminLastName,
        existingUser: !created.newAdministrator
      },
      provisioning
    };
    await audit(db, {
      organisationId: a.organisationId,
      actorUserId: a.userId,
      sessionId: a.sessionId,
      action: 'commercial.school.created',
      resourceType: 'organisation',
      resourceId: created.organisation.id,
      afterState: result
    });
    return reply.code(201).send(result);
  });

  app.get('/v1/commercial-control/schools/:id', async request => {
    const a = requirePermission(request, 'commercial.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const customer = await maybeOne<any>(db, 'SELECT c.*,o.name,o.slug,o.status organisation_status,o.settings FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id WHERE c.provider_organisation_id=$1 AND c.customer_organisation_id=$2', [a.organisationId, id]);
    if (!customer) throw notFound('School customer');
    const [license, domains, invoices, usage, provisioning] = await Promise.all([
      getEntitlements(db, a.organisationId, id),
      db.query('SELECT * FROM saas_customer_domains WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC', [a.organisationId, id]),
      db.query('SELECT * FROM saas_invoices WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC LIMIT 30', [a.organisationId, id]),
      db.query('SELECT DISTINCT ON(metric_key) metric_key,metric_value,measured_at FROM saas_usage_snapshots WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY metric_key,measured_at DESC', [a.organisationId, id]),
      db.query('SELECT * FROM saas_provisioning_jobs WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC LIMIT 1', [a.organisationId, id])
    ]);
    const accessUrl = schoolApplicationBase(config) + '/login?school=' + encodeURIComponent(customer.slug);
    return { customer, license, domains: domains.rows, invoices: invoices.rows, usage: usage.rows, provisioning: provisioning.rows[0] ?? null, accessUrl };
  });

  app.post('/v1/commercial-control/schools/:id/sync-license', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await maybeOne(db, 'SELECT 1 FROM saas_customers WHERE provider_organisation_id=$1 AND customer_organisation_id=$2', [a.organisationId, id])) throw notFound('School customer');
    const sync = await pushLicenseSnapshot(db, config, a.organisationId, id);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.license.synced', resourceType: 'organisation', resourceId: id, afterState: sync });
    return sync;
  });

  app.post('/v1/commercial-control/schools/:id/admin-invite', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const org = await maybeOne<any>(db, 'SELECT id,slug,settings FROM organisations WHERE id=$1', [id]);
    if (!org) throw notFound('School organisation');
    const adminId = org.settings?.primaryAdminUserId;
    if (!adminId) throw notFound('Primary school administrator');
    const user = await one<any>(db, 'SELECT id,email,first_name,last_name FROM users WHERE id=$1', [adminId]);
    const setupToken = randomBytes(32).toString('base64url');
    await transaction(db, async c => {
      await c.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
      await c.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')", [user.id, tokenHash(setupToken)]);
    });
    const setupUrl = schoolApplicationBase(config) + '/login?school=' + encodeURIComponent(org.slug) + '&setup=' + encodeURIComponent(setupToken);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.school_admin.invited', resourceType: 'organisation', resourceId: id, afterState: { email: user.email } });
    return { setupUrl, expiresInHours: 24, administrator: user };
  });

  app.post('/v1/commercial-control/schools/:id/provision', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const customer = await maybeOne<any>(db, 'SELECT c.*,o.name,o.slug,o.settings FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id WHERE c.provider_organisation_id=$1 AND c.customer_organisation_id=$2', [a.organisationId, id]);
    if (!customer) throw notFound('School customer');
    const adminId = customer.settings?.primaryAdminUserId;
    if (!adminId) throw notFound('Primary school administrator');
    const admin = await one<any>(db, 'SELECT id,email,first_name,last_name FROM users WHERE id=$1', [adminId]);
    const entitlement = await getEntitlements(db, a.organisationId, id);
    const job = await one<any>(db, "INSERT INTO saas_provisioning_jobs(provider_organisation_id,customer_organisation_id,product_id,action,status,details,created_by) SELECT $1,$2,p.id,'create_school_tenant','running',$3,$4 FROM saas_products p WHERE p.product_key='school' RETURNING id", [a.organisationId, id, JSON.stringify({ retry: true }), a.userId]);
    try {
      const response = await fetch(schoolApplicationBase(config) + '/api/internal/provision', {
        method: 'POST',
        headers: schoolServiceHeaders(config),
        body: JSON.stringify({
          organisationId: id, tenantSlug: customer.slug, schoolName: customer.name, schoolType: customer.school_type ?? null,
          adminUserId: admin.id, adminEmail: admin.email, adminFirstName: admin.first_name, adminLastName: admin.last_name,
          phone: customer.primary_contact_phone ?? null, address: customer.address ?? null, entitlement
        }),
        signal: AbortSignal.timeout(30000)
      });
      const payload = await response.json().catch(() => null) as any;
      if (!response.ok) throw new Error(payload?.error?.message || 'School provisioning failed');
      await db.query("UPDATE saas_provisioning_jobs SET status='completed',details=$1,error=NULL,completed_at=now(),updated_at=now() WHERE id=$2", [JSON.stringify(payload ?? {}), job.id]);
      await db.query('UPDATE saas_subscriptions SET provisioned_at=COALESCE(provisioned_at,now()),last_synced_at=now(),updated_at=now() WHERE id=$1', [entitlement.subscriptionId]);
      return { ok: true, provisioning: payload, accessUrl: schoolApplicationBase(config) + '/login?school=' + encodeURIComponent(customer.slug) };
    } catch (error: any) {
      await db.query("UPDATE saas_provisioning_jobs SET status='failed',error=$1,updated_at=now() WHERE id=$2", [String(error?.message || error), job.id]);
      return { ok: false, message: String(error?.message || error) };
    }
  });

  app.put('/v1/commercial-control/schools/:id/subscription', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      planId: z.string().uuid(),
      billingFrequency: z.enum(['monthly', 'termly', 'annual']),
      status: z.enum(['trial', 'active', 'grace', 'suspended', 'expired', 'cancelled'])
    }).parse(request.body);
    if (!await maybeOne(db, 'SELECT 1 FROM saas_customers WHERE provider_organisation_id=$1 AND customer_organisation_id=$2', [a.organisationId, id])) throw notFound('School customer');
    const product = await one<any>(db, "SELECT id FROM saas_products WHERE product_key='school'");
    const row = await assignSubscription(db, { providerId: a.organisationId, customerId: id, productId: product.id, planId: b.planId, frequency: b.billingFrequency, status: b.status, actorId: a.userId });
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.subscription.updated', resourceType: 'saas_subscription', resourceId: row.id, afterState: row });
    const licenseSync = await pushLicenseSnapshot(db, config, a.organisationId, id);
    return { ...row, licenseSync };
  });

  app.patch('/v1/commercial-control/schools/:id/license', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      status: z.enum(['trial', 'active', 'grace', 'suspended', 'expired', 'cancelled']),
      graceDays: z.coerce.number().int().min(1).max(90).optional()
    }).parse(request.body);
    const before = await maybeOne<any>(db, 'SELECT * FROM saas_subscriptions WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC LIMIT 1', [a.organisationId, id]);
    if (!before) throw notFound('Subscription');
    const grace = b.status === 'grace' ? new Date(Date.now() + (b.graceDays || 14) * 86400000).toISOString() : null;
    const row = await one<any>(db, "UPDATE saas_subscriptions SET status=$1,grace_ends_at=$2,cancelled_at=CASE WHEN $1='cancelled' THEN now() ELSE cancelled_at END,updated_at=now() WHERE id=$3 RETURNING *", [b.status, grace, before.id]);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.license.status_changed', resourceType: 'saas_subscription', resourceId: row.id, beforeState: before, afterState: row });
    const licenseSync = await pushLicenseSnapshot(db, config, a.organisationId, id);
    return { ...row, licenseSync };
  });

  app.put('/v1/commercial-control/schools/:id/modules', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({ moduleKey: z.string().min(3).max(120), enabled: z.boolean() }).parse(request.body);
    const sub = await maybeOne<any>(db, "SELECT * FROM saas_subscriptions WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 AND status IN('trial','active','grace','suspended') ORDER BY created_at DESC LIMIT 1", [a.organisationId, id]);
    if (!sub) throw notFound('Current subscription');
    const mod = await maybeOne<any>(db, 'SELECT id,module_key FROM saas_product_modules WHERE module_key=$1 AND product_id=$2', [b.moduleKey, sub.product_id]);
    if (!mod) throw notFound('Product module');
    await db.query('INSERT INTO saas_subscription_modules(subscription_id,module_id,enabled) VALUES($1,$2,$3) ON CONFLICT(subscription_id,module_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()', [sub.id, mod.id, b.enabled]);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.module.entitlement_changed', resourceType: 'saas_subscription', resourceId: sub.id, afterState: { moduleKey: b.moduleKey, enabled: b.enabled } });
    const entitlement = await getEntitlements(db, a.organisationId, id);
    const licenseSync = await pushLicenseSnapshot(db, config, a.organisationId, id);
    return { ...entitlement, licenseSync };
  });

  app.post('/v1/commercial-control/schools/:id/usage', async (request, reply) => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({ metricKey: z.enum(['students', 'staff', 'campuses', 'storageGb']), metricValue: z.coerce.number().min(0) }).parse(request.body);
    const product = await one<any>(db, "SELECT id FROM saas_products WHERE product_key='school'");
    const row = await one<any>(db, 'INSERT INTO saas_usage_snapshots(provider_organisation_id,customer_organisation_id,product_id,metric_key,metric_value) VALUES($1,$2,$3,$4,$5) RETURNING *', [a.organisationId, id, product.id, b.metricKey, b.metricValue]);
    return reply.code(201).send(row);
  });

  app.get('/v1/commercial-control/invoices', async request => {
    const a = requirePermission(request, 'commercial.read');
    return (await db.query('SELECT i.*,o.name customer_name FROM saas_invoices i JOIN organisations o ON o.id=i.customer_organisation_id WHERE i.provider_organisation_id=$1 ORDER BY i.created_at DESC LIMIT 200', [a.organisationId])).rows;
  });

  app.post('/v1/commercial-control/schools/:id/invoices', async (request, reply) => {
    const a = requirePermission(request, 'commercial.billing');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({ dueDays: z.coerce.number().int().min(1).max(180).default(14), notes: z.string().max(1000).optional() }).parse(request.body);
    const sub = await maybeOne<any>(db, 'SELECT s.*,pl.name plan_name FROM saas_subscriptions s LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id WHERE s.provider_organisation_id=$1 AND s.customer_organisation_id=$2 ORDER BY s.created_at DESC LIMIT 1', [a.organisationId, id]);
    if (!sub) throw notFound('Subscription');
    const seq = await db.query('SELECT count(*)::int n FROM saas_invoices WHERE provider_organisation_id=$1', [a.organisationId]);
    const invoiceNo = 'RX-' + String((seq.rows[0]?.n || 0) + 1).padStart(6, '0');
    const result = await transaction(db, async c => {
      const invoice = await one<any>(c, "INSERT INTO saas_invoices(provider_organisation_id,customer_organisation_id,subscription_id,invoice_no,status,currency,subtotal,total,issued_at,due_at,notes,created_by) VALUES($1,$2,$3,$4,'issued',$5,$6,$6,now(),now()+make_interval(days=>$7),$8,$9) RETURNING *", [a.organisationId, id, sub.id, invoiceNo, sub.currency, sub.recurring_amount, b.dueDays, b.notes ?? null, a.userId]);
      await c.query('INSERT INTO saas_invoice_lines(invoice_id,description,quantity,unit_price,amount) VALUES($1,$2,1,$3,$3)', [invoice.id, (sub.plan_name || 'School') + ' ' + sub.billing_frequency + ' subscription', sub.recurring_amount]);
      return invoice;
    });
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.invoice.issued', resourceType: 'saas_invoice', resourceId: result.id, afterState: result });
    return reply.code(201).send(result);
  });

  app.post('/v1/commercial-control/invoices/:id/payments', async (request, reply) => {
    const a = requirePermission(request, 'commercial.billing');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({ amount: z.coerce.number().positive(), paymentMethod: z.string().min(2).max(40).default('bank_transfer'), providerReference: z.string().max(160).optional() }).parse(request.body);
    const result = await transaction(db, async c => {
      const invoice = await one<any>(c, 'SELECT * FROM saas_invoices WHERE id=$1 AND provider_organisation_id=$2 FOR UPDATE', [id, a.organisationId]);
      if (invoice.status === 'void') throw conflict('Voided invoice cannot receive payment');
      const payment = await one<any>(c, 'INSERT INTO saas_subscription_payments(provider_organisation_id,customer_organisation_id,invoice_id,subscription_id,amount,currency,payment_method,provider_reference,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [a.organisationId, invoice.customer_organisation_id, id, invoice.subscription_id, b.amount, invoice.currency, b.paymentMethod, b.providerReference ?? null, a.userId]);
      const newPaid = Number(invoice.amount_paid) + b.amount;
      const paid = newPaid >= Number(invoice.total) - 0.005;
      const updated = await one<any>(c, 'UPDATE saas_invoices SET amount_paid=$1,status=$2,paid_at=CASE WHEN $3 THEN now() ELSE paid_at END,updated_at=now() WHERE id=$4 RETURNING *', [newPaid, paid ? 'paid' : 'part_paid', paid, id]);
      if (paid && invoice.subscription_id) {
        const sub = await one<any>(c, 'SELECT * FROM saas_subscriptions WHERE id=$1 FOR UPDATE', [invoice.subscription_id]);
        await c.query("UPDATE saas_subscriptions SET status='active',grace_ends_at=NULL,current_period_start=now(),current_period_end=$1,updated_at=now() WHERE id=$2", [nextPeriodEnd(sub.billing_frequency), sub.id]);
      }
      return { invoice: updated, payment };
    });
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.subscription_payment.recorded', resourceType: 'saas_invoice', resourceId: id, afterState: result });
    const licenseSync = result.invoice.status==='paid'
      ? await pushLicenseSnapshot(db, config, a.organisationId, result.invoice.customer_organisation_id)
      : null;
    return reply.code(201).send({ ...result, licenseSync });
  });

  app.get('/v1/internal/commercial/entitlements', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async request => {
    requireSchoolService(request, config);
    const q = z.object({ organisationId: z.string().uuid() }).parse(request.query);
    const provider = await maybeOne<any>(db, 'SELECT provider_organisation_id FROM saas_customers WHERE customer_organisation_id=$1 ORDER BY created_at LIMIT 1', [q.organisationId]);
    if (!provider) return { licensed: false, status: 'unlicensed', modules: [], limits: {} };
    return getEntitlements(db, provider.provider_organisation_id, q.organisationId);
  });
}
