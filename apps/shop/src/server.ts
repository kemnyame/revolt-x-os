import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createDb, ensureShopNamespace } from './db.js';
import { ensureShopSchema } from './schema.js';
import { clearAuthCookies, loginToCore, setAuthCookies } from './auth.js';
import { registerShopApi } from './routes.js';
import { ensureSalonSchema, registerSalonRoutes } from './salon.js';
import { registerCommercialSalonRoutes } from './commercial.js';
import { registerPaymentWebhook } from './payments.js';
import { purgeLegacyShopDemoData } from './legacy-cleanup.js';
import { loginHtml, resetHtml } from './ui.js';

const config=loadConfig();
const db=createDb(config);
const app=Fastify({logger:true,trustProxy:true});
const salonHtml=readFileSync(new URL('../public/salon.html',import.meta.url),'utf8');
const salonStorefrontHtml=readFileSync(new URL('../public/salon-storefront.html',import.meta.url),'utf8');

await app.register(helmet,{contentSecurityPolicy:false});
await app.register(cors,{
  origin:config.CORS_ORIGINS==='*'?true:config.CORS_ORIGINS.split(',').map(x=>x.trim()),
  credentials:true
});
await app.register(rateLimit,{max:400,timeWindow:'1 minute'});

app.setErrorHandler((error,request,reply)=>{
  request.log.error(error);
  if(error instanceof ZodError){
    return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Please check the information entered.',details:error.issues}});
  }
  const status=(error as any).statusCode||500;
  const message=status>=500?'The request could not be completed. Please try again.':(error as Error).message;
  return reply.code(status).send({error:{code:status===401?'UNAUTHENTICATED':status===403?'FORBIDDEN':'REQUEST_ERROR',message}});
});

await ensureShopNamespace(db);
await ensureShopSchema(db);
await ensureSalonSchema(db);
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

app.get('/login',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(loginHtml()));
app.get('/reset-password',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(resetHtml()));
app.post('/auth/login',async(req,reply)=>{
  const b=z.object({email:z.string().email(),password:z.string().min(1),organisationId:z.string().uuid().optional()}).parse(req.body);
  const tokens=await loginToCore(config,b.email,b.password,b.organisationId);
  setAuthCookies(reply,tokens,config);
  return{ok:true};
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
app.get('/payments/callback',async(req,reply)=>{
  const ref=String((req.query as any)?.reference||'');
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment received</title><style>body{font-family:system-ui;background:#f4f7fb;display:grid;place-items:center;min-height:100vh;margin:0}.c{background:white;border:1px solid #dfe7f1;border-radius:18px;padding:30px;max-width:520px;text-align:center}a{color:#2563eb}</style></head><body><div class="c"><h1>Payment submitted</h1><p>Your payment reference is <b>${ref.replace(/[<>&"]/g,'')}</b>.</p><p>The final status is confirmed by the payment provider and reflected in the salon payment monitor.</p><a href="/">Return to Revolt-X Shop</a></div></body></html>`);
});

await registerShopApi(app,{db,config});
await registerSalonRoutes(app,{db,config});
await registerCommercialSalonRoutes(app,{db,config});
await registerPaymentWebhook(app,{db,config});

const close=async()=>{await app.close();await db.end();process.exit(0)};
process.on('SIGTERM',close);
process.on('SIGINT',close);

await app.listen({host:config.HOST,port:config.PORT});
