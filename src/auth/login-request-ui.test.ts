import {it,expect} from 'vitest';
import vm from 'node:vm';
import {osLoginRequestScript} from './login-request-ui.js';
import {osLoginFrontend} from '../login-ui.js';

function fixture(fetch:(url:string,options:any)=>Promise<any>){
  let time=0;const timers=new Map<number,()=>void>();let id=0;
  const context:any={AbortController,Date:{now:()=>time},fetch,
    setTimeout:(fn:()=>void,ms:number)=>{const current=++id;timers.set(current,fn);setImmediate(()=>{if(timers.delete(current)){time+=ms;fn()}});return current},
    clearTimeout:(current:number)=>timers.delete(current)};
  // Network mocks settle before timers; delays still advance the recovery clock.
  vm.runInNewContext(osLoginRequestScript,context);
  return{login:context.requestOsLogin,now:()=>time,context};
}
const credentials={email:'owner@example.test',password:'KeepEnteredPassword123!'};
const account={accessToken:'fixture-access',refreshToken:'fixture-refresh'};
const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status});

it('OS sign-in recovers from a dropped connection and startup HTML with the original credentials',async()=>{
  let calls=0;const f=fixture(async(url,options)=>{
    expect(url).toBe('/v1/auth/login');expect(JSON.parse(options.body)).toEqual(credentials);
    if(++calls===1)throw Error('Connection dropped');
    return calls===2?new Response('<html>Starting</html>'):response(account);
  });expect(await f.login(credentials)).toEqual(account);expect(calls).toBe(3);
});
it('incorrect OS credentials return immediately without an automatic second attempt',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return response({error:{message:'Invalid credentials or inactive account'}},401)});
  await expect(f.login(credentials)).rejects.toThrow('Invalid credentials');expect(calls).toBe(1);
});
it('persistent OS startup failures stop within the recovery deadline',async()=>{
  const f=fixture(async()=>response({},503));await expect(f.login(credentials)).rejects.toThrow('entries are still here');expect(f.now()).toBeLessThanOrEqual(60000);
});
it('OS sign-in honours Retry-After before retrying',async()=>{
  let calls=0;const f=fixture(async()=>++calls===1?new Response('{}',{status:429,headers:{'retry-after':'20'}}):response(account));
  expect(await f.login(credentials)).toEqual(account);expect(f.now()).toBe(20000);
});
it.each([false,true])('the OS login form stores a fresh session and routes password-change-required=%s correctly',async(requiresPasswordChange)=>{
  let calls=0,finish:(value:Response)=>void=()=>{};const f=fixture(async()=>{calls++;return new Promise<Response>(resolve=>{finish=resolve})});
  const elements=new Map<string,any>(),sessions=new Map<string,string>(),redirects:string[]=[];
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,textContent:'',classList:{toggle(){}},focus(){}});return elements.get(id)};
  Object.assign(f.context,{document:{getElementById:element},URLSearchParams,sessionStorage:{removeItem:(key:string)=>sessions.delete(key),setItem:(key:string,value:string)=>sessions.set(key,value)},location:{search:'',replace:(url:string)=>redirects.push(url)}});
  vm.runInNewContext(osLoginFrontend.match(/<script>([\s\S]*?)<\/script>/)![1]!,f.context);
  await element('loginBtn').onclick();expect(calls).toBe(0);
  element('loginEmail').value=credentials.email;element('loginPassword').value=credentials.password;
  const pending=element('loginBtn').onclick();await element('loginBtn').onclick();expect(calls).toBe(1);
  finish(response({...account,requiresPasswordChange}));await pending;
  expect(sessions.get('rx_access')).toBe(account.accessToken);expect(sessions.get('rx_refresh')).toBe(account.refreshToken);expect(redirects).toEqual([requiresPasswordChange?'/change-password':'/']);
});
