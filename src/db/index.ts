import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Config } from '../config.js';

export type Db = Pool | PoolClient;
export function createDb(config: Config): Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    application_name: 'revolt-x-os',
    options: '-c search_path=revolt_x_os,public'
  });
}
export async function ensureOsSchema(db: Pool) {
  await db.query('CREATE SCHEMA IF NOT EXISTS revolt_x_os');
}
export async function maybeOne<T extends QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await db.query<T>(text, params);
  if ((result.rowCount ?? 0) > 1) throw new Error(`Expected at most one row, received ${result.rowCount}`);
  return result.rows[0];
}
export async function one<T extends QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(text, params);
  if (result.rowCount !== 1) throw new Error(`Expected one row, received ${result.rowCount ?? 0}`);
  return result.rows[0]!;
}
export async function transaction<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!('connect' in db)) return fn(db as PoolClient);
  const client: PoolClient = await (db as Pool).connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO revolt_x_os, public');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export type { QueryResult };
