import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createDb, ensureShopNamespace } from './db.js';
import { ensureShopSchema } from './schema.js';
import { ensureEnterpriseShopSchema } from './enterprise-schema.js';
import { ensureShopOperationsSchema } from './operations-schema.js';
import { clearAuthCookies, loginDemoToCore, loginToCore, setAuthCookies } from './auth.js';
import { registerShopApi } from './routes.js';
import { ensureSalonSchema, registerSalonRoutes } from './salon.js';
import { registerCommercialSalonRoutes } from './commercial.js';
import { registerPaymentWebhook, verifyPaystackReference } from './payments.js';
import { registerEnterpriseShopRoutes, runShopAutomations } from './enterprise.js';
import { registerShopOperationsRoutes, runShopOperationsAutomations } from './operations.js';
import { purgeLegacyShopDemoData } from './legacy-cleanup.js';
import { createDemoCustomerSession, ensureDemoWorkspace } from './demo.js';
import { demoLoginHtml, loginHtml, resetHtml } from './ui.js';

const config=loadConfig();
const db=createDb(config);
const app=Fastify({logger:true,trustProxy:true,bodyLimit:35*1024*1024});
const salonHtml=readFileSync(new URL('../public/salon.html',import.meta.url),'utf8');
const salonStorefrontHtml=readFileSync(new URL('../public/salon-storefront.html',import.meta.url),'utf8');
const customerPortalHtml=readFileSync(new URL('../public/customer-portal.html',import.meta.url),'utf8');
const shopEnterpriseJs=readFileSync(new URL('../public/shop-enterprise.js',import.meta.url),'utf8');
const shopOperationsJs=readFileSync(new URL('../public/shop-operations.js',import.meta.url),'utf8');
const shopGlassCss=readFileSync(new URL('../public/shop-glass.css',import.meta.url),'utf8');
const shopGlassJs=readFileSync(new URL('../public/shop-glass.js',import.meta.url),'utf8');

await app.register(helmet,{contentSecurityPolicy:false});
await app.register(cors,{
  origin:config.CORS_ORIGINS==='*'?true:config.CORS_ORIGINS.split(',').map(x=>x.trim()),
  credentials:true
});
await app.register(rateLimit,{max:400,timeWindow:'1 minute'});

function humanField(path:readonly PropertyKey[]){
  const raw=path.length?String(path[path.length-1]):'field';
  const spaced=raw.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ');
  return spaced.charAt(0).toUpperCase()+spaced.slice(1);
}
function validationMessage(error:ZodError){
  const fieldErrors:Record<string,string>={};
  for(const issue of error.issues){
    const field=issue.path.length?issue.path.join('.'):'request';
    let message=issue.message;
    if(issue.code==='invalid_type'&&(issue as any).received==='undefined')message='This field is required.';
    if(issue.code==='invalid_format'&&(issue as any).format==='email')message='Enter a valid email address.';
    if(issue.code==='too_small'&&(issue as any).minimum!=null)message='Enter at least '+String((issue as any).minimum)+' characters or the required minimum value.';
    fieldErrors[field]=message;
  }
  const first=error.issues[0];
  const label=humanField(first?.path||[]);
  let detail=fieldErrors[first?.path?.join('.')||'request']||first?.message||'Invalid value.';
  if(first?.path?.includes('slug'))detail='Use lowercase letters, numbers and hyphens only, for example: east-legon-salon.';
  return{message:label+': '+detail,fieldErrors,details:error.issues};
}
app.setErrorHandler((error:any,request,reply)=>{
  request.log.error(error);
  if(error instanceof ZodError){
    const v=validationMessage(error);
    return reply.code(400).send({error:{code:'VALIDATION_ERROR',...v}});
  }

  const pgCode=String(error?.code||'');
  if(pgCode==='23505'){
    const constraint=String(error?.constraint||'');
    let message='A record with the same information already exists.';
    if(/public_slug|shops.*slug|ux_shops_public_slug/i.test(constraint))message='A Shop with this name or URL slug already exists. Use a different Shop name or slug.';
    else if(/sku/i.test(constraint))message='This product SKU is already in use for the selected Shop.';
    else if(/customer.*email|portal.*email/i.test(constraint))message='A customer account already exists for this email address.';
    else if(/session/i.test(constraint))message='Another cashier session is already open. Close or hand over the existing session first.';
    return reply.code(409).send({error:{code:'DUPLICATE_RECORD',message,constraint}});
  }
  if(pgCode==='23503'){
    return reply.code(400).send({error:{code:'RELATED_RECORD_INVALID',message:'The selected related record no longer exists or does not belong to this Shop. Refresh the page and choose it again.'}});
  }
  if(pgCode==='23514'){
    return reply.code(400).send({error:{code:'VALUE_NOT_ALLOWED',message:'One of the values entered is outside the allowed range. Review the highlighted information and try again.'}});
  }
  if(pgCode==='22P02'){
    return reply.code(400).send({error:{code:'INVALID_FORMAT',message:'One of the selected values is invalid or has expired. Refresh the page and try again.'}});
  }

  const status=Number(error?.statusCode||500);
  const safeCode=String(error?.code||(
    status===401?'UNAUTHENTICATED':
    status===403?'FORBIDDEN':
    status===404?'NOT_FOUND':
    status===409?'CONFLICT':
    status===428?'PRECONDITION_REQUIRED':
    'REQUEST_ERROR'
  ));
  const message=status>=500
    ? 'The request could not be completed because of a server error. Please try again. If it continues, note the time and contact the system administrator.'
    : String(error?.message||'The request could not be completed.');
  return reply.code(status).send({error:{code:safeCode,message}});
});

