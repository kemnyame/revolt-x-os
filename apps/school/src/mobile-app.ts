import {mobileControlCss,mobileControlScript,schoolNavigationScript} from './mobile-navigation.js';
import {mobileManifest,mobileSchoolCookie,androidMobileIntent} from './mobile-binding.js';
import {schoolLocationScript} from './tenant-ui.js';
import {schoolTenantDocument,schoolWorkspaceUrl} from './tenant-ui.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { mobileIcons } from './mobile-icons.js';
import { mobileExperienceCss, mobileExperienceFrontend, mobileExperienceScript, mobileRoleChoiceFrontend } from './mobile-experience.js';
import { mobilePolishCss, mobilePolishScript } from './mobile-polish.js';
import { registerMobilePhoneAuth } from './mobile-phone-auth.js';

/** Mobile presentation reuses the existing authenticated portals and permissions. */
export const schoolMobileCss = mobileControlCss+String.raw`
.rx-mobile-dock{display:none}.rx-connection{display:none;position:fixed;left:12px;right:12px;bottom:90px;z-index:125;padding:12px 16px;border:1px solid #e4c689;border-radius:12px;background:#fff6e4;color:#6d4b12;font-size:13px;box-shadow:0 4px 20px #172a3d15}.rx-connection[data-offline]{display:block}
@media(max-width:760px){
html{scroll-padding-top:86px;scroll-padding-bottom:100px}body{min-height:100dvh}.main,.wrap{padding-bottom:calc(100px + env(safe-area-inset-bottom))!important}.main>header.top{position:sticky;top:0;z-index:45;background:var(--bg);padding-top:calc(12px + env(safe-area-inset-top));min-height:70px}.main>header.top .right .ghost,.main>header.top .row .ghost{min-height:44px}.primary,.ghost,.mini,.danger,.secondary{min-height:44px}.nav button{min-height:48px}.panel{border-radius:16px}.modal{padding:8px;align-items:end}.modalbox,.modal>.box{border-radius:20px 20px 12px 12px;max-height:calc(100dvh - 24px - env(safe-area-inset-top));padding:22px 18px calc(22px + env(safe-area-inset-bottom))}.toast{bottom:calc(90px + env(safe-area-inset-bottom))}.rx-mobile-dock{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:55;gap:4px;padding:9px 10px calc(9px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:#fffffff5;backdrop-filter:blur(16px);box-shadow:0 -5px 24px #172a3d08}.rx-mobile-dock button{display:flex;flex:1;min-width:0;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:54px;padding:5px 3px;background:transparent;color:var(--muted);border:0;border-radius:12px;font-size:10px;font-weight:650}.rx-mobile-dock button[aria-current=page]{background:var(--accent-soft);color:var(--green)}.rx-mobile-dock .rx-icon{width:22px;height:22px}.rx-mobile-dock button:focus-visible{outline:3px solid #4387d2}.rx-nav-open .rx-mobile-dock{visibility:hidden}.rx-dialog-open .rx-mobile-dock{visibility:hidden}
body[data-portal=parent] #portal>.tabs,body[data-portal=student] #portal>.tabs{position:fixed;bottom:0;left:0;right:0;z-index:55;margin:0;gap:4px;padding:10px 8px calc(10px + env(safe-area-inset-bottom));background:#fffffff5;backdrop-filter:blur(16px);box-shadow:0 -5px 24px #172a3d08;border-top:1px solid var(--line);border-bottom:0;scrollbar-width:thin}body[data-portal=parent] #portal>.tabs button,body[data-portal=student] #portal>.tabs button{min-height:48px;font-size:11px;border-radius:10px;padding:9px 13px}body[data-portal=login] .hero{padding:24px 22px}body[data-portal=login] .hero h1{font-size:30px}body[data-portal=login] .hero .brand{margin-bottom:18px}body[data-portal=login] .hero p{display:none}body[data-portal=login] .form-side{padding:26px 22px 40px}body[data-portal=login]>.shell>.brand{min-height:auto;padding:24px!important;gap:12px}body[data-portal=login]>.shell>.brand h1{font-size:27px;margin:8px 0}body[data-portal=login]>.shell>.brand p,body[data-portal=login] .brand-card{display:none}.report-school-head{grid-template-columns:60px 1fr;gap:12px;padding:18px}.report-term{grid-column:1/-1;display:flex;flex-wrap:wrap;text-align:left;border-left:0;padding-left:0}.report-student-grid{grid-template-columns:1fr 1fr;margin:16px}.report-summary{grid-template-columns:repeat(2,minmax(0,1fr));margin:16px}.report-section{margin:18px 16px 0;overflow-x:auto}.report-comments{grid-template-columns:1fr;margin:18px 16px}.report-signatures{gap:12px;margin:32px 16px 0}.report-footer{padding:12px 16px}.report-document-title{padding:12px 16px}.report-attendance{grid-template-columns:repeat(2,minmax(0,1fr))}.report-logo{width:54px;height:54px}.report-school-head h1{font-size:20px}.report-table{min-width:500px}
}
@media print{.rx-mobile-dock,.rx-connection{display:none!important}body[data-portal=parent] #portal>.tabs,body[data-portal=student] #portal>.tabs{display:none!important}.main>header.top{position:static}.main,.wrap{padding-bottom:0!important}}
/* Dedicated phone entry point. The role cards lead to the real sign-in flows. */
.rx-mobile-home{margin:0;background:#f4f7f5;color:#223c32;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.rx-mobile-home *{box-sizing:border-box}.rx-mobile-home a{color:inherit}.rx-mobile-home :focus-visible{outline:3px solid #4387d2;outline-offset:4px}.rx-mobile-home .mobile-wrap{max-width:640px;margin:auto;padding:calc(30px + env(safe-area-inset-top)) 22px calc(40px + env(safe-area-inset-bottom))}.mobile-brand{display:flex;align-items:center;gap:12px;font-weight:750;font-size:17px}.mobile-brand img{width:48px;height:48px;border-radius:14px}.mobile-brand small{display:block;color:#75867c;font-size:11px;font-weight:500}.mobile-kicker{font-size:11px;letter-spacing:.16em;color:#48755c;text-transform:uppercase;font-weight:700;margin:34px 0 12px}.rx-mobile-home h1{font-size:clamp(32px,7vw,46px);letter-spacing:-.045em;line-height:1.15;font-weight:700;margin:0 0 16px}.mobile-intro{color:#6b7d73;margin:0 0 28px;max-width:450px}.mobile-roles{display:grid;gap:12px}.mobile-role{display:flex;align-items:center;gap:16px;background:white;border:1px solid #dfe9e2;border-radius:18px;padding:19px;text-decoration:none;min-height:92px;box-shadow:0 4px 16px #12321f03;transition:border-color .15s,transform .15s}.mobile-role:hover{border-color:#9bbea7;transform:translateY(-2px)}.mobile-role .role-icon{display:grid;place-items:center;width:48px;height:48px;flex-shrink:0;background:#edf5ef;color:#24634e;border-radius:14px}.mobile-role:nth-child(2) .role-icon{background:#eef1fc;color:#55669c}.mobile-role:nth-child(3) .role-icon{background:#fff3e5;color:#a07434}.mobile-role:nth-child(4) .role-icon{background:#f2edfa;color:#7e609c}.mobile-role svg{width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.mobile-role strong{display:block;font-size:16px}.mobile-role small{display:block;color:#75867c;font-size:12px;margin-top:3px}.mobile-role .arrow{margin-left:auto;color:#9bb0a2;font-size:24px}.mobile-note{color:#728279;font-size:12px;margin:24px 0;text-align:center}.mobile-extra{display:flex;justify-content:center;gap:18px;font-size:13px}.mobile-save{margin-top:30px;padding:20px;background:#e8f1eb;border:1px solid #d7e7db;border-radius:16px}.mobile-save summary{cursor:pointer;font-weight:650;min-height:44px;display:flex;align-items:center}.mobile-save p{font-size:13px;color:#587062}.mobile-save button{background:#24634e;color:white;border:0;border-radius:10px;padding:13px 18px;font:inherit;font-size:13px;min-height:46px;cursor:pointer}.mobile-save button[hidden]{display:none}.mobile-foot{margin-top:30px;text-align:center;color:#8a9a90;font-size:11px}.rx-mobile-home .rx-connection{bottom:16px}.rx-mobile-home .offline-retry{display:inline-block;background:#24634e;color:white;border-radius:12px;padding:14px 24px;text-decoration:none}
`;

