import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {loadSchoolConfig} from './config.js';
import {normalizeMessagePhone,providerStatus,sendMessage} from './providers.js';

const challengeTtlMs=5*60*1000;
const resendCooldownMs=45*1000;
const maxAttempts=5;
const androidDemoOtp='0000';

type Challenge={
  id:string;
  schoolSlug:string;
  phone:string;
  studentId:string;
  codeHash:Buffer;
  salt:string;
  expiresAt:number;
  attempts:number;
  consumed:boolean;
  mode:'sms'|'demo';
  digits:4|6;
};

const challenges=new Map<string,Challenge>();
const recentStarts=new Map<string,number>();
const key=(school:string,phone:string,student:string)=>[school.toLowerCase(),phone,student.toLowerCase()].join('|');
const hashCode=(salt:string,code:string)=>createHash('sha256').update(salt+':'+code).digest();
const maskedPhone=(phone:string)=>phone.length>7?phone.slice(0,4)+'••••'+phone.slice(-3):'your phone';
const isAndroidClient=(userAgent:unknown)=>String(userAgent||'').includes('RevoltSchoolAndroid/');

function cleanup(){
  const now=Date.now();
  for(const [id,c] of challenges)if(c.expiresAt<=now||c.consumed)challenges.delete(id);
  for(const [id,at] of recentStarts)if(now-at>10*60*1000)recentStarts.delete(id);
}

async function internalParentLogin(app:FastifyInstance,payload:{schoolSlug:string;phone:string;studentId:string}){
  const response=await app.inject({method:'POST',url:'/api/parent/login',payload});
  let body:any=null;try{body=response.json()}catch{}
  if(response.statusCode>=400){
    const message=body?.error?.message||body?.message||'We could not verify this parent account. Check the school, phone number and Student ID.';
    throw Object.assign(new Error(message),{statusCode:response.statusCode});
  }
  if(!body?.token)throw Object.assign(new Error('Parent sign-in could not be verified.'),{statusCode:503});
  return body;
}

async function revokeTemporaryParentSession(app:FastifyInstance,token:string){
  await app.inject({method:'POST',url:'/api/parent/logout',headers:{authorization:'Bearer '+token}}).catch(()=>null);
}

export async function registerMobilePhoneAuth(app:FastifyInstance){
  app.get('/api/auth/admin-reset-context',async(request,reply)=>{
    reply.header('cache-control','no-store');
    const config=loadSchoolConfig();
    const query=z.object({token:z.string().trim().min(32).max(500),schoolId:z.string().trim().min(1).max(120)}).parse(request.query);
    const url=config.CORE_OS_URL.replace(/\/$/,'')+'/v1/auth/password-reset/context?'+new URLSearchParams({token:query.token,schoolId:query.schoolId,purpose:'school_admin'}).toString();
    const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)}).catch(()=>null);
    if(!response)throw Object.assign(new Error('The administrator reset service is temporarily unavailable.'),{statusCode:503});
    const body=await response.json().catch(()=>null) as any;
    if(!response.ok)throw Object.assign(new Error(body?.error?.message||'This administrator reset link is invalid or expired.'),{statusCode:response.status});
    return body;
  });

  app.post('/api/mobile/parent/phone-auth/start',async(request,reply)=>{
    reply.header('cache-control','no-store');cleanup();
    const config=loadSchoolConfig();
    const body=z.object({
      schoolSlug:z.string().trim().min(1).max(120),
      phone:z.string().trim().min(5).max(60),
      studentId:z.string().trim().min(1).max(60)
    }).parse(request.body);
    let phone:string;
    try{phone=normalizeMessagePhone(body.phone)}catch(error:any){throw Object.assign(new Error(error?.message||'Enter a valid mobile number.'),{statusCode:400});}
    const demoMode=isAndroidClient(request.headers['user-agent']);
    if(!demoMode&&!providerStatus(config).sms.configured)throw Object.assign(new Error('Phone verification is not configured for this School service yet. Connect the production SMS provider before using phone sign-in.'),{statusCode:503});
    const fingerprint=key(body.schoolSlug,phone,body.studentId),last=recentStarts.get(fingerprint)||0;
    if(Date.now()-last<resendCooldownMs)throw Object.assign(new Error('A verification code was just created. Wait a few seconds before requesting another one.'),{statusCode:429});

    // Always validate the guardian-child relationship first. The temporary validation
    // session is revoked immediately, so neither SMS nor the Android demo gate can
    // bypass the registered parent details.
    const validation=await internalParentLogin(app,{schoolSlug:body.schoolSlug,phone,studentId:body.studentId});
    await revokeTemporaryParentSession(app,validation.token);

    const code=demoMode?androidDemoOtp:String(randomInt(100000,1000000));
    const digits:4|6=demoMode?4:6;
    const salt=randomBytes(18).toString('base64url'),id=randomBytes(24).toString('base64url');
    const challenge:Challenge={id,schoolSlug:body.schoolSlug,phone,studentId:body.studentId,codeHash:hashCode(salt,code),salt,expiresAt:Date.now()+challengeTtlMs,attempts:0,consumed:false,mode:demoMode?'demo':'sms',digits};
    challenges.set(id,challenge);recentStarts.set(fingerprint,Date.now());
    if(!demoMode){
      try{
        await sendMessage(config,{channel:'sms',to:phone,recipientName:'Parent or Guardian',subject:'Revolt School verification',body:`Your Revolt School verification code is ${code}. It expires in 5 minutes. Do not share this code.`});
      }catch(error:any){challenges.delete(id);throw Object.assign(new Error('We could not send the verification code. Check the SMS connection and try again.'),{statusCode:503,cause:error});}
    }
    return{
      challengeId:id,
      destination:demoMode?'this Android app':maskedPhone(phone),
      expiresInSeconds:Math.floor(challengeTtlMs/1000),
      resendAfterSeconds:Math.floor(resendCooldownMs/1000),
      demo:demoMode,
      digits,
      ...(demoMode?{demoCode:androidDemoOtp}:{})
    };
  });

  app.post('/api/mobile/parent/phone-auth/verify',async(request,reply)=>{
    reply.header('cache-control','no-store');cleanup();
    const body=z.object({challengeId:z.string().min(24).max(200),code:z.string().trim().regex(/^\d{4,6}$/)}).parse(request.body);
    const challenge=challenges.get(body.challengeId);
    if(!challenge||challenge.consumed||challenge.expiresAt<=Date.now())throw Object.assign(new Error('This verification code has expired. Request a new code.'),{statusCode:401});
    if(body.code.length!==challenge.digits)throw Object.assign(new Error(`Enter the ${challenge.digits}-digit verification code.`),{statusCode:401});
    if(challenge.attempts>=maxAttempts){challenges.delete(body.challengeId);throw Object.assign(new Error('Too many incorrect attempts. Request a new verification code.'),{statusCode:429});}
    challenge.attempts++;
    const supplied=hashCode(challenge.salt,body.code);
    if(supplied.length!==challenge.codeHash.length||!timingSafeEqual(supplied,challenge.codeHash))throw Object.assign(new Error('That verification code is incorrect.'),{statusCode:401});
    challenge.consumed=true;
    const result=await internalParentLogin(app,{schoolSlug:challenge.schoolSlug,phone:challenge.phone,studentId:challenge.studentId});
    challenges.delete(body.challengeId);
    return{...result,phoneVerified:challenge.mode==='sms',demoVerified:challenge.mode==='demo'};
  });
}
