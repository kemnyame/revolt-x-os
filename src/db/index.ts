import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { Config } from '../config.js';

export type Db = pg.Pool;
export const createDb = (config: Config): Db => new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

export async function one<T extends QueryResultRow>(db: Db | PoolClient, sql: string, values: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, values);
  if (result.rowCount !== 1) throw new Error(`Expected one row, received ${result.rowCount ?? 0}`);
  return result.rows[0]!;
}

export async function maybeOne<T extends QueryResultRow>(db: Db | PoolClient, sql: string, values: unknown[] = []): Promise<T | null> {
  const result = await db.query<T>(sql, values);
  if ((result.rowCount ?? 0) > 1) throw new Error(`Expected at most one row, received ${result.rowCount}`);
  return result.rows[0] ?? null;
}

export async function transaction<T>(db: Db, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