export const schoolMobileScript = schoolNavigationScript+schoolLocationScript+mobileControlScript+String.raw`
(function(){
'use strict';
var connection=document.createElement('div');connection.className='rx-connection';connection.setAttribute('role','status');connection.setAttribute('aria-live','polite');connection.textContent='You are offline. Reconnect to load records or save changes.';document.body.appendChild(connection);
function updateConnection(){connection.toggleAttribute('data-offline',!navigator.onLine)}
addEventListener('online',updateConnection);addEventListener('offline',updateConnection);updateConnection();
if('serviceWorker' in navigator&&window.isSecureContext){navigator.serviceWorker.register('/school-sw.js',{scope:'/',updateViaCache:'none'}).catch(function(){/* Browser use remains available without installation support. */})}
var school=document.body.dataset.schoolId||schoolFromLocation();
if(school){try{localStorage.setItem('rx_mobile_school',school);localStorage.setItem('rx_school_id',school)}catch(e){}}
else if(location.pathname.startsWith('/mobile')&&recoverSchoolLocation('teacher'))return;
if(/^\/mobile\/?$/.test(location.pathname)&&window.rxSchoolHistory){window.rxSchoolHistory.bind({home:'account-type',restore:function(){}});window.rxMobileBack=function(){return window.rxSchoolHistory.back()}}
var manifest=document.querySelector('link[rel=manifest]');if(school&&manifest)manifest.setAttribute('href','/school.webmanifest?school='+encodeURIComponent(school));
if(school)document.querySelectorAll('[data-mobile-role]').forEach(function(a){var url=new URL(a.getAttribute('href'),location.origin);url.searchParams.set('school',school);a.href=url.pathname+url.search});
var installButton=document.getElementById('mobileInstall'),installEvent=null;
addEventListener('beforeinstallprompt',function(e){if(!installButton)return;e.preventDefault();installEvent=e;installButton.hidden=false});
if(installButton)installButton.addEventListener('click',async function(){if(!installEvent)return;installButton.disabled=true;try{await installEvent.prompt();var choice=await installEvent.userChoice;if(choice.outcome==='accepted')installButton.hidden=true}finally{installEvent=null;installButton.hidden=true;installButton.disabled=false}});
addEventListener('appinstalled',function(){if(installButton)installButton.hidden=true});
var nav=document.getElementById('nav'),main=document.querySelector('.main');
if(nav&&main){
 var dock=document.createElement('nav');dock.className='rx-mobile-dock';dock.setAttribute('aria-label','Quick navigation');main.appendChild(dock);
 function buildDock(){
  var available=Array.from(nav.querySelectorAll('button[data-p]')).filter(function(b){return !b.disabled&&!b.hidden&&!b.classList.contains('hide')});
  var desired=document.body.dataset.portal==='teacher'?['dashboard','attendance','homework']:['dashboard','students','fees'];
  var chosen=desired.map(function(p){return available.find(function(b){return b.dataset.p===p})}).filter(Boolean);
  available.forEach(function(b){if(chosen.length<3&&chosen.indexOf(b)<0)chosen.push(b)});
  dock.replaceChildren();
  chosen.forEach(function(source){var b=document.createElement('button');b.type='button';var label=source.textContent.trim();b.setAttribute('aria-label',label);b.setAttribute('aria-current',source.classList.contains('active')?'page':'false');var svg=source.querySelector('svg');if(svg)b.appendChild(svg.cloneNode(true));var text=document.createElement('span');text.textContent=source.dataset.p==='dashboard'?'Home':label;b.appendChild(text);b.addEventListener('click',function(){source.click();window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})});dock.appendChild(b)});
  if(available.length){var more=document.createElement('button');more.type='button';more.setAttribute('aria-label','All school modules');more.innerHTML='<svg class="rx-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>More</span>';more.addEventListener('click',function(){var menu=document.querySelector('.rx-menu');if(menu)menu.click()});dock.appendChild(more)}
  dock.hidden=!available.length;
 }
 var queued=false;new MutationObserver(function(){if(queued)return;queued=true;requestAnimationFrame(function(){queued=false;buildDock()})}).observe(nav,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden','disabled']});buildDock();
}
})();
`;

