import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SchoolConfig } from './config.js';

export type SchoolDb = pg.Pool | pg.PoolClient;

export function createSchoolDb(config: SchoolConfig) {
  return new pg.Pool({
    connectionString: config.SCHOOL_DATABASE_URL,
    max: config.DB_POOL_MAX,
    application_name: 'revolt-x-school'
  });
}

export async function ensureSchoolSchema(db: pg.Pool) {
  await db.query('CREATE SCHEMA IF NOT EXISTS revolt_x_school');
}

export async function migrateSchool(db: pg.Pool) {
  await db.query('SET search_path TO revolt_x_school, public');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir=join(process.cwd(),'migrations');
  const files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files){
    const existing=await db.query('SELECT 1 FROM schema_migrations WHERE version=$1',[file]);
    if(existing.rowCount) continue;
    const sql=await readFile(join(dir,file),'utf8');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO revolt_x_school, public');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[file]);
      await client.query('COMMIT');
    }catch(error){
      await client.query('ROLLBACK');
      throw error;
    }finally{
      client.release();
    }
  }
}

export async function one<T=any>(db:SchoolDb,text:string,params:unknown[]=[]):Promise<T>{
  const result=await db.query(text,params);
  if(result.rowCount!==1) throw new Error(`Expected one row, received ${result.rowCount??0}`);
  return result.rows[0] as T;
}

export async function maybeOne<T=any>(db:SchoolDb,text:string,params:unknown[]=[]):Promise<T|undefined>{
  const result=await db.query(text,params);
  if((result.rowCount??0)>1) throw new Error(`Expected at most one row, received ${result.rowCount}`);
  return result.rows[0] as T|undefined;
}

export async function tx<T>(db:SchoolDb,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  if(!('connect' in db)) return fn(db as pg.PoolClient);
  const client=await (db as pg.Pool).connect();
  try{
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO revolt_x_school, public');
    const value=await fn(client);
    await client.query('COMMIT');
    return value;
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{
    client.release();
  }
}
