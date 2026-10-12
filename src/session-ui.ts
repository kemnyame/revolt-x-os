/** Shared by the OS workspace and commercial portal, including file downloads. */
export const osSessionScript=String.raw`
(function(){
  var originalFetch=window.fetch.bind(window),refreshInFlight=null,redirecting=false,deadline=0,timer=null;
  function expired(){var error=Error('Your session expired. Please sign in again.');error.status=401;return error}
  function endSession(){
    if(redirecting)return;redirecting=true;clearTimeout(timer);
    sessionStorage.removeItem('rx_access');sessionStorage.removeItem('rx_refresh');sessionStorage.removeItem('rx_os_session_expires_at');
    location.replace('/login?expired=1');
  }
  function armDeadline(value){
    var time=Date.parse(value||'');if(!Number.isFinite(time))return;
    deadline=time;sessionStorage.setItem('rx_os_session_expires_at',String(time));clearTimeout(timer);
    function check(){var remaining=deadline-Date.now();if(remaining<=0){endSession();return}timer=setTimeout(check,Math.min(remaining,86400000))}
    check();
  }
  async function refreshSession(){
    if(refreshInFlight)return refreshInFlight;
    refreshInFlight=(async function(){
      var refresh=sessionStorage.getItem('rx_refresh');
      if(!refresh){endSession();throw expired()}
      var response=await originalFetch('/v1/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:refresh})});
      if(response.status===401){endSession();throw expired()}
      if(!response.ok){var error=Error('The OS service could not renew your session. Please retry.');error.status=response.status;throw error}
      var result=await response.json();
      if(!result.accessToken||!result.refreshToken){var error=Error('The OS service returned an incomplete session. Please retry.');error.status=503;throw error}
      if(redirecting)throw expired();
      sessionStorage.setItem('rx_access',result.accessToken);sessionStorage.setItem('rx_refresh',result.refreshToken);
      return result.accessToken;
    })();
    try{return await refreshInFlight}finally{refreshInFlight=null}
  }
  function request(input,options,access){
    var headers=new Headers(options&&options.headers||(input instanceof Request?input.headers:undefined));
    if(access)headers.set('authorization','Bearer '+access);
    var init=Object.assign({},options||{},{headers:headers});
    return input instanceof Request?[new Request(input.clone(),init)]:[input,init];
  }
  window.fetch=async function(input,options){
    var url=new URL(typeof input==='string'?input:input.url||String(input),location.href);
    var protectedCall=url.origin===location.origin&&url.pathname.indexOf('/v1/')===0&&
      (!url.pathname.startsWith('/v1/auth/')||url.pathname==='/v1/auth/context'||url.pathname==='/v1/auth/logout');
    if(!protectedCall)return originalFetch(input,options);
    if(redirecting)throw expired();
    if(deadline&&deadline<=Date.now()){endSession();throw expired()}
    var access=sessionStorage.getItem('rx_access')||'';
    var response=await originalFetch.apply(null,request(input,options,access));
    if(response.status===401){
      // Parallel requests share one refresh. A late 401 uses the token already renewed by another request.
      var current=sessionStorage.getItem('rx_access')||'';
      if(current===access)await refreshSession();
      if(redirecting)throw expired();
      response=await originalFetch.apply(null,request(input,options,sessionStorage.getItem('rx_access')||''));
      if(response.status===401){endSession();throw expired()}
    }
    if(!redirecting&&response.ok)armDeadline(response.headers.get('x-revolt-session-expires-at'));
    return response;
  };
  window.rxSessionGuard={expire:endSession};
  var saved=Number(sessionStorage.getItem('rx_os_session_expires_at'));
  if(saved&&sessionStorage.getItem('rx_access'))armDeadline(new Date(saved).toISOString());
})();
`;