/** Network-only: no credentials, student records, HTML or mutations are cached. */
export const schoolServiceWorker = String.raw`
const OFFLINE='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revolt School · Offline</title><style>body{margin:0;padding:64px 24px;background:#f4f7f5;color:#223c32;font:16px/1.6 system-ui}main{max-width:420px;margin:auto}h1{line-height:1.2}button,a{display:inline-block;padding:14px 20px;border-radius:12px;background:#24634e;color:white;border:0;font:inherit;text-decoration:none;margin:8px 8px 0 0}p{color:#63776b}</style></head><body><main><p>REVOLT-X SCHOOL</p><h1>Let us get you reconnected.</h1><p>An internet connection is needed to sign in, load school records and save changes.</p><p>No offline changes or payments have been queued.</p><button onclick="location.reload()">Try again</button><a href="/mobile">School home</a></main></body></html>';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||event.request.mode!=='navigate')return;
 event.respondWith(fetch(event.request).catch(()=>new Response(OFFLINE,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})));
});
`;

export const schoolMobileVersion=createHash('sha256').update(schoolMobileCss+mobilePolishCss+schoolMobileScript+mobilePolishScript+schoolServiceWorker).digest('hex').slice(0,12);
const polishHead=`<link rel="stylesheet" href="/school-polish.css?v=${schoolMobileVersion}"><script src="/school-polish.js?v=${schoolMobileVersion}" defer></script>`;
export const schoolMobileHead=`<link rel="manifest" href="/school.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Revolt School"><link rel="apple-touch-icon" href="/school-icon-192.png"><link rel="icon" type="image/png" href="/school-icon-192.png"><link rel="stylesheet" href="/school-mobile.css?v=${schoolMobileVersion}"><script src="/school-mobile.js?v=${schoolMobileVersion}" defer></script>${polishHead}`;

