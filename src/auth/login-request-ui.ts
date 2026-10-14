/** Retry only connection/gateway failures. A rejected password is final for this
 * attempt, and an in-flight login never submits the same credentials twice. */
export const osLoginRequestScript = String.raw`
async function requestOsLogin(credentials,progress){
  var deadline=Date.now()+60000;
  while(Date.now()<deadline){
    var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},Math.min(15000,deadline-Date.now()));
    var response=null,body=null,delay=3000;
    try{
      response=await fetch('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(credentials),signal:controller.signal});
      body=await response.json().catch(function(){return null});
    }catch(error){}finally{clearTimeout(timer)}
    if(response&&response.ok&&body&&typeof body.accessToken==='string'&&typeof body.refreshToken==='string')return body;
    if(response&&!response.ok&&response.status>=400&&response.status<500&&response.status!==429){
      throw Error(body&&body.error&&body.error.message||'Sign in failed. Check your email and password.');
    }
    if(response&&response.headers){
      var value=response.headers.get('retry-after'),seconds=Number(value);
      if(value)delay=Math.max(delay,Number.isFinite(seconds)?seconds*1000:Date.parse(value)-Date.now());
    }
    if(progress)progress('Reconnecting to OS. Please keep this screen open…');
    if(Date.now()+delay>=deadline)break;
    await new Promise(function(resolve){setTimeout(resolve,delay)});
  }
  throw Error('The OS sign-in service is unavailable. Your entries are still here. Please try again.');
}
`;
