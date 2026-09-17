import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';
import { createDb, ensureOsSchema } from './index.js';
import { loadConfig } from '../config.js';

export async function migrate(db: Db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const candidates=[join(process.cwd(),'migrations'),join(fileURLToPath(new URL('../../',import.meta.url)),'migrations')];
  let dir=candidates[0]!;
  const files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files){
    const applied=await db.query('SELECT 1 FROM schema_migrations WHERE version=$1',[file]);
    if(applied.rowCount) continue;
    const sql=await readFile(join(dir,file),'utf8');
    await db.query('BEGIN');
    try { await db.query('SET LOCAL search_path TO revolt_x_os, public'); await db.query(sql); await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[file]); await db.query('COMMIT'); }
    catch(error){ await db.query('ROLLBACK'); throw error; }
  }
}

if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href){ const db=createDb(loadConfig()); await ensureOsSchema(db); await migrate(db); await db.end(); }
