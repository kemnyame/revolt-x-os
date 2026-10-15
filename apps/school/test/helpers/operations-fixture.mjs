import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {readFile,readdir} from 'node:fs/promises';
import {one,maybeOne,tx} from '../../dist/db.js';
export const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const fail=(statusCode,message)=>Object.assign(Error(message),{statusCode});
export async function operationsFixture(){
 const pg=new PGlite({extensions:{pg_trgm}});
 await pg.exec('CREATE SCHEMA revolt_x_school;SET search_path TO revolt_x_school,public');
 for(const name of (await readdir(new URL('../../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
   try{await pg.exec(await readFile(new URL('../../migrations/'+name,import.meta.url),'utf8'));if(name==='001_school_core.sql')await pg.query("INSERT INTO school_profiles(organisation_id,school_name) VALUES($1,'Fixture School'),($2,'Other School')",[id(1),id(2)])}catch(error){throw new Error(name+': '+error.message,{cause:error})}
 }
 const client={query:async(sql,params)=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.affectedRows||r.rows.length}},release(){}};
 const db={...client,connect:async()=>client};
 return{pg,db,one,maybeOne,tx,fail,config:{},audit:async()=>{}};
}
