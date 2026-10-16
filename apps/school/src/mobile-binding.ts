import {createHash} from 'node:crypto';
import {schoolCookieValue,schoolWorkspaceUrl} from './tenant-ui.js';
import {rememberedSchoolContext} from './tenant-pages.js';

/** Only public navigation context is recovered here. Authentication still verifies
 * the target school's membership and session on every protected request. */
export function mobileSchoolResolver(d:any){
 return async(request:any)=>{
  let slug=request.query?.school||schoolCookieValue(request.headers.cookie,'rx_mobile_school')||rememberedSchoolContext(request)?.organisation_slug;
  if(!slug){
   const token=d.requestSessionToken(request);
   if(token?.startsWith('rxs_')){const session=(await d.db.query('SELECT core_context FROM school_sessions WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')])).rows[0];slug=session?.core_context?.organisation_slug||session?.core_context?.organisation_id}
  }
  return slug?d.resolveTenantSchool(String(slug)):null;
 };
}
export function mobileManifest(base:any,school:any){
 if(!school)return base;
 return{...base,id:schoolWorkspaceUrl(school.tenant_slug,'/mobile'),name:school.school_name+' · Revolt School',short_name:school.short_name||school.school_name,
  start_url:schoolWorkspaceUrl(school.tenant_slug,'/mobile'),shortcuts:base.shortcuts.map((s:any)=>({...s,url:schoolWorkspaceUrl(school.tenant_slug,s.url)}))};
}
export function mobileSchoolCookie(request:any,school:any){
 return 'rx_mobile_school='+encodeURIComponent(school.tenant_slug)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000'+(request.protocol==='https'?'; Secure':'');
}
export function androidMobileIntent(slug:string){
 const path=schoolWorkspaceUrl(slug,'/mobile');
 return 'intent://revolt-x-school.onrender.com'+path+'#Intent;scheme=https;package=com.revoltx.school;S.browser_fallback_url='+encodeURIComponent('https://revolt-x-school.onrender.com'+path)+';end';
}
