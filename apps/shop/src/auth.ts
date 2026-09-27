import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { ShopConfig } from './config.js';
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

type CoreTokens={accessToken:string;refreshToken:string;expiresIn:number;organisationId?:string};
export type DemoPersona='shop_admin'|'manager'|'cashier'|'service'|'finance'|'inventory'|'auditor';
export type DemoTokens=CoreTokens&{demo:true;persona:DemoPersona;userId:string;email:string;firstName:string;lastName:string;jobTitle:string};
export type ShopRole='shop_admin'|'manager'|'cashier'|'finance'|'service'|'inventory'|'auditor';

const caps:Record<ShopRole,string[]>={
  shop_admin:['*'],
  manager:['dashboard.read','shops.manage','customers.manage','services.manage','jobs.manage','sales.manage','payments.create','payments.read','inventory.manage','reports.read','bookings.manage'],
  cashier:['dashboard.read','customers.manage','sales.manage','payments.create','payments.read','bookings.manage'],
  finance:['dashboard.read','payments.create','payments.read','finance.manage','reports.read','customers.read'],
  service:['dashboard.read','customers.read','services.read','jobs.manage','bookings.manage'],
  inventory:['dashboard.read','inventory.manage','products.manage'],
  auditor:['dashboard.read','customers.read','services.read','jobs.read','payments.read','finance.read','reports.read','audit.read']
};

function cookieValue(header:string|undefined,name:string){
  if(!header)return'';
  for(const part of header.split(';')){
    const p=part.trim();
    const i=p.indexOf('=');
    if(i>0&&p.slice(0,i)===name)return decodeURIComponent(p.slice(i+1));
  }
  return'';
}

function cookie(name:string,value:string,maxAge:number,secure:boolean){
  return name+'='+encodeURIComponent(value)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(secure?'; Secure':'');
}

export function setAuthCookies(reply:FastifyReply,tokens:CoreTokens,config:ShopConfig){
  const secure=config.NODE_ENV==='production';
  reply.header('Set-Cookie',[
    cookie('rx_shop_access',tokens.accessToken,Math.max(60,tokens.expiresIn),secure),
    cookie('rx_shop_refresh',tokens.refreshToken,60*60*24*30,secure)
  ]);
}

export function clearAuthCookies(reply:FastifyReply,config:ShopConfig){
  const secure=config.NODE_ENV==='production';
  reply.header('Set-Cookie',[
    cookie('rx_shop_access','',0,secure),
    cookie('rx_shop_refresh','',0,secure)
  ]);
}

async function coreJson(config:ShopConfig,path:string,init:RequestInit){
  const res=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+path,{...init,signal:AbortSignal.timeout(15000)});
  const body=await res.json().catch(()=>null) as any;
  if(!res.ok){
    const e:any=new Error(body?.error?.message||'Core Revolt-X OS request failed');
    e.statusCode=res.status;
    throw e;
  }
  return body;
}

export async function loginToCore(config:ShopConfig,email:string,password:string,organisationId?:string){
  return coreJson(config,'/v1/auth/login',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({email,password,...(organisationId?{organisationId}:{})})
  }) as Promise<CoreTokens>;
}

export async function loginDemoToCore(config:ShopConfig,persona:DemoPersona){
  return coreJson(config,'/v1/auth/shop-demo',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({persona})
  }) as Promise<DemoTokens>;
}

async function contextForToken(config:ShopConfig,token:string){
  return coreJson(config,'/v1/auth/context',{headers:{authorization:'Bearer '+token}}) as Promise<CoreContext>;
}

async function refreshCore(config:ShopConfig,refreshToken:string){
  return coreJson(config,'/v1/auth/refresh',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({refreshToken})
  }) as Promise<CoreTokens>;
}

export async function requestCorePasswordReset(config:ShopConfig,email:string){
  const body=await coreJson(config,'/v1/auth/password-reset/request',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({email})
  }) as any;
  return body as {accepted:boolean;resetToken?:string;expiresInMinutes?:number};
}

export async function confirmCorePasswordReset(config:ShopConfig,token:string,password:string){
  return coreJson(config,'/v1/auth/password-reset/confirm',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({token,password})
  }) as Promise<{reset:boolean}>;
}

export async function resetCorePasswordAsSystem(config:ShopConfig,email:string,password:string){
  const req=await requestCorePasswordReset(config,email);
  if(!req.resetToken)throw new Error('Core OS did not return a reset token for this active account');
  return confirmCorePasswordReset(config,req.resetToken,password);
}

export async function resolveCoreContext(request:FastifyRequest,reply:FastifyReply,config:ShopConfig){
  const bearer=request.headers.authorization?.replace(/^Bearer\s+/i,'').trim();
  let access=bearer||cookieValue(request.headers.cookie,'rx_shop_access');
  const refresh=cookieValue(request.headers.cookie,'rx_shop_refresh');
  if(!access){
    const e:any=new Error('Authentication required');e.statusCode=401;throw e;
  }
  try{return await contextForToken(config,access);}
  catch(e:any){
    if(e?.statusCode!==401||!refresh)throw e;
    const tokens=await refreshCore(config,refresh);
    setAuthCookies(reply,tokens,config);
    access=tokens.accessToken;
    return contextForToken(config,access);
  }
}

export async function authorize(db:Db,config:ShopConfig,request:FastifyRequest,reply:FastifyReply,capability?:string){
  const core=await resolveCoreContext(request,reply,config);
  let membership=await maybeOne<{role:ShopRole;status:string}>(db,
    'SELECT role,status FROM shop_memberships WHERE organisation_id=$1 AND os_user_id=$2',
    [core.organisation_id,core.id]
  );
  if(!membership&&core.permissions.includes('organisation.manage')){
    membership=await maybeOne<{role:ShopRole;status:string}>(db,
      `INSERT INTO shop_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,'shop_admin','active')
       ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET status='active'
       RETURNING role,status`,
      [core.organisation_id,core.id]
    );
  }
  if(!membership||membership.status!=='active'){
    const e:any=new Error('Revolt-X Shop access is not active for this user');e.statusCode=403;throw e;
  }
  if(capability){
    const allowed=caps[membership.role]||[];
    if(!allowed.includes('*')&&!allowed.includes(capability)){
      const e:any=new Error('Shop permission required: '+capability);e.statusCode=403;throw e;
    }
  }
  return{core,role:membership.role};
}
