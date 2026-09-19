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

export type SchoolRole=string;

export async function effectiveCapabilities(db:SchoolDb,organisationId:string,role:SchoolRole){
  if(role==='school_admin'){
    return (await db.query<{key:string}>('SELECT key FROM school_capabilities ORDER BY sort_order,key')).rows.map(x=>x.key);
  }
  return (await db.query<{capability_key:string}>(
    'SELECT capability_key FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND allowed=true ORDER BY capability_key',
    [organisationId,role]
  )).rows.map(x=>x.capability_key);
}

export async function schoolRoleProfile(db:SchoolDb,organisationId:string,role:SchoolRole){
  if(role==='school_admin')return{key:'school_admin',name:'School Administrator',portal_mode:'admin',can_teach:true,is_system:true,is_active:true};
  return maybeOne<any>(db,
    'SELECT key,name,description,portal_mode,can_teach,is_system,is_active FROM school_roles WHERE organisation_id=$1 AND key=$2',
    [organisationId,role]
  );
}

const coreContextCache=new Map<string,{value:CoreContext;expiresAt:number}>();
const CORE_CONTEXT_CACHE_MS=15_000;
function authCacheKey(auth:string){return createHash('sha256').update(auth).digest('hex')}

function bearerToken(auth:string){return auth.replace(/^Bearer\s+/i,'').trim()}
function cookieValue(cookieHeader:string|undefined,name:string){
  if(!cookieHeader)return'';
  for(const part of cookieHeader.split(';')){
    const p=part.trim(),eq=p.indexOf('=');
    if(eq>0&&p.slice(0,eq)===name)return decodeURIComponent(p.slice(eq+1));
  }
  return'';
}
function requestSchoolToken(request:FastifyRequest){
  const auth=request.headers.authorization;
  if(auth){
    const token=bearerToken(auth);
    if(token.startsWith('rxs_'))return token;
  }
  const cookieToken=cookieValue(request.headers.cookie,'rx_school_session');
  return cookieToken.startsWith('rxs_')?cookieToken:'';
}
function schoolSessionHash(token:string){return createHash('sha256').update(token).digest('hex')}

async function fetchSchoolSessionContext(request:FastifyRequest,db:SchoolDb):Promise<CoreContext|null>{
  const token=requestSchoolToken(request);
  if(!token)return null;
  const row=await maybeOne<{core_context:CoreContext}>(
    db,
    `UPDATE school_sessions
       SET last_used_at=now()
       WHERE token_hash=$1
         AND revoked_at IS NULL
         AND expires_at>now()
       RETURNING core_context`,
    [schoolSessionHash(token)]
  );
  return row?.core_context??null;
}

const CORE_TRANSIENT_STATUSES=new Set([429,502,503,504]);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function fetchCoreContext(request:FastifyRequest,config:SchoolConfig):Promise<CoreContext>{
  const auth=request.headers.authorization;
  if(!auth) throw Object.assign(new Error('Authentication required'),{statusCode:401});

  const key=authCacheKey(auth);
  const cached=coreContextCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.value;
  if(cached)coreContextCache.delete(key);

  const url=config.CORE_OS_URL.replace(/\/$/,'')+'/v1/auth/context';
  let lastStatus=503;
  let lastMessage='Core Revolt-X OS is starting. Please retry in a moment.';

  for(let attempt=0;attempt<6;attempt++){
    const res=await fetch(url,{
      headers:{authorization:auth},
      signal:AbortSignal.timeout(15000)
    }).catch(()=>null);

    if(res?.ok){
      const value=await res.json() as CoreContext;
      if(coreContextCache.size>=2000){
        const oldest=coreContextCache.keys().next().value;
        if(oldest)coreContextCache.delete(oldest);
      }
      coreContextCache.set(key,{value,expiresAt:Date.now()+CORE_CONTEXT_CACHE_MS});
      return value;
    }

    if(res){
      lastStatus=res.status;
      const body=await res.json().catch(()=>null) as any;
      lastMessage=body?.error?.message
        ||(CORE_TRANSIENT_STATUSES.has(res.status)
          ?'Core Revolt-X OS is starting. Please retry in a moment.'
          :'Core OS authentication failed');
      if(!CORE_TRANSIENT_STATUSES.has(res.status)){
        throw Object.assign(new Error(lastMessage),{statusCode:res.status});
      }
    }

    if(attempt<5)await sleep([1000,1800,3000,4500,6500][attempt]||6500);
  }

  throw Object.assign(new Error(lastMessage),{statusCode:lastStatus});
}

export async function authorize(request:FastifyRequest,db:SchoolDb,config:SchoolConfig,capability?:string){
  const core=(await fetchSchoolSessionContext(request,db))??await fetchCoreContext(request,config);
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
       WHERE organisation_id=$1 AND role=$2 AND capability_key=$3`,
      [core.organisation_id,membership.role,capability]
    );
    if(!allowed?.allowed){
      throw Object.assign(new Error(`School permission required: ${capability}`),{statusCode:403});
    }
  }

  return {core,role:membership.role};
}
