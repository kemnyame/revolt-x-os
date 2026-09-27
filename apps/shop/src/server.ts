import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { ensureShopSchema } from './schema.js';
import { clearAuthCookies, loginToCore, setAuthCookies, resetCorePasswordAsSystem } from './auth.js';
import { registerShopApi } from './routes.js';
import { appHtml, loginHtml, resetHtml, storefrontHtml } from './ui.js';

const config=loadConfig();
const db=createDb(config);
const app=Fastify({logger:true,trustProxy:true});

await app.register(helmet,{contentSecurityPolicy:false});
await app.register(cors,{
  origin:config.CORS_ORIGINS==='*'?true:config.CORS_ORIGINS.split(',').map(x=>x.trim()),
  credentials:true
});
await app.register(rateLimit,{max:600,timeWindow:'1 minute'});

app.setErrorHandler((error,request,reply)=>{
  request.log.error(error);
  if(error instanceof ZodError){
    return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Please check the information entered.',details:error.issues}});
  }
  const status=(error as any).statusCode||500;
  const message=status>=500?'The request could not be completed. Please try again.':(error as Error).message;
  return reply.code(status).send({error:{code:status===401?'UNAUTHENTICATED':status===403?'FORBIDDEN':'REQUEST_ERROR',message}});
});

app.get('/health/live',async()=>({status:'ok',service:'revolt-x-shop'}));
app.get('/health/ready',async(_req,reply)=>{
  try{await db.query('SELECT 1');return{status:'ready',database:'ready',coreOs:config.CORE_OS_URL};}
  catch{return reply.code(503).send({status:'not_ready',database:'unavailable'});}
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

app.get('/',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(appHtml()));
app.get('/store/:slug',async(req,reply)=>{
  const slug=z.string().min(2).max(100).parse((req.params as any).slug);
  return reply.type('text/html; charset=utf-8').send(storefrontHtml(slug));
});
app.get('/payments/callback',async(req,reply)=>{
  const ref=String((req.query as any)?.reference||'');
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment received</title><style>body{font-family:system-ui;background:#f4f7fb;display:grid;place-items:center;min-height:100vh;margin:0}.c{background:white;border:1px solid #dfe7f1;border-radius:18px;padding:30px;max-width:520px;text-align:center}a{color:#2563eb}</style></head><body><div class="c"><h1>Payment submitted</h1><p>Your payment reference is <b>${ref.replace(/[<>&"]/g,'')}</b>.</p><p>The shop will confirm the final transaction status automatically or from its payment monitor.</p><a href="/">Return to Revolt-X Shop</a></div></body></html>`);
});

await registerShopApi(app,{db,config});
await ensureShopSchema(db);

async function applyBootstrapCredentials(){
  const key='credentials:'+config.BOOTSTRAP_CREDENTIALS_VERSION;
  const done=await db.query('SELECT 1 FROM shop_bootstrap_state WHERE key=$1',[key]);
  if(done.rowCount)return;
  const pairs=[
    [config.SHOP_BOOTSTRAP_EMAIL,config.SHOP_BOOTSTRAP_PASSWORD],
    [config.OS_BOOTSTRAP_EMAIL,config.OS_BOOTSTRAP_PASSWORD]
  ].filter((x):x is [string,string]=>Boolean(x[0]&&x[1]));
  if(!pairs.length)return;
  for(let attempt=1;attempt<=8;attempt++){
    try{
      for(const [email,password] of pairs)await resetCorePasswordAsSystem(config,email,password);
      await db.query('INSERT INTO shop_bootstrap_state(key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
      app.log.info({accounts:pairs.map(x=>x[0]),version:config.BOOTSTRAP_CREDENTIALS_VERSION},'Bootstrap credentials applied');
      return;
    }catch(error){
      app.log.warn({attempt,error},'Bootstrap credential reset waiting for Core OS');
      await new Promise(resolve=>setTimeout(resolve,Math.min(15000,attempt*2000)));
    }
  }
  app.log.error('Bootstrap credentials could not be applied after retries');
}

const close=async()=>{await app.close();await db.end();process.exit(0)};
process.on('SIGTERM',close);
process.on('SIGINT',close);

await app.listen({host:config.HOST,port:config.PORT});
void applyBootstrapCredentials();
