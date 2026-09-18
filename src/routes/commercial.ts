import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { requirePermission } from '../core/http.js';
import { audit, emitEvent } from '../core/audit.js';
import { conflict, notFound } from '../core/errors.js';

export async function commercialRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/documents', async request => {
    const a = requirePermission(request, 'documents.read');
    return (await db.query(
      'SELECT id,name,category,mime_type,status,version,created_at,updated_at FROM documents WHERE organisation_id=$1 ORDER BY updated_at DESC',
      [a.organisationId]
    )).rows;
  });

  app.post('/v1/documents', async (request, reply) => {
    const a = requirePermission(request, 'documents.manage');
    const b = z.object({
      name: z.string().min(2).max(240),
      category: z.string().max(100).default('general'),
      content: z.string().max(1000000).default('')
    }).parse(request.body);
    const x = await one<any>(
      db,
      'INSERT INTO documents(organisation_id,name,category,content,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [a.organisationId, b.name, b.category, b.content, a.userId]
    );
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'document.created', resourceType: 'document', resourceId: x.id, afterState: x });
    return reply.code(201).send(x);
  });

  app.get('/v1/documents/:id', async request => {
    const a = requirePermission(request, 'documents.read');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await maybeOne<any>(db, 'SELECT * FROM documents WHERE id=$1 AND organisation_id=$2', [q.id, a.organisationId]);
    if (!row) throw notFound('Document');
    return row;
  });

  app.patch('/v1/documents/:id', async request => {
    const a = requirePermission(request, 'documents.manage');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().min(2).max(240).optional(),
      category: z.string().max(100).optional(),
      content: z.string().max(1000000).optional(),
      status: z.enum(['active', 'archived']).optional()
    }).refine(v => Object.keys(v).length > 0).parse(request.body);
    return transaction(db, async c => {
      const before = await one<any>(c, 'SELECT * FROM documents WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [q.id, a.organisationId]);
      const row = await one<any>(
        c,
        `UPDATE documents
         SET name=COALESCE($1,name),category=COALESCE($2,category),content=COALESCE($3,content),status=COALESCE($4,status),version=version+1,updated_at=now()
         WHERE id=$5 AND organisation_id=$6
         RETURNING *`,
        [b.name ?? null, b.category ?? null, b.content ?? null, b.status ?? null, q.id, a.organisationId]
      );
      await audit(c, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'document.updated', resourceType: 'document', resourceId: q.id, beforeState: before, afterState: row });
      return row;
    });
  });

  app.get('/v1/assets', async request => {
    const a = requirePermission(request, 'assets.read');
    return (await db.query('SELECT * FROM assets WHERE organisation_id=$1 ORDER BY created_at DESC', [a.organisationId])).rows;
  });

  app.post('/v1/assets', async (request, reply) => {
    const a = requirePermission(request, 'assets.manage');
    const b = z.object({
      code: z.string().min(1).max(80),
      name: z.string().min(2).max(200),
      assetType: z.string().min(2).max(100),
      location: z.string().max(240).optional()
    }).parse(request.body);
    try {
      const x = await one<any>(
        db,
        'INSERT INTO assets(organisation_id,code,name,asset_type,location) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [a.organisationId, b.code.toUpperCase(), b.name, b.assetType, b.location ?? null]
      );
      await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'asset.created', resourceType: 'asset', resourceId: x.id, afterState: x });
      return reply.code(201).send(x);
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Asset code is already in use');
      throw e;
    }
  });

  app.patch('/v1/assets/:id', async request => {
    const a = requirePermission(request, 'assets.manage');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().min(2).max(200).optional(),
      status: z.enum(['active', 'maintenance', 'retired', 'lost']).optional(),
      location: z.string().max(240).nullable().optional()
    }).refine(v => Object.keys(v).length > 0).parse(request.body);
    return transaction(db, async c => {
      const before = await one<any>(c, 'SELECT * FROM assets WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [q.id, a.organisationId]);
      const row = await one<any>(
        c,
        `UPDATE assets
         SET name=COALESCE($1,name),status=COALESCE($2,status),location=CASE WHEN $3 THEN $4 ELSE location END,updated_at=now()
         WHERE id=$5 AND organisation_id=$6
         RETURNING *`,
        [b.name ?? null, b.status ?? null, Object.hasOwn(b, 'location'), b.location ?? null, q.id, a.organisationId]
      );
      await audit(c, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'asset.updated', resourceType: 'asset', resourceId: q.id, beforeState: before, afterState: row });
      return row;
    });
  });

  app.get('/v1/automations', async request => {
    const a = requirePermission(request, 'automation.read');
    return (await db.query('SELECT * FROM automations WHERE organisation_id=$1 ORDER BY created_at DESC', [a.organisationId])).rows;
  });

  app.post('/v1/automations', async (request, reply) => {
    const a = requirePermission(request, 'automation.manage');
    const b = z.object({
      name: z.string().min(2).max(200),
      triggerEvent: z.string().min(2).max(160),
      actionType: z.enum(['create_operation', 'emit_event']),
      actionConfig: z.record(z.string(), z.unknown()).default({})
    }).parse(request.body);
    const x = await one<any>(
      db,
      'INSERT INTO automations(organisation_id,name,trigger_event,action_type,action_config,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [a.organisationId, b.name, b.triggerEvent, b.actionType, JSON.stringify(b.actionConfig), a.userId]
    );
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'automation.created', resourceType: 'automation', resourceId: x.id, afterState: x });
    return reply.code(201).send(x);
  });

  app.patch('/v1/automations/:id', async request => {
    const a = requirePermission(request, 'automation.manage');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().min(2).max(200).optional(),
      isActive: z.boolean().optional()
    }).refine(v => Object.keys(v).length > 0).parse(request.body);
    return transaction(db, async c => {
      const before = await one<any>(c, 'SELECT * FROM automations WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [q.id, a.organisationId]);
      const row = await one<any>(
        c,
        'UPDATE automations SET name=COALESCE($1,name),is_active=COALESCE($2,is_active),updated_at=now() WHERE id=$3 AND organisation_id=$4 RETURNING *',
        [b.name ?? null, b.isActive ?? null, q.id, a.organisationId]
      );
      await audit(c, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'automation.updated', resourceType: 'automation', resourceId: q.id, beforeState: before, afterState: row });
      return row;
    });
  });

  app.post('/v1/automations/:id/run', async request => {
    const a = requirePermission(request, 'automation.manage');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    return transaction(db, async c => {
      const x = await one<any>(c, 'SELECT * FROM automations WHERE id=$1 AND organisation_id=$2 AND is_active=true', [q.id, a.organisationId]);
      if (x.action_type === 'create_operation') {
        const title = String(x.action_config?.title || `Automation: ${x.name}`);
        await c.query(
          `INSERT INTO operation_items(organisation_id,title,priority,metadata,created_by,source_module,external_ref)
           VALUES($1,$2,'normal',$3,$4,'automation',$5)
           ON CONFLICT DO NOTHING`,
          [a.organisationId, title, JSON.stringify({ automationId: x.id }), a.userId, `${x.id}-${Date.now()}`]
        );
      } else {
        await emitEvent(c, a.organisationId, x.trigger_event, 'automation', x.id, x.action_config || {});
      }
      const row = await one<any>(c, 'UPDATE automations SET run_count=run_count+1,last_run_at=now() WHERE id=$1 RETURNING *', [x.id]);
      await audit(c, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'automation.ran', resourceType: 'automation', resourceId: x.id, afterState: row });
      return row;
    });
  });

  app.get('/v1/analytics/summary', async request => {
    const a = requirePermission(request, 'analytics.read');
    const q = await db.query(
      `SELECT
        (SELECT count(*) FROM organisation_memberships WHERE organisation_id=$1) users,
        (SELECT count(*) FROM operation_items WHERE organisation_id=$1) operations,
        (SELECT count(*) FROM operation_items WHERE organisation_id=$1 AND status='completed') completed_operations,
        (SELECT count(*) FROM documents WHERE organisation_id=$1) documents,
        (SELECT count(*) FROM assets WHERE organisation_id=$1) assets,
        (SELECT count(*) FROM workflow_instances WHERE organisation_id=$1) workflow_runs,
        (SELECT count(*) FROM integrations WHERE organisation_id=$1 AND status='active') active_integrations,
        (SELECT count(*) FROM automations WHERE organisation_id=$1 AND is_active=true) active_automations,
        (SELECT count(*) FROM notifications WHERE organisation_id=$1 AND is_read=false) unread_notifications`,
      [a.organisationId]
    );
    return q.rows[0];
  });

  app.get('/v1/analytics/activity', async request => {
    const a = requirePermission(request, 'analytics.read');
    const [ops, assets, workflows, audits] = await Promise.all([
      db.query('SELECT status,count(*)::int count FROM operation_items WHERE organisation_id=$1 GROUP BY status ORDER BY status', [a.organisationId]),
      db.query('SELECT status,count(*)::int count FROM assets WHERE organisation_id=$1 GROUP BY status ORDER BY status', [a.organisationId]),
      db.query('SELECT status,count(*)::int count FROM workflow_instances WHERE organisation_id=$1 GROUP BY status ORDER BY status', [a.organisationId]),
      db.query(`SELECT date_trunc('day',created_at)::date day,count(*)::int count FROM audit_logs WHERE organisation_id=$1 AND created_at>=now()-interval '14 days' GROUP BY 1 ORDER BY 1`, [a.organisationId])
    ]);
    return { operationsByStatus: ops.rows, assetsByStatus: assets.rows, workflowsByStatus: workflows.rows, auditByDay: audits.rows };
  });

  app.get('/v1/integrations', async request => {
    const a = requirePermission(request, 'integrations.read');
    return (await db.query('SELECT id,name,integration_type,endpoint_url,status,config,created_at,updated_at FROM integrations WHERE organisation_id=$1 ORDER BY created_at DESC', [a.organisationId])).rows;
  });

  app.post('/v1/integrations', async (request, reply) => {
    const a = requirePermission(request, 'integrations.manage');
    const b = z.object({
      name: z.string().min(2).max(160),
      integrationType: z.string().min(2).max(80),
      endpointUrl: z.string().url().optional()
    }).parse(request.body);
    const row = await one<any>(
      db,
      'INSERT INTO integrations(organisation_id,name,integration_type,endpoint_url,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [a.organisationId, b.name, b.integrationType, b.endpointUrl ?? null, a.userId]
    );
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'integration.created', resourceType: 'integration', resourceId: row.id, afterState: row });
    return reply.code(201).send(row);
  });

  app.patch('/v1/integrations/:id', async request => {
    const a = requirePermission(request, 'integrations.manage');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z.object({
      name: z.string().min(2).max(160).optional(),
      endpointUrl: z.string().url().nullable().optional(),
      status: z.enum(['active', 'disabled']).optional()
    }).refine(v => Object.keys(v).length > 0).parse(request.body);
    return transaction(db, async c => {
      const before = await one<any>(c, 'SELECT * FROM integrations WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [q.id, a.organisationId]);
      const row = await one<any>(
        c,
        `UPDATE integrations
         SET name=COALESCE($1,name),endpoint_url=CASE WHEN $2 THEN $3 ELSE endpoint_url END,status=COALESCE($4,status),updated_at=now()
         WHERE id=$5 AND organisation_id=$6
         RETURNING *`,
        [b.name ?? null, Object.hasOwn(b, 'endpointUrl'), b.endpointUrl ?? null, b.status ?? null, q.id, a.organisationId]
      );
      await audit(c, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'integration.updated', resourceType: 'integration', resourceId: q.id, beforeState: before, afterState: row });
      return row;
    });
  });

  app.post('/v1/integrations/:id/test', async request => {
    const a = requirePermission(request, 'integrations.manage');
    const q = z.object({ id: z.string().uuid() }).parse(request.params);
    const x = await one<any>(db, 'SELECT * FROM integrations WHERE id=$1 AND organisation_id=$2', [q.id, a.organisationId]);
    if (!x.endpoint_url) return { ok: true, message: 'Integration configuration is stored and active; no endpoint configured.' };
    try {
      const res = await fetch(x.endpoint_url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, message: 'Endpoint could not be reached' };
    }
  });

  app.get('/v1/developer/clients', async request => {
    const a = requirePermission(request, 'developer.read');
    return (await db.query('SELECT id,name,client_id,permissions,is_active,created_at,last_used_at FROM module_clients WHERE organisation_id=$1 ORDER BY created_at DESC', [a.organisationId])).rows;
  });

  app.get('/v1/notifications', async request => {
    const a = requirePermission(request, 'notifications.read');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    return (await db.query(
      `SELECT n.id,n.title,n.body,n.is_read,n.created_at,n.user_id,u.first_name,u.last_name
       FROM notifications n
       LEFT JOIN users u ON u.id=n.user_id
       WHERE n.organisation_id=$1 AND (n.user_id IS NULL OR n.user_id=$2)
       ORDER BY n.created_at DESC
       LIMIT $3`,
      [a.organisationId, a.userId, q.limit]
    )).rows;
  });

  app.post('/v1/notifications', async (request, reply) => {
    const a = requirePermission(request, 'notifications.manage');
    const b = z.object({
      title: z.string().min(2).max(200),
      body: z.string().min(1).max(5000),
      userId: z.string().uuid().nullable().optional()
    }).parse(request.body);
    if (b.userId) {
      const member = await maybeOne(db, 'SELECT 1 FROM organisation_memberships WHERE organisation_id=$1 AND user_id=$2', [a.organisationId, b.userId]);
      if (!member) throw notFound('Organisation user');
    }
    const row = await one<any>(
      db,
      'INSERT INTO notifications(organisation_id,user_id,title,body) VALUES($1,$2,$3,$4) RETURNING *',
      [a.organisationId, b.userId ?? null, b.title, b.body]
    );
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'notification.created', resourceType: 'notification', resourceId: row.id, afterState: row });
    return reply.code(201).send(row);
  });

  app.patch('/v1/notifications/:id/read', async request => {
    const a = requirePermission(request, 'notifications.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await maybeOne<any>(
      db,
      `UPDATE notifications SET is_read=true
       WHERE id=$1 AND organisation_id=$2 AND (user_id IS NULL OR user_id=$3)
       RETURNING *`,
      [id, a.organisationId, a.userId]
    );
    if (!row) throw notFound('Notification');
    return row;
  });

  app.post('/v1/notifications/read-all', async request => {
    const a = requirePermission(request, 'notifications.read');
    const r = await db.query(
      `UPDATE notifications SET is_read=true
       WHERE organisation_id=$1 AND (user_id IS NULL OR user_id=$2) AND is_read=false`,
      [a.organisationId, a.userId]
    );
    return { updated: r.rowCount ?? 0 };
  });

  app.get('/v1/security/overview', async request => {
    const a = requirePermission(request, 'security.read');
    const [s, l] = await Promise.all([
      db.query('SELECT count(*) active_sessions FROM sessions WHERE organisation_id=$1 AND revoked_at IS NULL AND expires_at>now()', [a.organisationId]),
      db.query('SELECT id,action,resource_type,outcome,created_at FROM audit_logs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 20', [a.organisationId])
    ]);
    return { activeSessions: s.rows[0]?.active_sessions ?? 0, recentAudit: l.rows };
  });

  app.get('/v1/security/sessions', async request => {
    const a = requirePermission(request, 'security.read');
    return (await db.query(
      `SELECT s.id,s.user_id,s.ip_address,s.user_agent,s.created_at,s.last_used_at,s.expires_at,s.revoked_at,
              u.first_name,u.last_name,u.email,
              (s.id=$2::uuid) current
       FROM sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.organisation_id=$1
       ORDER BY s.created_at DESC
       LIMIT 100`,
      [a.organisationId, a.sessionId]
    )).rows;
  });

  app.post('/v1/security/sessions/:id/revoke', async request => {
    const a = requirePermission(request, 'security.manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (id === a.sessionId) throw conflict('Use sign out to end the current session');
    const row = await maybeOne<any>(
      db,
      `UPDATE sessions SET revoked_at=now()
       WHERE id=$1 AND organisation_id=$2 AND revoked_at IS NULL
       RETURNING id,user_id,revoked_at`,
      [id, a.organisationId]
    );
    if (!row) throw notFound('Active session');
    await audit(db, { organisationId: a.organisationId, actorUserId: a.userId, sessionId: a.sessionId, action: 'session.revoked', resourceType: 'session', resourceId: id, afterState: row });
    return row;
  });

  app.get('/v1/data-hub/summary', async request => {
    const a = requirePermission(request, 'data.read');
    const q = await db.query(
      `SELECT
        (SELECT count(*) FROM outbox_events WHERE organisation_id=$1) total_events,
        (SELECT count(*) FROM outbox_events WHERE organisation_id=$1 AND published_at IS NULL) pending_events,
        (SELECT count(*) FROM audit_logs WHERE organisation_id=$1) audit_records,
        (SELECT count(*) FROM operation_items WHERE organisation_id=$1) operational_records`,
      [a.organisationId]
    );
    return q.rows[0];
  });

  app.get('/v1/data-hub/events', async request => {
    const a = requirePermission(request, 'data.read');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    return (await db.query(
      `SELECT id,topic,aggregate_type,aggregate_id,payload,created_at,published_at,attempts,last_error
       FROM outbox_events
       WHERE organisation_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [a.organisationId, q.limit]
    )).rows;
  });

  app.get('/v1/search', async request => {
    const a = requirePermission(request, 'organisation.read');
    const q = z.object({ q: z.string().min(2).max(100) }).parse(request.query);
    const s = `%${q.q}%`;
    const [d, x, o, u] = await Promise.all([
      db.query(`SELECT id,name,'document' type FROM documents WHERE organisation_id=$1 AND name ILIKE $2 LIMIT 10`, [a.organisationId, s]),
      db.query(`SELECT id,name,'asset' type FROM assets WHERE organisation_id=$1 AND (name ILIKE $2 OR code ILIKE $2) LIMIT 10`, [a.organisationId, s]),
      db.query(`SELECT id,title name,'operation' type FROM operation_items WHERE organisation_id=$1 AND title ILIKE $2 LIMIT 10`, [a.organisationId, s]),
      db.query(`SELECT u.id,(u.first_name||' '||u.last_name) name,'user' type FROM users u JOIN organisation_memberships m ON m.user_id=u.id WHERE m.organisation_id=$1 AND (u.first_name||' '||u.last_name||' '||u.email) ILIKE $2 LIMIT 10`, [a.organisationId, s])
    ]);
    return [...d.rows, ...x.rows, ...o.rows, ...u.rows];
  });
}