export const schoolMobileManifest={id:'/mobile',name:'Revolt-X School',short_name:'Revolt School',description:'A focused mobile app for teachers and parents.',lang:'en',start_url:'/mobile',scope:'/mobile',display:'standalone',background_color:'#f6f7f3',theme_color:'#24634e',prefer_related_applications:false,icons:[{src:'/school-icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'/school-icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}],shortcuts:[{name:'Teacher app',url:'/mobile/teacher'},{name:'Parent app',url:'/mobile/parent'}]};

export { mobileRoleChoiceFrontend as schoolMobileFrontend };

export async function registerSchoolMobile(app:FastifyInstance,options?:{resolveSchool:(request:any)=>Promise<{tenant_slug:string;school_name:string}|null>;assertAccess?:(school:any)=>Promise<void>}){
 async function page(request:any,reply:any,html:string,resolvedSchool?:any){
  const school=resolvedSchool??await options?.resolveSchool(request);
  if(school){
   await options?.assertAccess?.(school);
   reply.header('set-cookie',mobileSchoolCookie(request,school));
   if(!request.query?.school)return reply.redirect(schoolWorkspaceUrl(school.tenant_slug,String(request.url).split('?')[0]));
   html=schoolTenantDocument(html,school);
   for(const path of ['/mobile/teacher','/mobile/parent'])html=html.replaceAll('href="'+path+'"','href="'+schoolWorkspaceUrl(school.tenant_slug,path)+'"');
  }
  return reply.header('cache-control','no-store').type('text/html; charset=utf-8').send(html.replace('</head>','<link rel="stylesheet" href="/school-mobile.css?v='+schoolMobileVersion+'"><script src="/school-mobile.js?v='+schoolMobileVersion+'" defer></script>'+polishHead+'</head>'));
 }
 await registerMobilePhoneAuth(app);
 for(const path of ['/mobile','/mobile/'])app.get(path,async(request,reply)=>page(request,reply,mobileRoleChoiceFrontend));
 for(const role of ['teacher','parent'] as const)app.get('/mobile/'+role,async(request,reply)=>page(request,reply,mobileExperienceFrontend(role)));
 app.get('/school-native.css',async(_request,reply)=>reply.header('cache-control','public, max-age=3600').type('text/css; charset=utf-8').send(mobileExperienceCss));
 app.get('/school-native.js',async(_request,reply)=>reply.header('cache-control','public, max-age=3600').type('application/javascript; charset=utf-8').send(mobileExperienceScript));
 app.get('/school-polish.css',async(_request,reply)=>reply.header('cache-control','public, max-age=3600').type('text/css; charset=utf-8').send(mobilePolishCss));
 app.get('/school-polish.js',async(_request,reply)=>reply.header('cache-control','public, max-age=3600').type('application/javascript; charset=utf-8').send(mobilePolishScript));
 app.get('/school.webmanifest',async(request,reply)=>{
  const school=await options?.resolveSchool(request);if(school)await options?.assertAccess?.(school);
  return reply.header('cache-control','private, no-store').header('vary','Cookie').type('application/manifest+json').send(mobileManifest(schoolMobileManifest,school));
 });
 app.get('/mobile/setup',async(request:any,reply)=>{
  const school=await options?.resolveSchool(request);
  if(!school)return reply.redirect('/mobile');
  const safe=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const android=androidMobileIntent(school.tenant_slug),home=schoolWorkspaceUrl(school.tenant_slug,'/mobile');
  return page(request,reply,'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/school.webmanifest"><title>Set up Revolt School</title></head><body><main class="m-app" style="max-width:600px;margin:auto;padding:32px;font-family:system-ui"><h1>'+safe(school.school_name)+'</h1><h2>Set up the mobile app</h2><p>This invitation connects this device to your school. Your usual sign-in details are required to access records.</p><p><a href="'+safe(android)+'">Open installed Android app</a></p><p><a href="'+safe(home)+'">Continue in browser</a></p><button id="mobileInstall" type="button" hidden>Install School app</button><p>On iPhone or iPad, choose Share, then Add to Home Screen after continuing in your browser.</p></main></body></html>',school);
 });
 app.get('/school-mobile.css',async(_request,reply)=>reply.header('cache-control','public, max-age=3600').type('text/css; charset=utf-8').send(schoolMobileCss));
 app.get('/school-mobile.js',async(_request,reply)=>reply.header('cache-control','public, max-age=3600').type('application/javascript; charset=utf-8').send(schoolMobileScript));
 app.get('/school-sw.js',async(_request,reply)=>reply.header('cache-control','no-cache').header('service-worker-allowed','/').type('application/javascript; charset=utf-8').send(schoolServiceWorker));
 for(const size of [192,512] as const)app.get(`/school-icon-${size}.png`,async(_request,reply)=>reply.header('cache-control','public, max-age=86400').type('image/png').send(Buffer.from(mobileIcons[size],'base64')));
}
