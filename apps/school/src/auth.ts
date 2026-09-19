import type { FastifyRequest } from 'fastify';
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

async function fetchCoreContext(request:FastifyRequest,config:SchoolConfig):Promise<CoreContext>{
  const auth=request.headers.authorization;
  if(!auth) throw Object.assign(new Error('Authentication required'),{statusCode:401});
  const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/v1/auth/context',{
    headers:{authorization:auth},
    signal:AbortSignal.timeout(10000)
  }).catch(()=>null);
  if(!res) throw Object.assign(new Error('Core Revolt-X OS could not be reached'),{statusCode:503});
  if(!res.ok) throw Object.assign(new Error('Core OS authentication failed'),{statusCode:res.status});
  return await res.json() as CoreContext;
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
