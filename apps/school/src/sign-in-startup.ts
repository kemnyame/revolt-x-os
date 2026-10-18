import type { SchoolConfig } from './config.js';

/** Sign-in needs a ready authentication database, not just a running process.
 * An operator-confirmed outage stops cold-start retries. A healthy readiness
 * response always clears the notice for that request, so it cannot lock out a
 * restored service. No credentials are sent by this public probe. */
export async function probeSchoolSignInService(config: SchoolConfig, fetchCore: typeof fetch = fetch) {
  const base = config.CORE_OS_URL.replace(/\/$/, '');
  const started = Date.now();
  const incident = config.CORE_SIGN_IN_OUTAGE_MESSAGE?.trim();
  const unavailable = (status:number) => ({reachable:false,healthy:false,status,responseMs:Date.now()-started,url:base,
    ...(incident?{retryable:false,message:incident,code:'SCHOOL_SIGN_IN_OUTAGE'}:{})});
  try {
    const response = await fetchCore(base + '/health/ready', {
      method: 'GET', signal: AbortSignal.timeout(4500), cache: 'no-store'
    });
    const body = await response.json().catch(() => null) as any;
    const ready = response.ok && body?.status === 'ready';
    return ready?{reachable:true,healthy:true,status:response.status,responseMs:Date.now()-started,url:base}:unavailable(response.status);
  } catch {
    return unavailable(0);
  }
}

/** Direct API callers receive the same incident response as browser sign-in. */
export async function assertCoreSignInAvailable(config:SchoolConfig,fetchCore:typeof fetch=fetch){
  if(!config.CORE_SIGN_IN_OUTAGE_MESSAGE?.trim())return;
  const status=await probeSchoolSignInService(config,fetchCore);
  if(!status.healthy)throw Object.assign(new Error(config.CORE_SIGN_IN_OUTAGE_MESSAGE.trim()),{statusCode:503,code:'SCHOOL_SIGN_IN_OUTAGE'});
}

/** An interactive sign-in wakes the public health endpoint from the user's client.
 * Some sleeping hosts reject service-origin requests before Core can receive them.
 * The public request contains no staff credentials, cookies, or access tokens.
 * Its response is deliberately opaque: readiness is verified through School.
 * There is no periodic keep-alive or alternate authentication service. */
export const schoolSignInStartupScript = String.raw`
(function(){
  var pending=null;
  function unavailable(message){var error=Error(message||'Sign-in is unavailable because the authentication service did not recover. Your entries are still here. Contact your school administrator if this continues.');error.status=503;return error}
  function pause(milliseconds){return new Promise(function(resolve){setTimeout(resolve,milliseconds)})}
  async function read(url,timeout,external,providedController){
    var controller=providedController||(typeof AbortController==='function'?new AbortController():null);
    var timer=controller?setTimeout(function(){controller.abort()},timeout):null;
    try{
      var response=await window.fetch(url,{method:'GET',cache:'no-store',credentials:external?'omit':'same-origin',mode:external?'no-cors':'same-origin',redirect:external?'error':'follow',signal:controller?controller.signal:undefined});
      if(external)return{ok:response.ok,status:response.status,body:null};
      var body=await response.json().catch(function(){return null});
      var retryAfter=response.headers&&response.headers.get?response.headers.get('retry-after'):null;
      var seconds=Number(retryAfter),backoff=retryAfter?(Number.isFinite(seconds)?seconds*1000:Date.parse(retryAfter)-Date.now()):0;
      return{ok:response.ok,status:response.status,body:body,retryAfter:Math.max(0,backoff||0)};
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
  async function start(progress,budget){
    var deadline=Date.now()+(budget===undefined?90000:Math.max(0,Math.min(90000,budget))),url=null,wakeRequest=null,nextWakeAt=0,announced=false;
    try{
      // Fast gateway replies must not exhaust an attempt counter before the host
      // has time to start. A failed first School request is recoverable too.
      while(Date.now()<deadline){
        var status=await read('/api/system/core-status',Math.max(1,Math.min(15000,deadline-Date.now())),false);
        var core=status.body&&status.body.core;
        if(status.ok&&status.body.database==='unavailable')throw unavailable('The School data service is unavailable. Your entries are still here. Contact your school administrator.');
        if(status.ok&&core&&core.healthy===true){
          if(announced&&progress)progress('Signing in…');return;
        }
        if(status.ok&&core&&core.retryable===false)throw unavailable(core.message);
        if(status.ok&&core&&core.url!==undefined){
          url=publicHealthUrl(core.url);if(!url)throw unavailable();
        }
        if(!announced){announced=true;if(progress)progress('Connecting to sign-in. Waiting for the service to become ready…')}
        if(Date.now()>=deadline)break;
        if(url&&!wakeRequest&&Date.now()>=nextWakeAt){
          var controller=typeof AbortController==='function'?new AbortController():null;
          // Leave the public request open through a normal cold start. Verify
          // School concurrently; neither an opaque reply nor public availability
          // alone permits sending credentials. Retry a failed wake at most every
          // 30 seconds, only while this interactive sign-in is pending.
          nextWakeAt=Date.now()+30000;
          wakeRequest={controller:controller};
          read(url,Math.max(1,Math.min(60000,deadline-Date.now())),true,controller).then(function(){wakeRequest=null});
        }
        await pause(Math.max(1,Math.min(3000,deadline-Date.now())));
      }
      throw unavailable();
    }finally{if(wakeRequest&&wakeRequest.controller)wakeRequest.controller.abort()}
  }
  async function loadData(url,options){
    options=options||{};
    var deadline=Date.now()+90000,announced=false,lastMessage='School sign-in could not load. Please try again.';
    if(options.core)await window.RevoltSchoolSignIn.ensureReady(options.progress,deadline-Date.now());
    while(Date.now()<deadline){
      var result=await read(url,Math.max(1,Math.min(15000,deadline-Date.now())),false);
      if(result.ok&&result.body!==null&&(!options.valid||options.valid(result.body)))return result.body;
      var message=result.body&&result.body.error&&result.body.error.message||result.body&&result.body.message;
      if(result.body&&result.body.error&&result.body.error.code==='SCHOOL_SIGN_IN_OUTAGE')throw unavailable(message);
      if(!result.ok&&result.status>=400&&result.status<500&&result.status!==429){
        var error=Error(message||'This sign-in link could not be verified. Open the current link from your school record.');error.status=result.status;throw error;
      }
      if(!announced){announced=true;if(options.progress)options.progress('Loading sign-in. Please keep this screen open while the service reconnects…')}
      var delay=Math.max(3000,result.retryAfter||0);
      if(Date.now()+delay>=deadline)break;
      await pause(delay);
    }
    var error=Error(lastMessage);error.status=503;throw error;
  }
  window.RevoltSchoolSignIn={loadData:loadData,ensureReady:function(progress,budget){
    if(pending)return pending;
    pending=start(progress,budget).finally(function(){pending=null});return pending;
  }};
})();
`;
