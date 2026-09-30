import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from '../db/index.js';

export interface AuditEvent {
  organisationId?: string | null; actorUserId?: string | null; sessionId?: string | null;
  action: string; resourceType: string; resourceId?: string | null; outcome?: 'success' | 'failure';
  ipAddress?: string | undefined; userAgent?: string | undefined; beforeState?: unknown; afterState?: unknown; metadata?: Record<string, unknown>;
  severity?: 'info' | 'warning' | 'critical'; source?: string;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const obj=value as Record<string,unknown>;
    return '{' + Object.keys(obj).sort().map(k=>JSON.stringify(k)+':'+canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function audit(db: Db | PoolClient, event: AuditEvent): Promise<void> {
  const organisationId=event.organisationId ?? null;
  const outcome=event.outcome ?? 'success';
  const severity=event.severity ?? (outcome==='failure'?'warning':'info');
  const source=event.source ?? 'core_os';
  const previous=organisationId
    ? (await db.query('SELECT event_hash FROM audit_logs WHERE organisation_id=$1 AND event_hash IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',[organisationId])).rows[0]?.event_hash ?? null
    : null;
  const createdAt=new Date().toISOString();
  const beforeState=event.beforeState ?? null,afterState=event.afterState ?? null,metadata=event.metadata ?? {};
  const hashPayload=[
    previous ?? '',organisationId ?? '',event.actorUserId ?? '',event.sessionId ?? '',event.action,event.resourceType,
    event.resourceId ?? '',outcome,severity,source,event.ipAddress ?? '',event.userAgent ?? '',
    canonical(beforeState),canonical(afterState),canonical(metadata),createdAt
  ].join('|');
  const eventHash=createHash('sha256').update(hashPayload).digest('hex');

  await db.query(`INSERT INTO audit_logs
    (organisation_id, actor_user_id, session_id, action, resource_type, resource_id, outcome, ip_address, user_agent,
     before_state, after_state, metadata, severity, source, previous_event_hash, event_hash, integrity_version, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17)`, [
    organisationId, event.actorUserId ?? null, event.sessionId ?? null, event.action,
    event.resourceType, event.resourceId ?? null, outcome, event.ipAddress ?? null,
    event.userAgent ?? null, beforeState == null ? null : JSON.stringify(beforeState),
    afterState == null ? null : JSON.stringify(afterState), JSON.stringify(metadata), severity, source,
    previous,eventHash,createdAt
  ]);
}

export async function emitEvent(db: Db | PoolClient, organisationId: string, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await db.query('INSERT INTO outbox_events (organisation_id, topic, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4,$5)',
    [organisationId, topic, aggregateType, aggregateId, JSON.stringify(payload)]);
}
