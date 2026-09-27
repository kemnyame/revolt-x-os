import pg from 'pg';
import type { ShopConfig } from './config.js';

export type Db=pg.Pool;

export function createDb(config:ShopConfig){
  const isRemote=/sslmode=require|render\.com|neon\.tech|railway/i.test(config.SHOP_DATABASE_URL);
  return new pg.Pool({
    connectionString:config.SHOP_DATABASE_URL,
    max:config.DB_POOL_MAX,
    ssl:isRemote?{rejectUnauthorized:false}:undefined
  });
}

export async function one<T>(db:Db,sql:string,params:any[]=[]):Promise<T>{
  const r=await db.query<T>(sql,params);
  if(r.rowCount!==1)throw new Error('Expected one row');
  return r.rows[0]!;
}
export async function maybeOne<T>(db:Db,sql:string,params:any[]=[]):Promise<T|null>{
  const r=await db.query<T>(sql,params);
  return r.rows[0]??null;
}
export async function tx<T>(db:Db,fn:(client:pg.PoolClient)=>Promise<T>){
  const c=await db.connect();
  try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}
  catch(e){await c.query('ROLLBACK');throw e;}
  finally{c.release();}
}
