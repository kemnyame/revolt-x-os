import pg from 'pg';
import type { ShopConfig } from './config.js';

export type Db=pg.Pool | pg.PoolClient;

function normalizeDatabaseUrl(value:string){
  try{
    const url=new URL(value);
    const mode=url.searchParams.get('sslmode');
    if(mode==='prefer'||mode==='require'||mode==='verify-ca')url.searchParams.set('sslmode','verify-full');
    return url.toString();
  }catch{return value;}
}

export function createDb(config:ShopConfig){
  return new pg.Pool({
    connectionString:normalizeDatabaseUrl(config.SHOP_DATABASE_URL),
    max:config.DB_POOL_MAX,
    application_name:'revolt-x-shop',
    options:'-c search_path=revolt_x_shop,public,revolt_x_os'
  });
}

export async function ensureShopNamespace(db:Db){
  await db.query('CREATE SCHEMA IF NOT EXISTS revolt_x_shop');
}

export async function one<T=any>(db:Db,sql:string,params:unknown[]=[]):Promise<T>{
  const r=await db.query(sql,params);
  if(r.rowCount!==1)throw new Error('Expected one row, received '+String(r.rowCount??0));
  return r.rows[0] as T;
}
export async function maybeOne<T=any>(db:Db,sql:string,params:unknown[]=[]):Promise<T|null>{
  const r=await db.query(sql,params);
  if((r.rowCount??0)>1)throw new Error('Expected at most one row, received '+String(r.rowCount));
  return (r.rows[0] as T|undefined)??null;
}
export async function tx<T>(db:Db,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  if(!('connect' in db))return fn(db as pg.PoolClient);
  const c=await (db as pg.Pool).connect();
  try{
    await c.query('BEGIN');
    await c.query('SET LOCAL search_path TO revolt_x_shop, public, revolt_x_os');
    const out=await fn(c);
    await c.query('COMMIT');
    return out;
  }catch(e){
    await c.query('ROLLBACK');
    throw e;
  }finally{c.release();}
}
