import {createHash} from 'node:crypto';
import type {SchoolConfig} from './config.js';
import type {SchoolDb} from './db.js';
import {maybeOne} from './db.js';
import {schoolSessionLoginPath} from './session-ui.js';
import {schoolTenantDocument,schoolWorkspaceUrl,schoolCookieValue} from './tenant-ui.js';

export function rememberedSchoolContext(request:any){
  const saved=schoolCookieValue(request.headers.cookie,'rx_school_login');
  const match=saved.match(/^\/s\/([^/]+)\/(login|admin-login)(?:\?([^#]*))?$/);
  if(!match)return null;
  try{return{organisation_slug:decodeURIComponent(match[1]!),dedicated_admin:match[2]==='admin-login',id:new URLSearchParams(match[3]||'').get('admin')||undefined}}catch{return null}
}

/** Resolve public school context locally, independently of Core authentication. */
export function createSchoolTenantPages(options:{db:SchoolDb;config:SchoolConfig;resolveTenantSchool:(slug:string)=>Promise<any>;schoolFrontend:string;requestSessionToken:(request:any)=>string}){
 const {db,config,resolveTenantSchool,schoolFrontend,requestSessionToken}=options;
function rememberSchoolLogin(reply:any,core:any){
  const path=schoolSessionLoginPath(core).split('&expired=')[0]!;
  if(!path.startsWith('/s/'))return;
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  reply.header('set-cookie','rx_school_login='+encodeURIComponent(path)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000'+secure);
}
async function schoolLoginDocument(request:any,reply:any,frontend:string,administrator=false){
  reply.header('cache-control','no-store, max-age=0');
  const remembered=rememberedSchoolContext(request);
  const explicit=request.params?.school||request.query?.school;
  let previous:any=null;
  const token=explicit?'':requestSessionToken(request);
  if(token.startsWith('rxs_')){
    const row=await maybeOne<any>(db,'SELECT core_context FROM school_sessions WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')]);
    previous=row?.core_context;
  }
  const recovered=previous||remembered;
  const requested=explicit||recovered?.organisation_slug||recovered?.organisation_id;
  if(!requested)return reply.type('text/html; charset=utf-8').send(frontend);
  const school=await resolveTenantSchool(String(requested));
  if(!explicit&&recovered?.dedicated_admin)administrator=true;
  const adminId=request.query?.admin||(administrator&&recovered?.dedicated_admin&&(recovered?.organisation_slug===school.tenant_slug||recovered?.organisation_id===school.organisation_id)?recovered?.id:undefined);
  const context={organisation_slug:school.tenant_slug,dedicated_admin:administrator,id:adminId};
  if(!request.params?.school){
    let target='/s/'+encodeURIComponent(school.tenant_slug)+(administrator?'/admin-login':'/login');
    const query=new URLSearchParams();
    if(adminId&&administrator)query.set('admin',String(adminId));
    if(request.query?.expired)query.set('expired','1');
    if(!administrator&&request.query?.next)query.set('next',String(request.query.next));
    if(query.size)target+='?'+query;
    return reply.redirect(target);
  }
  rememberSchoolLogin(reply,context);
  return reply.type('text/html; charset=utf-8').send(schoolTenantDocument(frontend,school));
}
async function openSchoolDocument(request:any,p:any,next:string){
  const requested=request.query?.school;
  const expected=requested?await resolveTenantSchool(String(requested)):null;
  const token=requestSessionToken(request);
  let session:any=null;
  if(token&&token.startsWith('rxs_')){
    session=await maybeOne<any>(db,`SELECT core_context,
      (revoked_at IS NULL AND expires_at>now() AND last_used_at>now()-make_interval(mins=>COALESCE((
        SELECT idle_timeout_minutes FROM school_security_settings sss WHERE sss.organisation_id=school_sessions.organisation_id
      ),30))) active FROM school_sessions WHERE token_hash=$1`,[createHash('sha256').update(token).digest('hex')]);
  }
  if(!session?.active||(expected&&expected.organisation_id!==session.core_context.organisation_id)){
    const context=expected?{...((session?.core_context?.organisation_id===expected.organisation_id)?session.core_context:{}),organisation_slug:expected.tenant_slug}:session?.core_context||rememberedSchoolContext(request);
    return p.redirect(schoolSessionLoginPath(context,next,Boolean(token)&&!session?.active));
  }
  if(!requested)return p.redirect(schoolWorkspaceUrl(session.core_context.organisation_slug,next));
  return p.header('cache-control','no-store, max-age=0').type('text/html; charset=utf-8').send(schoolTenantDocument(schoolFrontend,expected!));
}
async function signOutSchoolSession(request:any,reply:any){
  const token=requestSessionToken(request),school=String(request.headers['x-revolt-school']||'').trim();
  let context:any=rememberedSchoolContext(request);
  if(token&&token.startsWith('rxs_')){
    const hash=createHash('sha256').update(token).digest('hex');
    const row=await maybeOne<any>(db,`UPDATE school_sessions SET revoked_at=now() WHERE token_hash=$1
      AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM school_profiles sp WHERE sp.organisation_id=school_sessions.organisation_id AND lower(sp.tenant_slug)=lower($2))) RETURNING core_context`,[hash,school||null]);
    if(row)context=row.core_context;
  }
  if(school&&context?.organisation_slug!==school)context={organisation_slug:school};
  rememberSchoolLogin(reply,context);
  const rememberedCookie=reply.getHeader('set-cookie');
  const secure=config.NODE_ENV==='production'?'; Secure':'';
  const cleared='rx_school_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+secure;
  reply.header('set-cookie',rememberedCookie?[String(rememberedCookie),cleared]:cleared);
  return reply.header('cache-control','no-store').send({signedOut:true,loginUrl:schoolSessionLoginPath(context)});
}
 return{schoolLoginDocument,openSchoolDocument,rememberSchoolLogin,signOutSchoolSession};
}
