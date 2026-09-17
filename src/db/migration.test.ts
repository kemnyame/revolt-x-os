import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
afterAll(() => db.close());

describe('PostgreSQL migration', () => {
  it('applies the complete core schema and seed data', async () => {
    const sql = await readFile(resolve('migrations/001_core.sql'), 'utf8');
    await db.exec(sql);
    const tables = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'organisations', 'users', 'sessions', 'audit_logs', 'operation_items',
      'workflow_definitions', 'workflow_instances', 'module_clients', 'outbox_events'
    ]));
    const seeded = await db.query<{ count: string }>('SELECT count(*)::text count FROM permissions');
    expect(Number(seeded.rows[0]?.count)).toBeGreaterThanOrEqual(16);
  });
});