await ensureShopNamespace(db);
await ensureShopSchema(db);
await ensureSalonSchema(db);
await ensureEnterpriseShopSchema(db);
await ensureShopOperationsSchema(db);
const cleanup=await purgeLegacyShopDemoData(db);
if(cleanup.removedShops>0)app.log.info(cleanup,'Legacy demo salon data removed');

app.get('/health/live',async()=>({status:'ok',service:'revolt-x-shop'}));
app.get('/health/ready',async(_req,reply)=>{
  try{
    await db.query('SELECT 1');
    const core=await fetch(config.CORE_OS_URL.replace(/\/$/,'')+'/health/ready',{signal:AbortSignal.timeout(5000)}).then(r=>r.ok).catch(()=>false);
    return{status:core?'ready':'degraded',database:'ready',coreOs:core?'ready':'unavailable'};
  }catch{
    return reply.code(503).send({status:'not_ready',database:'unavailable',coreOs:'unknown'});
  }
});

app.get('/assets/shop-glass.css',async(_req,reply)=>reply.type('text/css; charset=utf-8').send(shopGlassCss));
app.get('/assets/shop-glass.js',async(_req,reply)=>reply.type('application/javascript; charset=utf-8').send(shopGlassJs));
app.get('/assets/shop-enterprise.js',async(_req,reply)=>reply.type('application/javascript; charset=utf-8').send(shopEnterpriseJs));
app.get('/assets/shop-operations.js',async(_req,reply)=>reply.type('application/javascript; charset=utf-8').send(shopOperationsJs));
app.get('/login',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(loginHtml()));
app.get('/demo-login',async(_req,reply)=>{
  if(!config.ENABLE_DEMO_LOGIN)return reply.code(404).type('text/plain').send('Demo access is disabled');
  return reply.type('text/html; charset=utf-8').send(demoLoginHtml());
});
app.get('/reset-password',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(resetHtml()));
app.post('/auth/login',async(req,reply)=>{
  const b=z.object({email:z.string().email(),password:z.string().min(1),organisationId:z.string().uuid().optional()}).parse(req.body);
  const tokens=await loginToCore(config,b.email,b.password,b.organisationId);
  setAuthCookies(reply,tokens,config);
  return{ok:true};
});
app.post('/auth/demo',async(req,reply)=>{
  if(!config.ENABLE_DEMO_LOGIN)return reply.code(404).send({error:{message:'Demo access is disabled'}});
  const b=z.object({persona:z.enum(['shop_admin','manager','cashier','service','finance','inventory','auditor'])}).parse(req.body);
  const tokens=await loginDemoToCore(config,b.persona);
  await ensureDemoWorkspace(db,{
    organisationId:tokens.organisationId!,
    userId:tokens.userId,
    persona:b.persona
  });
  setAuthCookies(reply,tokens,config);
  return{ok:true,persona:b.persona,user:{firstName:tokens.firstName,lastName:tokens.lastName,jobTitle:tokens.jobTitle}};
});
app.post('/auth/demo-customer',async(_req,reply)=>{
  if(!config.ENABLE_DEMO_LOGIN)return reply.code(404).send({error:{message:'Demo access is disabled'}});
  // Self-provision the isolated demo organisation/workspace so customer demo access
  // never depends on a staff persona having signed in first.
  const demoOwner=await loginDemoToCore(config,'shop_admin');
  await ensureDemoWorkspace(db,{
    organisationId:demoOwner.organisationId!,
    userId:demoOwner.userId,
    persona:'shop_admin'
  });
  const session=await createDemoCustomerSession(db);
  const secure=config.NODE_ENV==='production';
  reply.header('Set-Cookie','rx_customer_session='+encodeURIComponent(session.token)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(30*86400)+(secure?'; Secure':''));
  return{ok:true,path:session.path,customer:session.customer};
});
app.post('/auth/logout',async(_req,reply)=>{
  clearAuthCookies(reply,config);
  return{ok:true};
});

