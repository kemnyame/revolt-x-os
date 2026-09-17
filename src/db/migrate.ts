import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb } from './index.js';
import { loadConfig } from '../config.js';

export async function migrate(directory = resolve('migrations')): Promise<void> {
  const db = createDb(loadConfig());
  try {
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await db.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (applied.rowCount) continue;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(await readFile(resolve(directory, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        await client.query('COMMIT');
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  } finally { await db.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) migrate().catch((error) => { console.error(error); process.exit(1); });
