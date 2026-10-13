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

/**
 * The browser performs a best-effort wake/readiness check before sign-in, but it must
 * never block credential submission. The School backend owns the authoritative Core
 * connection and already performs bounded retries before returning a real sign-in error.
 * This prevents a transient or opaque browser health probe from producing a false
 * "sign-in service could not start" error while Core is actually available.
 */
export const schoolSignInStartupScript = String.raw`
(function(){
  var pending=null;
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
    // Keep this check short. If the browser cannot prove readiness, continue to the
    // real School login endpoint, whose server-side Core call already retries safely.
    var status=await read('/api/system/core-status',6000,false),core=status.body&&status.body.core;
    if(status.ok&&core&&core.healthy===true){if(progress)progress('Signing in…');return}

    var url=core&&publicHealthUrl(core.url);
    if(progress)progress('Connecting securely…');
    if(url){
      await read(url,5000,true);
      await pause(350);
      var verified=await read('/api/system/core-status',6000,false);
      if(verified.ok&&verified.body&&verified.body.core&&verified.body.core.healthy===true){
        if(progress)progress('Signing in…');return
      }
    }

    // Do not throw here. Browser DNS/CORS/no-cors behaviour can make a health probe
    // appear to fail even when the School server can reach Core. The authenticated
    // POST that follows is the authoritative connectivity test.
    if(progress)progress('Signing in…');
  }
  window.RevoltSchoolSignIn={ensureReady:function(progress){
    if(pending)return pending;
    pending=start(progress).finally(function(){pending=null});return pending;
  }};
})();
`;
