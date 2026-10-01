import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { audit } from '../core/audit.js';
import { AppError, notFound } from '../core/errors.js';
import { requirePermission } from '../core/http.js';

function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function schoolBase(config: Config) {
  const value = String(config.SCHOOL_APP_URL || '').replace(/\/$/, '');
  if (!value) throw new AppError(503, 'SCHOOL_APP_NOT_CONFIGURED', 'Revolt-X School application URL is not configured.');
  return value;
}

function schoolHeaders(config: Config) {
  if (!config.SCHOOL_SERVICE_KEY) throw new AppError(503, 'SCHOOL_SERVICE_NOT_CONFIGURED', 'School service authentication is not configured.');
  return { 'content-type': 'application/json', 'x-revolt-service-key': config.SCHOOL_SERVICE_KEY };
}

function nextPeriodEnd(frequency: string) {
  const d = new Date();
  if (frequency === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (frequency === 'termly') d.setUTCMonth(d.getUTCMonth() + 4);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

async function safeRows(db: Db, sql: string, params: unknown[] = []) {
  try {
    return (await db.query(sql, params)).rows;
  } catch {
    return [] as any[];
  }
}

async function entitlementSnapshot(db: Db, providerId: string, customerId: string) {
  const sub = await maybeOne<any>(db, `
    SELECT s.*,p.product_key,p.name product_name,pl.plan_key,pl.name plan_name
    FROM saas_subscriptions s
    JOIN saas_products p ON p.id=s.product_id
    LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id
    WHERE s.provider_organisation_id=$1 AND s.customer_organisation_id=$2
    ORDER BY s.created_at DESC LIMIT 1
  `, [providerId, customerId]);

  if (!sub) return { licensed: false, status: 'unlicensed', modules: [], limits: {} };

  const modules = (await db.query(`
    SELECT pm.module_key,COALESCE(sm.enabled,COALESCE(pl.included,false)) enabled
    FROM saas_product_modules pm
    LEFT JOIN saas_plan_modules pl ON pl.module_id=pm.id AND pl.plan_id=$1
    LEFT JOIN saas_subscription_modules sm ON sm.module_id=pm.id AND sm.subscription_id=$2
    WHERE pm.product_id=$3 AND pm.is_active=true
    ORDER BY pm.sort_order,pm.name
  `, [sub.plan_id, sub.id, sub.product_id])).rows;

  let effectiveStatus = String(sub.status || 'unlicensed');
  const now = Date.now();
  const isExpired =
    (effectiveStatus === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() <= now) ||
    (effectiveStatus === 'active' && sub.current_period_end && new Date(sub.current_period_end).getTime() <= now) ||
    (effectiveStatus === 'grace' && sub.grace_ends_at && new Date(sub.grace_ends_at).getTime() <= now);

  if (isExpired) {
    effectiveStatus = 'expired';
    await db.query("UPDATE saas_subscriptions SET status='expired',updated_at=now() WHERE id=$1 AND status<>'expired'", [sub.id]).catch(() => null);
  }

  return {
    licensed: !['expired', 'cancelled', 'suspended', 'unlicensed'].includes(effectiveStatus),
    status: effectiveStatus,
    subscriptionId: sub.id,
    licenseCode: sub.license_code,
    product: sub.product_key,
    productName: sub.product_name,
    plan: sub.plan_key,
    planName: sub.plan_name,
    billingFrequency: sub.billing_frequency,
    recurringAmount: Number(sub.recurring_amount || 0),
    currency: sub.currency,
    periodEnd: sub.current_period_end,
    trialEndsAt: sub.trial_ends_at,
    graceEndsAt: sub.grace_ends_at,
    limits: sub.limits || {},
    modules: modules.filter((m: any) => m.enabled).map((m: any) => m.module_key)
  };
}

async function syncLicense(db: Db, config: Config, providerId: string, customerId: string) {
  const entitlement = await entitlementSnapshot(db, providerId, customerId);
  const response = await fetch(schoolBase(config) + '/api/internal/license-sync', {
    method: 'POST',
    headers: schoolHeaders(config),
    body: JSON.stringify({ organisationId: customerId, entitlement }),
    signal: AbortSignal.timeout(20000)
  }).catch(() => null);

  if (!response) return { ok: false, entitlement, message: 'Revolt-X School could not be reached. The OS licence was saved and can be synced again.' };
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) return { ok: false, entitlement, status: response.status, message: payload?.error?.message || 'School licence sync failed.' };

  if ((entitlement as any).subscriptionId) {
    await db.query('UPDATE saas_subscriptions SET last_synced_at=now(),updated_at=now() WHERE id=$1', [(entitlement as any).subscriptionId]).catch(() => null);
  }
  return { ok: true, entitlement, school: payload };
}

async function primarySchoolAdmin(db: Db, organisationId: string) {
  const org = await one<any>(db, 'SELECT id,name,slug,settings FROM organisations WHERE id=$1', [organisationId]);
  const configuredId = org.settings?.primaryAdminUserId;
  if (configuredId) {
    const user = await maybeOne<any>(db, 'SELECT id,email,first_name,last_name,status FROM users WHERE id=$1', [configuredId]);
    if (user) return { org, user };
  }

  const user = await maybeOne<any>(db, `
    SELECT u.id,u.email,u.first_name,u.last_name,u.status
    FROM organisation_memberships m
    JOIN users u ON u.id=m.user_id
    LEFT JOIN membership_roles mr ON mr.membership_id=m.id
    LEFT JOIN roles r ON r.id=mr.role_id
    WHERE m.organisation_id=$1 AND m.status='active'
    ORDER BY CASE WHEN r.key='owner' THEN 0 WHEN r.key='admin' THEN 1 ELSE 2 END, m.created_at
    LIMIT 1
  `, [organisationId]);
  if (!user) throw notFound('School administrator');
  return { org, user };
}

export async function commercialSupportRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.get('/v1/commercial-control/support/database-tables', async request => {
    const a = requirePermission(request, 'commercial.read');
    const keyTables = [
      'organisations','users','organisation_memberships','roles','permissions','sessions','audit_logs','outbox_events',
      'saas_customers','saas_subscriptions','saas_pricing_plans','saas_product_modules','saas_invoices',
      'saas_invoice_lines','saas_subscription_payments','saas_provisioning_jobs','saas_report_requests','saas_backup_jobs'
    ];
    const rows = await safeRows(db, `
      SELECT n.nspname schema_name,c.relname table_name,COALESCE(s.n_live_tup,0)::bigint estimated_rows,
        pg_total_relation_size(c.oid)::bigint size_bytes,
        obj_description(c.oid,'pg_class') description
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
      WHERE c.relkind='r' AND n.nspname IN('revolt_x_os','public')
      ORDER BY CASE WHEN c.relname=ANY($1::text[]) THEN 0 ELSE 1 END,c.relname
      LIMIT 80
    `, [keyTables]);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.database_tables.viewed', resourceType: 'database_table', source: 'commercial_support' }).catch(() => null);
    return {
      generatedAt: new Date().toISOString(),
      keyTables,
      tables: rows.map((r: any) => ({
        schema: r.schema_name,
        name: r.table_name,
        isKeyTable: keyTables.includes(r.table_name),
        estimatedRows: Number(r.estimated_rows || 0),
        sizeBytes: Number(r.size_bytes || 0),
        description: r.description || null
      }))
    };
  });

  app.get('/v1/commercial-control/support/data-hub', async request => {
    requirePermission(request, 'commercial.read');
    const outbox = await safeRows(db, `
      SELECT id,topic,aggregate_type,aggregate_id,created_at,processed_at,error
      FROM outbox_events ORDER BY created_at DESC LIMIT 60
    `);
    const provisioning = await safeRows(db, `
      SELECT id,customer_organisation_id,action,status,error,created_at,completed_at,details
      FROM saas_provisioning_jobs
      WHERE status IN('queued','running','pending','failed')
      ORDER BY created_at DESC LIMIT 60
    `);
    return {
      generatedAt: new Date().toISOString(),
      pendingOutboxEvents: outbox.filter((x: any) => !x.processed_at),
      recentOutboxEvents: outbox,
      provisioningAttention: provisioning
    };
  });

  app.get('/v1/commercial-control/support/invoices-by-organisation', async request => {
    const a = requirePermission(request, 'commercial.read');
    const groups = await safeRows(db, `
      SELECT o.id organisation_id,o.name organisation_name,o.slug,
        count(i.id)::int invoice_count,
        COALESCE(sum(i.total),0)::numeric total,
        COALESCE(sum(i.amount_paid),0)::numeric amount_paid,
        COALESCE(sum(i.total-i.amount_paid),0)::numeric outstanding,
        COALESCE(sum(i.total-i.amount_paid) FILTER(WHERE i.status IN('issued','part_paid','overdue')),0)::numeric open_balance,
        max(i.created_at) latest_invoice_at
      FROM saas_customers c
      JOIN organisations o ON o.id=c.customer_organisation_id
      LEFT JOIN saas_invoices i ON i.provider_organisation_id=c.provider_organisation_id AND i.customer_organisation_id=c.customer_organisation_id
      WHERE c.provider_organisation_id=$1
      GROUP BY o.id,o.name,o.slug
      ORDER BY o.name
    `, [a.organisationId]);

    const invoices = await safeRows(db, `
      SELECT i.*,o.name customer_name,o.slug customer_slug
      FROM saas_invoices i JOIN organisations o ON o.id=i.customer_organisation_id
      WHERE i.provider_organisation_id=$1
      ORDER BY o.name,i.created_at DESC
      LIMIT 500
    `, [a.organisationId]);

    return groups.map((g: any) => ({
      ...g,
      invoices: invoices.filter((i: any) => i.customer_organisation_id === g.organisation_id)
    }));
  });

  app.post('/v1/commercial-control/support/schools/:id/license-action', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      action: z.enum(['activate','restore','grace','suspend','expire','cancel']),
      graceDays: z.coerce.number().int().min(1).max(90).optional()
    }).parse(request.body ?? {});

    if (!await maybeOne(db, 'SELECT 1 FROM saas_customers WHERE provider_organisation_id=$1 AND customer_organisation_id=$2', [a.organisationId, id])) throw notFound('School customer');
    const before = await maybeOne<any>(db, 'SELECT * FROM saas_subscriptions WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC LIMIT 1', [a.organisationId, id]);
    if (!before) throw notFound('Subscription');

    const now = Date.now();
    const status = body.action === 'activate' || body.action === 'restore' ? 'active'
      : body.action === 'grace' ? 'grace'
      : body.action === 'suspend' ? 'suspended'
      : body.action === 'expire' ? 'expired'
      : 'cancelled';

    let periodEnd = before.current_period_end;
    let trialEndsAt = before.trial_ends_at;
    let graceEndsAt: string | null = null;

    if (status === 'active') {
      if (!periodEnd || new Date(periodEnd).getTime() <= now) periodEnd = nextPeriodEnd(before.billing_frequency);
      trialEndsAt = null;
    } else if (status === 'grace') {
      graceEndsAt = new Date(now + (body.graceDays || 14) * 86400000).toISOString();
    } else if (status === 'expired') {
      periodEnd = new Date(now).toISOString();
      trialEndsAt = null;
    }

    const row = await one<any>(db, `
      UPDATE saas_subscriptions SET
        status=$1,current_period_end=$2,trial_ends_at=$3,grace_ends_at=$4,
        cancelled_at=CASE WHEN $1='cancelled' THEN now() ELSE NULL END,
        updated_at=now()
      WHERE id=$5 RETURNING *
    `, [status, periodEnd, trialEndsAt, graceEndsAt, before.id]);

    const licenseSync = await syncLicense(db, config, a.organisationId, id);
    await audit(db, {
      organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId,
      action: 'commercial.license.action_applied', resourceType: 'saas_subscription', resourceId: row.id,
      beforeState: before, afterState: { ...row, licenseSync }, metadata: { customerOrganisationId: id, action: body.action },
      source: 'commercial_support'
    });
    return { subscription: row, licenseSync };
  });

  app.post('/v1/commercial-control/support/schools/:id/admin-password-reset', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await maybeOne(db, 'SELECT 1 FROM saas_customers WHERE provider_organisation_id=$1 AND customer_organisation_id=$2', [a.organisationId, id])) throw notFound('School customer');

    const { org, user } = await primarySchoolAdmin(db, id);
    if (user.status !== 'active') throw new AppError(409, 'INACTIVE_USER', 'The school administrator account is not active.');
    const setupToken = randomBytes(32).toString('base64url');

    await transaction(db, async c => {
      await c.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
      await c.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')", [user.id, tokenHash(setupToken)]);
    });

    const setupUrl = schoolBase(config) + '/login?school=' + encodeURIComponent(org.slug) + '&setup=' + encodeURIComponent(setupToken);
    await audit(db, {
      organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId,
      action: 'commercial.school_admin_password_reset.created', resourceType: 'user', resourceId: user.id,
      metadata: { customerOrganisationId: id, email: user.email }, source: 'commercial_support'
    });
    return {
      ok: true,
      school: { id: org.id, name: org.name, slug: org.slug },
      administrator: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name },
      setupUrl,
      expiresInHours: 24,
      instruction: 'Send this link to the school administrator. They must use the administrator email and the new password they create from this link.'
    };
  });

  app.patch('/v1/commercial-control/support/plans/:id/details', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      monthlyPrice: z.coerce.number().min(0).optional(),
      termlyPrice: z.coerce.number().min(0).optional(),
      annualPrice: z.coerce.number().min(0).optional(),
      studentLimit: z.coerce.number().int().positive().nullable().optional(),
      staffLimit: z.coerce.number().int().positive().nullable().optional(),
      campusLimit: z.coerce.number().int().positive().nullable().optional(),
      storageGb: z.coerce.number().min(0).nullable().optional(),
      isActive: z.boolean().optional()
    }).parse(request.body ?? {});
    const before = await one<any>(db, 'SELECT * FROM saas_pricing_plans WHERE id=$1', [id]);
    const row = await one<any>(db, `
      UPDATE saas_pricing_plans SET
        name=COALESCE($1,name),
        description=CASE WHEN $2 THEN $3 ELSE description END,
        monthly_price=COALESCE($4,monthly_price),
        termly_price=COALESCE($5,termly_price),
        annual_price=COALESCE($6,annual_price),
        student_limit=CASE WHEN $7 THEN $8 ELSE student_limit END,
        staff_limit=CASE WHEN $9 THEN $10 ELSE staff_limit END,
        campus_limit=CASE WHEN $11 THEN $12 ELSE campus_limit END,
        storage_gb=CASE WHEN $13 THEN $14 ELSE storage_gb END,
        is_active=COALESCE($15,is_active),
        updated_at=now()
      WHERE id=$16 RETURNING *
    `, [
      b.name ?? null, Object.hasOwn(b, 'description'), b.description ?? null,
      b.monthlyPrice ?? null, b.termlyPrice ?? null, b.annualPrice ?? null,
      Object.hasOwn(b, 'studentLimit'), b.studentLimit ?? null,
      Object.hasOwn(b, 'staffLimit'), b.staffLimit ?? null,
      Object.hasOwn(b, 'campusLimit'), b.campusLimit ?? null,
      Object.hasOwn(b, 'storageGb'), b.storageGb ?? null,
      b.isActive ?? null, id
    ]);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.plan.details_updated', resourceType: 'saas_plan', resourceId: id, beforeState: before, afterState: row, source: 'commercial_support' });
    return row;
  });

  app.patch('/v1/commercial-control/support/modules/:id', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      baseMonthlyPrice: z.coerce.number().min(0).optional(),
      sortOrder: z.coerce.number().int().min(0).optional(),
      isActive: z.boolean().optional()
    }).parse(request.body ?? {});
    const before = await one<any>(db, 'SELECT * FROM saas_product_modules WHERE id=$1', [id]);
    const row = await one<any>(db, `
      UPDATE saas_product_modules SET
        name=COALESCE($1,name),
        description=CASE WHEN $2 THEN $3 ELSE description END,
        base_monthly_price=COALESCE($4,base_monthly_price),
        sort_order=COALESCE($5,sort_order),
        is_active=COALESCE($6,is_active),
        updated_at=now()
      WHERE id=$7 RETURNING *
    `, [b.name ?? null, Object.hasOwn(b, 'description'), b.description ?? null, b.baseMonthlyPrice ?? null, b.sortOrder ?? null, b.isActive ?? null, id]);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.module.updated', resourceType: 'saas_product_module', resourceId: id, beforeState: before, afterState: row, source: 'commercial_support' });
    return row;
  });

  app.put('/v1/commercial-control/support/plans/:planId/modules/:moduleId', async request => {
    const a = requirePermission(request, 'commercial.manage');
    const params = z.object({ planId: z.string().uuid(), moduleId: z.string().uuid() }).parse(request.params);
    const b = z.object({ included: z.boolean() }).parse(request.body ?? {});
    const plan = await one<any>(db, 'SELECT * FROM saas_pricing_plans WHERE id=$1', [params.planId]);
    const mod = await one<any>(db, 'SELECT * FROM saas_product_modules WHERE id=$1 AND product_id=$2', [params.moduleId, plan.product_id]);
    await db.query(`
      INSERT INTO saas_plan_modules(plan_id,module_id,included)
      VALUES($1,$2,$3)
      ON CONFLICT(plan_id,module_id) DO UPDATE SET included=EXCLUDED.included,updated_at=now()
    `, [params.planId, params.moduleId, b.included]);
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'commercial.plan_module.updated', resourceType: 'saas_plan_module', resourceId: params.planId + ':' + params.moduleId, afterState: { planKey: plan.plan_key, moduleKey: mod.module_key, included: b.included }, source: 'commercial_support' });
    return { ok: true, planId: params.planId, moduleId: params.moduleId, included: b.included };
  });

  app.get('/v1/commercial-control/support/application-integration', async request => {
    requirePermission(request, 'commercial.read');
    const products = await safeRows(db, 'SELECT product_key,name FROM saas_products ORDER BY name');
    const modules = await safeRows(db, 'SELECT module_key,name,is_active FROM saas_product_modules ORDER BY sort_order,name LIMIT 200');
    return {
      title: 'How applications leverage Revolt-X OS',
      sourceOfTruth: [
        'Revolt-X OS owns organisations, users, roles, permissions, sessions, audit logs, licences, plans and module entitlements.',
        'Each application stores its operational records but references the same organisation ID and OS user ID.',
        'The OS pushes licence and module changes to the application through service-to-service sync.',
        'The application sends operational summaries back to OS for high-level reports, billing review and assurance.'
      ],
      integrationContract: {
        requiredTenantFields: ['organisationId','tenantSlug','applicationKey','primaryAdminUserId'],
        requiredIdentityFields: ['osUserId','email','firstName','lastName','roles','membershipStatus'],
        requiredLicenceFields: ['status','plan','modules','limits','periodEnd','graceEndsAt'],
        standardEndpoints: [
          'POST /api/internal/provision',
          'POST /api/internal/license-sync',
          'GET /api/internal/tenants',
          'GET /api/internal/report-summary',
          'GET /api/internal/backup-snapshot'
        ]
      },
      buildPattern: [
        'Create a product in OS.',
        'Define application modules.',
        'Create pricing plans and attach modules.',
        'Provision the customer organisation from OS.',
        'The application receives organisationId, admin user, licence and module entitlements.',
        'All future app access checks the OS licence state and the application role profile.'
      ],
      currentProducts: products,
      currentModules: modules
    };
  });
}
