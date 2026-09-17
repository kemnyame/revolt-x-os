import type { PoolClient } from 'pg';
import type { Db } from '../db/index.js';

export interface AuditEvent {
  organisationId?: string | null; actorUserId?: string | null; sessionId?: string | null;
  action: string; resourceType: string; resourceId?: string | null; outcome?: 'success' | 'failure';
  ipAddress?: string | undefined; userAgent?: string | undefined; beforeState?: unknown; afterState?: unknown; metadata?: Record<string, unknown>;
}

export async function audit(db: Db | PoolClient, event: AuditEvent): Promise<void> {
  await db.query(`INSERT INTO audit_logs
    (organisation_id, actor_user_id, session_id, action, resource_type, resource_id, outcome, ip_address, user_agent, before_state, after_state, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
    event.organisationId ?? null, event.actorUserId ?? null, event.sessionId ?? null, event.action,
    event.resourceType, event.resourceId ?? null, event.outcome ?? 'success', event.ipAddress ?? null,
    event.userAgent ?? null, event.beforeState ? JSON.stringify(event.beforeState) : null,
    event.afterState ? JSON.stringify(event.afterState) : null, JSON.stringify(event.metadata ?? {})
  ]);
}

export async function emitEvent(db: Db | PoolClient, organisationId: string, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await db.query('INSERT INTO outbox_events (organisation_id, topic, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4,$5)',
    [organisationId, topic, aggregateType, aggregateId, JSON.stringify(payload)]);
}
