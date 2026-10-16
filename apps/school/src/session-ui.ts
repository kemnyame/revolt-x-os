import {schoolNavigationScript} from './mobile-navigation.js';
import {schoolLocationScript} from './tenant-ui.js';
/** Authentication deadlines come from the server; no heartbeat extends idle sessions. */
export function setSessionDeadline(request:any,value:Date|string|null|undefined){
  if(!value)return;
  const time=new Date(value).getTime();
  if(Number.isFinite(time))request.sessionExpiresAt=new Date(time).toISOString();
}

export function schoolSessionLoginPath(core:any,next='/',expired=false){
  const slug=core?.organisation_slug||core?.organisation_id;
  const administrator=Boolean(core?.dedicated_admin);
  let path=slug?'/s/'+encodeURIComponent(slug)+(administrator?'/admin-login':'/login'):'/login';
  const query=new URLSearchParams(administrator?(core?.id?{admin:core.id}:{}):{next});
  if(expired)query.set('expired','1');
  return path+(query.size?'?'+query.toString():'');
}

export function schoolSessionScript(portal:'staff'|'teacher'|'parent'|'student'){
  return String.raw`
${schoolLocationScript}
${schoolNavigationScript}
(function(){
  var portal=${JSON.stringify(portal)},originalFetch=window.fetch.bind(window),redirecting=false,deadline=0,timer=null;
  var family=portal==='teacher'?'staff':portal,deadlineKey='rx_'+(family==='staff'?'school':family)+'_session_expires_at';
  var hintKey='rx_'+(family==='staff'?'school':family)+'_login_url';
  function expired(){var error=Error('Your session expired. Please sign in again.');error.status=401;return error}
  function safeHint(){
    var hint=sessionStorage.getItem(hintKey);if(!hint)return null;
    try{var url=new URL(hint,location.origin);if(url.origin!==location.origin)return null;
      if(family==='staff'&&!/^\/s\/[^/]+\/(login|admin-login)$/.test(url.pathname)&&url.pathname!=='/login'&&url.pathname!=='/admin-login')return null;
      if(family!=='staff'&&url.pathname!=='/'+family)return null;
      return url;
    }catch(e){return null}
  }
  function loginTarget(expiredSession){
    var url=safeHint(),routeSchool=schoolFromLocation();
    // The address takes precedence over a browser hint from a different school.
    if(routeSchool&&url){try{if(decodeURIComponent(url.pathname.split('/')[2]||'')!==routeSchool)url=null}catch(e){url=null}}
    if((portal==='teacher'||portal==='parent')&&location.pathname==='/mobile/'+portal){
      var mobile=new URL('/mobile/'+portal,location.origin),mobileSchool=routeSchool||'';
      if(mobileSchool)mobile.searchParams.set('school',mobileSchool);
      if(expiredSession)mobile.searchParams.set('expired','1');return mobile.pathname+mobile.search;
    }
    if(!url){
      var school=routeSchool||'';
      var path=family==='staff'?(school?'/s/'+encodeURIComponent(school)+'/login':'/login'):'/'+family;
      url=new URL(path,location.origin);if(school&&family!=='staff')url.searchParams.set('school',school);
    }
    if(family==='staff'&&!url.pathname.endsWith('/admin-login'))url.searchParams.set('next',portal==='teacher'?'/teacher':'/');
    if(expiredSession)url.searchParams.set('expired','1');else url.searchParams.delete('expired');return url.pathname+url.search;
  }
  function endSession(){
    if(redirecting)return;redirecting=true;clearTimeout(timer);
    var target=loginTarget(true);
    if(family==='staff'){sessionStorage.removeItem('rx_school_token');sessionStorage.removeItem('rx_teacher_token')}
    else sessionStorage.removeItem('rx_'+family+'_token');
    sessionStorage.removeItem(deadlineKey);location.replace(target);
  }
  function armDeadline(value){
    var time=Date.parse(value||'');if(!Number.isFinite(time))return;
    deadline=time;sessionStorage.setItem(deadlineKey,String(time));clearTimeout(timer);
    function check(){var remaining=deadline-Date.now();if(remaining<=0){endSession();return}timer=setTimeout(check,Math.min(remaining,86400000))}
    check();
  }
  async function rememberContext(response,path){
    var contextPaths=family==='staff'?['/api/context','/api/teacher/context']:['/api/'+family+'/me'];
    if(!contextPaths.includes(path))return;
    try{
      var context=await response.clone().json(),core=context.core||{},school=context.profile||context.school||{};
      var slug=core.organisation_slug||school.tenant_slug||new URLSearchParams(location.search).get('school')||'';
      if(!slug)return;
      var target=family==='staff'?'/s/'+encodeURIComponent(slug)+(core.dedicated_admin?'/admin-login?admin='+encodeURIComponent(core.id):'/login'):'/'+family+'?school='+encodeURIComponent(slug);
      sessionStorage.setItem(hintKey,target);
    }catch(e){}
  }
  window.fetch=async function(input,options){
    var url=new URL(typeof input==='string'?input:input.url||String(input),location.href),path=url.pathname;
    var routeSchool=schoolFromLocation();
    if(routeSchool&&url.origin===location.origin&&path.startsWith('/api/')){
      var headers=new Headers(options&&options.headers||(typeof input!=='string'&&input.headers)||{});headers.set('x-revolt-school',routeSchool);
      options=Object.assign({},options||{},{headers:headers});
    }
    var protectedCall=url.origin===location.origin&&(family==='staff'
      ?path.startsWith('/api/')&&(!path.startsWith('/api/auth/')||path==='/api/auth/change-password'||path==='/api/auth/logout')&&!path.startsWith('/api/test-access/')&&!path.startsWith('/api/system/core-')
      :path.startsWith('/api/'+family+'/')&&path!=='/api/'+family+'/login');
    if(!protectedCall)return originalFetch(input,options);
    if(redirecting)throw expired();
    if(deadline&&deadline<=Date.now()){endSession();throw expired()}
    var response=await originalFetch(input,options);
    if(response.status===401){endSession();throw expired()}
    if(!redirecting&&response.ok){await rememberContext(response,path);armDeadline(response.headers&&response.headers.get('x-revolt-session-expires-at'))}
    return response;
  };
  window.rxSessionGuard={expire:endSession,loginTarget:function(){return loginTarget(false)},school:schoolFromLocation};
  var saved=Number(sessionStorage.getItem(deadlineKey));
  if(saved&&sessionStorage.getItem('rx_'+(family==='staff'?'school':family)+'_token'))armDeadline(new Date(saved).toISOString());
})();
`;
}
