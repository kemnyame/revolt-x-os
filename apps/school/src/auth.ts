import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';
import { maybeOne } from './db.js';

export type CoreContext={
  id:string;
  email:string;
  first_name:string;
  last_name:string;
  status:string;
  membership_id:string;
  membership_status:string;
  organisation_id:string;
  organisation_name:string;
  organisation_slug:string;
  sessionId:string;
  permissions:string[];
  preview?:boolean;
};

export type SchoolRole='school_admin'|'headteacher'|'teacher'|'bursar'|'registrar';

export async function effectiveCapabilities(db:SchoolDb,role:SchoolRole){
  if(role==='school_admin'){
    return (await db.query<{key:string}>('SELECT key FROM school_capabilities ORDER BY sort_order,key')).rows.map(x=>x.key);
  }
  return (await db.query<{capability_key:string}>(
    'SELECT capability_key FROM school_role_capabilities WHERE role=$1 AND allowed=true ORDER BY capability_key',
    [role]
  )).rows.map(x=>x.capability_key);
}

const coreContextCache=new Map<string,{value:CoreContext;expiresAt:number}>();
const CORE_CONTEXT_CACHE_MS=15_000;
function authCacheKey(auth:string){return createHash('sha256').update(auth).digest('hex')}

async function fetchCoreContext(request:FastifyRequest,config:SchoolConfig):Promise<CoreContext>{
  const auth=request.headers.authorization;
  if(!auth) throw Object.assign(new Error('Authentication required'),{statusCode:401});

  const key=authCacheKey(auth);
  const cached=coreContextCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.value;
  if(cached)coreContextCache.delete(key);

  const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/auth/context',{
    headers:{authorization:auth},
    signal:AbortSignal.timeout(10000)
  }).catch(()=>null);
  if(!res) throw Object.assign(new Error('Core Revolt-X OS could not be reached'),{statusCode:503});

  if(!res.ok){
    const body=await res.json().catch(()=>null) as any;
    const message=res.status===429
      ? 'Core OS is temporarily rate limited. Please retry in a moment.'
      : body?.error?.message||'Core OS authentication failed';
    throw Object.assign(new Error(message),{statusCode:res.status});
  }

  const value=await res.json() as CoreContext;
  if(coreContextCache.size>=2000){
    const oldest=coreContextCache.keys().next().value;
    if(oldest)coreContextCache.delete(oldest);
  }
  coreContextCache.set(key,{value,expiresAt:Date.now()+CORE_CONTEXT_CACHE_MS});
  return value;
}

export async function authorize(request:FastifyRequest,db:SchoolDb,config:SchoolConfig,capability?:string){
  const core=await fetchCoreContext(request,config);
  let membership=await maybeOne<{role:SchoolRole;status:string}>(
    db,
    'SELECT role,status FROM school_memberships WHERE organisation_id=$1 AND os_user_id=$2',
    [core.organisation_id,core.id]
  );

  if(!membership && core.permissions.includes('organisation.manage')){
    membership=await maybeOne<{role:SchoolRole;status:string}>(
      db,
      `INSERT INTO school_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,'school_admin','active')
       ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET status='active'
       RETURNING role,status`,
      [core.organisation_id,core.id]
    );
  }

  if(!membership || membership.status!=='active'){
    throw Object.assign(new Error('School module access is not active for this user'),{statusCode:403});
  }

  if(capability && membership.role!=='school_admin'){
    const allowed=await maybeOne<{allowed:boolean}>(
      db,
      `SELECT allowed
       FROM school_role_capabilities
       WHERE role=$1 AND capability_key=$2`,
      [membership.role,capability]
    );
    if(!allowed?.allowed){
      throw Object.assign(new Error(`School permission required: ${capability}`),{statusCode:403});
    }
  }

  return {core,role:membership.role};
}
