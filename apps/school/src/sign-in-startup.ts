import type { SchoolConfig } from './config.js';

/** A gateway response does not prove that the Core application is running. */
export async function probeSchoolSignInService(config: SchoolConfig, fetchCore: typeof fetch = fetch) {
  const base = config.CORE_OS_URL.replace(/\/$/, '');
  const started = Date.now();
  try {
    const response = await fetchCore(base + '/health/live', {
      method: 'GET', signal: AbortSignal.timeout(4500), cache: 'no-store'
    });
    const body = await response.json().catch(() => null) as any;
    const ready = response.ok && body?.status === 'ok';
    return { reachable: ready, healthy: ready, status: response.status, responseMs: Date.now() - started, url: base };
  } catch {
    return { reachable: false, healthy: false, status: 0, responseMs: Date.now() - started, url: base };
  }
}

/** An interactive sign-in wakes the public health endpoint from the user's client.
 * Some sleeping hosts reject service-origin requests before Core can receive them.
 * The public request contains no staff credentials, cookies, or access tokens.
 * Its response is deliberately opaque: readiness is verified through School.
 * There is no periodic keep-alive or alternate authentication service. */
export const schoolSignInStartupScript = String.raw`
(function(){
  var pending=null;
  function unavailable(){var error=Error('The sign-in service could not start. Your entries are still here. Please try signing in again.');error.status=503;return error}
  function pause(milliseconds){return new Promise(function(resolve){setTimeout(resolve,milliseconds)})}
  async function read(url,timeout,external){
    var controller=typeof AbortController==='function'?new AbortController():null;
    var timer=controller?setTimeout(function(){controller.abort()},timeout):null;
    try{
      var response=await window.fetch(url,{method:'GET',cache:'no-store',credentials:external?'omit':'same-origin',mode:external?'no-cors':'same-origin',redirect:external?'error':'follow',signal:controller?controller.signal:undefined});
      if(external)return{ok:response.ok,status:response.status,body:null};
      var body=await response.json().catch(function(){return null});
      return{ok:response.ok,status:response.status,body:body};
    }catch(error){return{ok:false,status:0,body:null}}
    finally{if(timer!==null)clearTimeout(timer)}
  }
  function publicHealthUrl(base){
    try{
      if(typeof base!=='string'||!base)return null;
      var url=new URL(base,location.origin);
      if(url.username||url.password||url.search||url.hash)return null;
      if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return null;
      url.pathname=url.pathname.replace(/\/$/,'')+'/health/live';return url.href;
    }catch(error){return null}
  }
  async function start(progress){
    var deadline=Date.now()+90000;
    var status=await read('/api/system/core-status',5000,false),core=status.body&&status.body.core;
    if(status.ok&&core&&core.healthy===true)return;
    var url=core&&publicHealthUrl(core.url);
    if(!url)throw unavailable();
    if(progress)progress('Starting sign-in. This can take up to a minute. Please wait…');
    for(var attempt=0;attempt<6&&Date.now()<deadline;attempt++){
      await read(url,Math.max(1,Math.min(15000,deadline-Date.now())),true);
      if(Date.now()>=deadline)break;
      // Confirm the original School-to-Core connection before sending a password.
      var verified=await read('/api/system/core-status',Math.max(1,Math.min(5000,deadline-Date.now())),false);
      if(verified.ok&&verified.body&&verified.body.core&&verified.body.core.healthy===true){
        if(progress)progress('Signing in…');return;
      }
      if(attempt<5){var delay=[1000,2000,3000,5000,6000][attempt];if(Date.now()+delay>=deadline)break;await pause(delay)}
    }
    throw unavailable();
  }
  window.RevoltSchoolSignIn={ensureReady:function(progress){
    if(pending)return pending;
    pending=start(progress).finally(function(){pending=null});return pending;
  }};
})();
`;
