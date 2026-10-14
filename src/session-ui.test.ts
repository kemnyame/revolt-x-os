import {it} from 'vitest';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {osSessionScript} from './session-ui.js';
import {osLoginFrontend} from './login-ui.js';

function browser(respond:any,initial:Record<string,string>={rx_access:'old-access',rx_refresh:'old-refresh'}){
  const storage=new Map(Object.entries(initial)),calls:any[]=[],redirects:string[]=[],timers=new Map<number,()=>void>();
  let clock=Date.now(),id=0;
  class Clock extends Date{static override now(){return clock}}
  const context:any={URL,URLSearchParams,Request,Headers,Date:Clock,
    location:{origin:'https://os.example.test',href:'https://os.example.test/',replace:(url:string)=>redirects.push(url)},
    sessionStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
    setTimeout:(fn:()=>void)=>{timers.set(++id,fn);return id},clearTimeout:(key:number)=>timers.delete(key),
    fetch:async(input:any,options:any)=>{const url=typeof input==='string'?input:input.url;const headers=new Headers(options?.headers||input.headers);calls.push({url,headers});return respond(url,headers,input,options)}};
  context.window=context;vm.runInNewContext(osSessionScript,context);
  return{storage,calls,redirects,fetch:context.fetch,advance:(ms:number)=>{clock+=ms;const callbacks=[...timers.values()];timers.clear();for(const fn of callbacks)fn()}};
}
const json=(body:any={},status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});

it('expired OS refresh clears credentials and redirects once during concurrent requests',async()=>{
  const b=browser(()=>json({},401),{rx_access:'old',rx_refresh:'expired',rx_report_org:'keep'});
  await Promise.allSettled([b.fetch('/v1/organisation'),b.fetch('/v1/operations')]);
  assert.deepEqual(b.redirects,['/login?expired=1']);assert.equal(b.storage.has('rx_access'),false);assert.equal(b.storage.has('rx_refresh'),false);assert.equal(b.storage.get('rx_report_org'),'keep');
  assert.equal(b.calls.filter(c=>c.url==='/v1/auth/refresh').length,1);
});
it('OS requests without a refresh token return to login after authentication expires',async()=>{
  const b=browser(()=>json({},401),{rx_access:'expired'});
  await assert.rejects(b.fetch('/v1/organisation'),{status:401});assert.deepEqual(b.redirects,['/login?expired=1']);assert.equal(b.calls.length,1);
});
it('a valid OS refresh is shared and each failed request retries once with the renewed token',async()=>{
  const b=browser((url:string,headers:Headers)=>url==='/v1/auth/refresh'?json({accessToken:'new',refreshToken:'rotated'}):json({},headers.get('authorization')==='Bearer new'?200:401));
  const responses=await Promise.all([b.fetch('/v1/organisation'),b.fetch('/v1/operations')]);
  assert.ok(responses.every(r=>r.ok));assert.equal(b.calls.filter(c=>c.url==='/v1/auth/refresh').length,1);assert.equal(b.storage.get('rx_refresh'),'rotated');assert.equal(b.redirects.length,0);
});
it('an OS request still rejected after renewal redirects instead of refreshing recursively',async()=>{
  const b=browser((url:string)=>url==='/v1/auth/refresh'?json({accessToken:'new',refreshToken:'rotated'}):json({},401));
  await assert.rejects(b.fetch('/v1/organisation'),{status:401});assert.equal(b.calls.length,3);assert.deepEqual(b.redirects,['/login?expired=1']);
});
it('temporary OS refresh failures retain credentials for a safe retry',async()=>{
  const b=browser((url:string)=>json({},url==='/v1/auth/refresh'?503:401));
  await assert.rejects(b.fetch('/v1/organisation'),{status:503});assert.equal(b.redirects.length,0);assert.equal(b.storage.get('rx_access'),'old-access');assert.equal(b.storage.get('rx_refresh'),'old-refresh');
});
it('OS permission, service and public login errors do not end an authenticated session',async()=>{
  for(const [url,status] of [['/v1/organisation',403],['/v1/organisation',503],['/v1/auth/login',401],['https://provider.example.test/payments',401]] as const){
    const b=browser(()=>json({},status));assert.equal((await b.fetch(url)).status,status);assert.equal(b.redirects.length,0);assert.equal(b.storage.get('rx_access'),'old-access');
  }
});
it('the OS session deadline returns an idle dashboard to login without network polling',async()=>{
  const b=browser(()=>json({},200,{'x-revolt-session-expires-at':new Date(Date.now()+10000).toISOString()}));
  await b.fetch('/v1/organisation');b.advance(11000);assert.deepEqual(b.redirects,['/login?expired=1']);assert.equal(b.calls.length,1);
});
it('retriable Request bodies survive the OS authentication refresh',async()=>{
  const bodies:string[]=[];
  const b=browser(async(url:string,headers:Headers,input:Request)=>{if(url==='/v1/auth/refresh')return json({accessToken:'new',refreshToken:'rotated'});bodies.push(await input.text());return json({},headers.get('authorization')==='Bearer new'?200:401)});
  const response=await b.fetch(new Request('https://os.example.test/v1/operations',{method:'POST',body:JSON.stringify({name:'test only'})}));
  assert.equal(response.status,200);assert.deepEqual(bodies,['{"name":"test only"}','{"name":"test only"}']);
});
it('the OS login screen explains expiry and clears the old deadline after successful sign-in',async()=>{
  const elements=new Map<string,any>(),storage=new Map([['rx_os_session_expires_at','old-expired-time']]),redirects:string[]=[];
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',innerHTML:''});return elements.get(id)};
  const context={document:{getElementById:element},URLSearchParams,AbortController,Date,setTimeout,clearTimeout,location:{search:'?expired=1',replace:(url:string)=>redirects.push(url)},
    sessionStorage:{setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
    fetch:async()=>json({accessToken:'fresh-access',refreshToken:'fresh-refresh'})};
  vm.runInNewContext(osLoginFrontend.match(/<script>([\s\S]*?)<\/script>/)![1]!,context);
  assert.match(element('message').innerHTML,/Your session expired/);element('loginEmail').value='owner@example.test';element('loginPassword').value='test-only-password';await element('loginBtn').onclick();
  assert.equal(storage.has('rx_os_session_expires_at'),false);assert.equal(storage.get('rx_access'),'fresh-access');assert.deepEqual(redirects,['/']);
});
