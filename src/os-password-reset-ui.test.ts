import {expect,it} from 'vitest';
import vm from 'node:vm';
import {osLoginFrontend} from './login-ui.js';
import {osPasswordResetFrontend} from './os-password-reset-ui.js';
function harness(html:string,search='',fetchImpl:any=async()=>new Response('{"reset":true}')){
  const elements=new Map<string,any>(),stored=new Map([['rx_access','stale'],['rx_refresh','stale'],['rx_os_session_expires_at','stale'],['rx_school_token','school-current']]);
  const E=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',hidden:false,disabled:false,type:'password',classList:{toggle(){}},focus(){},replaceChildren(...items:any[]){this.children=items},click(){return this.onclick?.()}});return elements.get(id)};
  const location={search,replaced:'',replace(path:string){this.replaced=path}},history={replaced:'',replaceState(_state:any,_title:string,path:string){this.replaced=path}};
  const context={document:{getElementById:E,createElement:()=>({textContent:'',className:''})},URLSearchParams,location,history,sessionStorage:{setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)},fetch:fetchImpl};
  const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];for(const script of scripts)vm.runInNewContext(script[1]!,context);
  return{E,location,history,stored};
}
it('OS recovery requests only email and offers an actionable result without changing any session',async()=>{
  let payload:any,path='';const h=harness(osLoginFrontend,'',async(url:string,init:any)=>{path=url;payload=JSON.parse(init.body);return new Response('{"accepted":true}')});
  h.E('loginEmail').value='owner@example.test';h.E('forgotBtn').onclick();expect(h.E('recoveryEmail').value).toBe('owner@example.test');await h.E('recoveryBtn').onclick();
  expect(path).toBe('/v1/auth/password-reset/request');expect(payload).toEqual({email:'owner@example.test'});expect(h.E('message').innerHTML).toContain('If this email belongs');expect(h.location.replaced).toBe('');expect(h.stored.get('rx_access')).toBe('stale');
});
it('OS reset validates matching passwords and scope, hides the token from history and clears only OS credentials',async()=>{
  let payload:any,calls=0;const token='t'.repeat(43),h=harness(osPasswordResetFrontend,'?token='+token,async(_url:string,init:any)=>{calls++;payload=JSON.parse(init.body);return new Response('{"reset":true}')});
  expect(h.history.replaced).toBe('/password-reset');h.E('newPassword').value='NewOsPersonalPass123';h.E('confirmPassword').value='DifferentOsPass123';await h.E('resetForm').onsubmit({preventDefault(){}});expect(calls).toBe(0);
  h.E('confirmPassword').value=h.E('newPassword').value;await h.E('resetForm').onsubmit({preventDefault(){}});expect(payload).toEqual({token,password:'NewOsPersonalPass123',purpose:'account'});expect(h.location.replaced).toBe('/login?passwordReset=1');expect(h.stored.has('rx_access')).toBe(false);expect(h.stored.has('rx_refresh')).toBe(false);expect(h.stored.get('rx_school_token')).toBe('school-current');
});
it('invalid links and expired responses leave password recovery on screen',async()=>{
  expect(harness(osPasswordResetFrontend).E('resetForm').hidden).toBe(true);
  const h=harness(osPasswordResetFrontend,'?token='+'t'.repeat(43),async()=>new Response('{}',{status:401}));h.E('newPassword').value=h.E('confirmPassword').value='NewOsPersonalPass123';await h.E('resetForm').onsubmit({preventDefault(){}});
  expect(h.location.replaced).toBe('');expect(h.E('resetMessage').children[0].textContent).toContain('expired');expect(h.E('resetBtn').disabled).toBe(false);
});
