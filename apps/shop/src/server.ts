import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import bcrypt from 'bcryptjs';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { ensureShopSchema } from './schema.js';
import { clearAuthCookies, loginToCore, setAuthCookies } from './auth.js';
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

async function ensureCoreOwnerAccount(email:string,password:string,firstName:string,lastName:string){
  const hash=await bcrypt.hash(password,12);
  await db.query('BEGIN');
  try{
    let org=await db.query("SELECT id FROM revolt_x_os.organisations WHERE slug='kem-company' LIMIT 1");
    if(!org.rowCount){
      org=await db.query("INSERT INTO revolt_x_os.organisations(slug,name,status) VALUES('kem-company','Kem Company','active') RETURNING id");
    }
    const organisationId=org.rows[0].id;
    const user=await db.query(
      `INSERT INTO revolt_x_os.users(email,password_hash,first_name,last_name,status,email_verified_at)
       VALUES($1,$2,$3,$4,'active',now())
       ON CONFLICT(email) DO UPDATE
       SET password_hash=EXCLUDED.password_hash,
           first_name=EXCLUDED.first_name,
           last_name=EXCLUDED.last_name,
           status='active',
           email_verified_at=coalesce(revolt_x_os.users.email_verified_at,now()),
           updated_at=now()
       RETURNING id`,
      [email.toLowerCase(),hash,firstName,lastName]
    );
    const userId=user.rows[0].id;
    const membership=await db.query(
      `INSERT INTO revolt_x_os.organisation_memberships(organisation_id,user_id,job_title,employee_number,status)
       VALUES($1,$2,$3,$4,'active')
       ON CONFLICT(organisation_id,user_id) DO UPDATE
       SET job_title=EXCLUDED.job_title,employee_number=EXCLUDED.employee_number,status='active'
       RETURNING id`,
      [organisationId,userId,'Revolt-X Administrator','BOOT-'+email.toLowerCase().replace(/[^a-z0-9]/g,'-').slice(0,60)]
    );
    const membershipId=membership.rows[0].id;
    await db.query(
      `INSERT INTO revolt_x_os.membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
       SELECT $1,r.id,'organisation',$2,$3
       FROM revolt_x_os.roles r
       WHERE r.key='owner' AND r.organisation_id IS NULL
       ON CONFLICT DO NOTHING`,
      [membershipId,organisationId,userId]
    );
    await db.query('COMMIT');
    return{email,organisationId};
  }catch(error){
    await db.query('ROLLBACK');
    throw error;
  }
}

async function applyBootstrapCredentials(){
  const key='credentials:'+config.BOOTSTRAP_CREDENTIALS_VERSION;
  const done=await db.query('SELECT 1 FROM shop_bootstrap_state WHERE key=$1',[key]);
  if(done.rowCount)return;
  const accounts:Array<[string,string,string,string]>=[];
  if(config.SHOP_BOOTSTRAP_EMAIL&&config.SHOP_BOOTSTRAP_PASSWORD){
    accounts.push([config.SHOP_BOOTSTRAP_EMAIL,config.SHOP_BOOTSTRAP_PASSWORD,'Revolt-X Shop','Admin']);
  }
  if(config.OS_BOOTSTRAP_EMAIL&&config.OS_BOOTSTRAP_PASSWORD){
    accounts.push([config.OS_BOOTSTRAP_EMAIL,config.OS_BOOTSTRAP_PASSWORD,'Revolt-X OS','Admin']);
  }
  if(!accounts.length)return;
  for(const [email,password,firstName,lastName] of accounts){
    await ensureCoreOwnerAccount(email,password,firstName,lastName);
  }
  await db.query('INSERT INTO shop_bootstrap_state(key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
  app.log.info({accounts:accounts.map(x=>x[0]),version:config.BOOTSTRAP_CREDENTIALS_VERSION},'Bootstrap credentials applied');
}

const close=async()=>{await app.close();await db.end();process.exit(0)};
process.on('SIGTERM',close);
process.on('SIGINT',close);

await app.listen({host:config.HOST,port:config.PORT});
void applyBootstrapCredentials();