app.get('/',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(salonHtml));
app.get('/store/:slug',async(req,reply)=>{
  z.string().min(2).max(100).parse((req.params as any).slug);
  return reply.type('text/html; charset=utf-8').send(salonStorefrontHtml);
});
app.get('/customer/:slug',async(req,reply)=>{
  z.string().min(2).max(100).parse((req.params as any).slug);
  return reply.type('text/html; charset=utf-8').send(customerPortalHtml);
});
app.get('/payments/callback',async(req,reply)=>{
  const ref=String((req.query as any)?.reference||'').trim();
  const safeRef=ref.replace(/[<>&"]/g,'');
  let title='Payment submitted',message='Your payment is being confirmed.',status='pending',returnPath='/';
  try{
    if(!ref)throw Object.assign(new Error('Payment reference is missing.'),{statusCode:400});
    const result=await verifyPaystackReference(db,config,ref,null);
    status=result.status;
    if(result.payment?.source==='customer_portal'&&result.publicSlug)returnPath='/customer/'+encodeURIComponent(result.publicSlug);
    if(status==='successful'){
      title='Payment successful';
      message='Your payment has been confirmed. The invoice has been updated and the finance journal has been posted automatically.';
    }else if(status==='review_required'){
      title='Payment needs review';
      message='The provider response did not match the expected invoice amount or currency. The transaction has been held for finance review.';
    }else{
      title='Payment pending';
      message='The provider has not confirmed this payment yet. You can return to the system and verify it again shortly.';
    }
  }catch(error:any){
    title='Payment verification unavailable';
    message=String(error?.message||'The payment could not be verified right now. Please try again from the payment monitor.');
  }
  const badge=status==='successful'?'Paid':status==='review_required'?'Review required':'Pending';
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;background:#f4f7fb;display:grid;place-items:center;min-height:100vh;margin:0;padding:18px}.c{background:white;border:1px solid #dfe7f1;border-radius:20px;padding:32px;max-width:560px;text-align:center;box-shadow:0 24px 70px rgba(20,35,55,.12)}.badge{display:inline-block;padding:7px 12px;border-radius:999px;background:#eef7f4;color:#166457;font-size:12px;font-weight:800;margin-bottom:12px}a{display:inline-flex;margin-top:18px;padding:11px 16px;border-radius:10px;background:#163f46;color:white;text-decoration:none;font-weight:700}.ref{font-family:ui-monospace,monospace;background:#f3f6f8;padding:8px 10px;border-radius:8px}</style><link rel="stylesheet" href="/assets/shop-glass.css?v=20260928-2"><script src="/assets/shop-glass.js?v=20260928-2" defer></script></head><body><div class="c"><div class="badge">${badge}</div><h1>${title}</h1><p>${message}</p><p>Reference: <span class="ref">${safeRef}</span></p><a href="${returnPath}">Return to Revolt-X Shop</a></div></body></html>`);
});

await registerShopApi(app,{db,config});
await registerSalonRoutes(app,{db,config});
await registerCommercialSalonRoutes(app,{db,config});
await registerPaymentWebhook(app,{db,config});
await registerEnterpriseShopRoutes(app,{db,config});
await registerShopOperationsRoutes(app,{db,config});

const automationRun=async()=>{
  try{
    await runShopAutomations(db,config);
    await runShopOperationsAutomations(db);
  }catch(error){
    app.log.error({error},'Shop automation run failed');
  }
};
setTimeout(automationRun,5000).unref();
setInterval(automationRun,10*60*1000).unref();

const close=async()=>{await app.close();await db.end();process.exit(0)};
process.on('SIGTERM',close);
process.on('SIGINT',close);

await app.listen({host:config.HOST,port:config.PORT});
