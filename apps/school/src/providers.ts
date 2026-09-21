import type { SchoolConfig } from './config.js';

export type MessageChannel='email'|'sms'|'whatsapp';

export function emailProviderCandidates(config:SchoolConfig){
  if(config.EMAIL_PROVIDER==='brevo')return ['brevo'] as const;
  if(config.EMAIL_PROVIDER==='resend')return ['resend'] as const;
  const candidates:Array<'brevo'|'resend'>=[];
  if(config.BREVO_API_KEY)candidates.push('brevo');
  if(config.RESEND_API_KEY&&config.RESEND_FROM_EMAIL)candidates.push('resend');
  return candidates;
}

function selectedEmailProvider(config:SchoolConfig){
  const candidates=emailProviderCandidates(config);
  return candidates[0]||'brevo';
}

export function providerStatus(config:SchoolConfig){
  const twilioAuth=Boolean(config.TWILIO_ACCOUNT_SID&&((config.TWILIO_API_KEY_SID&&config.TWILIO_API_KEY_SECRET)||config.TWILIO_AUTH_TOKEN));
  const emailProvider=selectedEmailProvider(config);
  const emailConfigured=emailProvider==='brevo'
    ?Boolean(config.BREVO_API_KEY)
    :Boolean(config.RESEND_API_KEY&&config.RESEND_FROM_EMAIL);
  return{
    email:{
      provider:emailProvider,
      configured:emailConfigured,
      sender:emailProvider==='brevo'?config.BREVO_FROM_EMAIL:config.RESEND_FROM_EMAIL,
      mode:emailProvider==='resend'&&config.RESEND_FROM_EMAIL&&/(@|<)[^>]*resend\.dev>?$/i.test(config.RESEND_FROM_EMAIL)?'testing':'production'
    },
    sms:{
      provider:'twilio',
      configured:Boolean(twilioAuth&&(config.TWILIO_MESSAGING_SERVICE_SID||config.TWILIO_SMS_FROM)),
      authentication:config.TWILIO_API_KEY_SID?'api_key':config.TWILIO_AUTH_TOKEN?'auth_token':'missing'
    },
    whatsapp:{
      provider:'twilio',
      configured:Boolean(twilioAuth&&config.TWILIO_WHATSAPP_FROM),
      authentication:config.TWILIO_API_KEY_SID?'api_key':config.TWILIO_AUTH_TOKEN?'auth_token':'missing',
      productionTemplateReady:Boolean(config.TWILIO_WHATSAPP_CONTENT_SID)
    },
    payments:{
      provider:'paystack',
      configured:Boolean(config.PAYSTACK_SECRET_KEY),
      currency:config.PAYSTACK_CURRENCY
    }
  };
}

let brevoSenderCache:{email:string;name?:string|null;source:'env'|'account'}|null=null;
let brevoSenderCacheAt=0;

async function brevoRequest(config:SchoolConfig,path:string){
  if(!config.BREVO_API_KEY)throw new Error('Brevo API key is not configured');
  const res=await fetch('https://api.brevo.com/v3'+path,{
    headers:{accept:'application/json','api-key':config.BREVO_API_KEY},
    signal:AbortSignal.timeout(15000)
  });
  const data=await res.json().catch(()=>({})) as any;
  if(!res.ok)throw new Error(data?.message||data?.error?.message||('Brevo request failed ('+res.status+')'));
  return data;
}

async function resolveBrevoSender(config:SchoolConfig){
  if(config.BREVO_FROM_EMAIL)return{email:config.BREVO_FROM_EMAIL,name:config.BREVO_FROM_NAME||'Revolt-X School',source:'env' as const};
  if(brevoSenderCache&&Date.now()-brevoSenderCacheAt<10*60*1000)return brevoSenderCache;
  const data=await brevoRequest(config,'/senders');
  const senders=Array.isArray(data?.senders)?data.senders:[];
  const active=senders.filter((s:any)=>s?.email&&s?.active!==false);
  if(!active.length)throw new Error('Brevo is authenticated, but no active sender email is available. Verify a sender/domain in Brevo.');
  const preferred=active.find((s:any)=>s?.email&&/@/.test(String(s.email)))||active[0];
  brevoSenderCache={email:String(preferred.email),name:String(preferred.name||config.BREVO_FROM_NAME||'Revolt-X School'),source:'account'};
  brevoSenderCacheAt=Date.now();
  return brevoSenderCache;
}

export async function validateBrevoConnection(config:SchoolConfig){
  if(!config.BREVO_API_KEY)return{authenticated:false,senderReady:false,senderSource:null};
  await brevoRequest(config,'/account');
  const sender=await resolveBrevoSender(config);
  return{authenticated:true,senderReady:Boolean(sender?.email),senderSource:sender.source};
}

function htmlEscape(v:string){
  return v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c));
}

function toWhatsappAddress(v:string){
  return v.startsWith('whatsapp:')?v:'whatsapp:'+v;
}

async function sendTwilio(config:SchoolConfig,channel:'sms'|'whatsapp',to:string,body:string,subject?:string|null,recipientName?:string|null){
  if(!config.TWILIO_ACCOUNT_SID)throw new Error('Twilio Account SID is not configured');
  const username=config.TWILIO_API_KEY_SID||config.TWILIO_ACCOUNT_SID;
  const password=config.TWILIO_API_KEY_SECRET||config.TWILIO_AUTH_TOKEN;
  if(!password)throw new Error('Twilio API key or Auth Token is not configured');
  const from=channel==='sms'?config.TWILIO_SMS_FROM:config.TWILIO_WHATSAPP_FROM;
  if(channel==='sms'&&!config.TWILIO_MESSAGING_SERVICE_SID&&!from)throw new Error('SMS sender or Messaging Service is not configured');
  if(channel==='whatsapp'&&!from)throw new Error('WhatsApp sender is not configured');
  const form=new URLSearchParams();
  form.set('To',channel==='whatsapp'?toWhatsappAddress(to):to);
  if(channel==='sms'&&config.TWILIO_MESSAGING_SERVICE_SID)form.set('MessagingServiceSid',config.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From',channel==='whatsapp'?toWhatsappAddress(from!):from!);
  if(channel==='whatsapp'&&config.TWILIO_WHATSAPP_CONTENT_SID){
    form.set('ContentSid',config.TWILIO_WHATSAPP_CONTENT_SID);
    form.set('ContentVariables',JSON.stringify({
      '1':recipientName||'Parent or Guardian',
      '2':subject||'School update',
      '3':body
    }));
  }else{
    form.set('Body',body);
  }
  const auth=Buffer.from(username+':'+password).toString('base64');
  const res=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.TWILIO_ACCOUNT_SID)}/Messages.json`,{
    method:'POST',
    headers:{authorization:'Basic '+auth,'content-type':'application/x-www-form-urlencoded'},
    body:form.toString(),
    signal:AbortSignal.timeout(15000)
  });
  const data=await res.json().catch(()=>({})) as any;
  if(!res.ok)throw new Error(data?.message||`Twilio ${channel} request failed`);
  return{provider:'twilio',messageId:String(data.sid||''),providerStatus:String(data.status||'queued')};
}

export async function sendMessage(config:SchoolConfig,input:{
  channel:MessageChannel;
  to:string;
  subject?:string|null|undefined;
  recipientName?:string|null|undefined;
  body:string;
}){
  if(input.channel==='email'){
    const subject=input.subject||'Revolt-X School notification';
    const htmlContent='<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172027">'+
      '<h2 style="margin:0 0 14px">Revolt-X School</h2>'+
      (input.recipientName?'<p>Hello '+htmlEscape(input.recipientName)+',</p>':'')+
      '<div style="white-space:pre-wrap">'+htmlEscape(input.body).replace(/\n/g,'<br>')+'</div>'+
      '<p style="margin-top:24px;color:#667780;font-size:12px">This is an automated notification from Revolt-X School.</p></div>';
    const candidates=emailProviderCandidates(config);
    if(!candidates.length)throw new Error('No email provider is configured');
    const failures:string[]=[];

    for(const provider of candidates){
      try{
        if(provider==='brevo'){
          if(!config.BREVO_API_KEY)throw new Error('Brevo email provider is not configured');
          const sender=await resolveBrevoSender(config);
          const res=await fetch('https://api.brevo.com/v3/smtp/email',{
            method:'POST',
            headers:{
              accept:'application/json',
              'api-key':config.BREVO_API_KEY,
              'content-type':'application/json'
            },
            body:JSON.stringify({
              sender:{name:sender.name||config.BREVO_FROM_NAME||'Revolt-X School',email:sender.email},
              to:[{email:input.to,name:input.recipientName||undefined}],
              subject,
              htmlContent,
              tags:['revolt-x-school']
            }),
            signal:AbortSignal.timeout(15000)
          });
          const data=await res.json().catch(()=>({})) as any;
          if(!res.ok)throw new Error(data?.message||data?.error?.message||'Brevo email request failed');
          return{provider:'brevo',messageId:String(data.messageId||data.messageIds?.[0]||''),providerStatus:'sent'};
        }

        if(!config.RESEND_API_KEY||!config.RESEND_FROM_EMAIL)throw new Error('Resend email provider is not configured');
        const res=await fetch('https://api.resend.com/emails',{
          method:'POST',
          headers:{authorization:'Bearer '+config.RESEND_API_KEY,'content-type':'application/json'},
          body:JSON.stringify({
            from:config.RESEND_FROM_EMAIL,
            to:[input.to],
            subject,
            html:htmlContent
          }),
          signal:AbortSignal.timeout(15000)
        });
        const data=await res.json().catch(()=>({})) as any;
        if(!res.ok)throw new Error(data?.message||data?.error?.message||'Resend email request failed');
        return{provider:'resend',messageId:String(data.id||''),providerStatus:'sent'};
      }catch(error:any){
        failures.push(provider+': '+String(error?.message||error));
        if(config.EMAIL_PROVIDER!=='auto')throw error;
      }
    }
    throw new Error('All configured email providers failed. '+failures.join(' | '));
  }
  return sendTwilio(config,input.channel,input.to,input.body,input.subject,input.recipientName);
}

export async function initializePaystack(config:SchoolConfig,input:{
  email:string;
  amount:number;
  currency:string;
  reference:string;
  channels:Array<'card'|'mobile_money'>;
  callbackUrl:string;
  metadata:Record<string,unknown>;
}){
  if(!config.PAYSTACK_SECRET_KEY)throw new Error('Paystack is not configured');
  const res=await fetch('https://api.paystack.co/transaction/initialize',{
    method:'POST',
    headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY,'content-type':'application/json'},
    body:JSON.stringify({
      email:input.email,
      amount:String(Math.round(input.amount*100)),
      currency:input.currency,
      reference:input.reference,
      channels:input.channels,
      callback_url:input.callbackUrl,
      metadata:input.metadata
    }),
    signal:AbortSignal.timeout(15000)
  });
  const data=await res.json().catch(()=>({})) as any;
  if(!res.ok||data?.status!==true)throw new Error(data?.message||'Payment could not be initialized');
  return{
    authorizationUrl:String(data.data?.authorization_url||''),
    accessCode:String(data.data?.access_code||''),
    reference:String(data.data?.reference||input.reference)
  };
}

export async function verifyPaystack(config:SchoolConfig,reference:string){
  if(!config.PAYSTACK_SECRET_KEY)throw new Error('Paystack is not configured');
  const res=await fetch('https://api.paystack.co/transaction/verify/'+encodeURIComponent(reference),{
    headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY},
    signal:AbortSignal.timeout(15000)
  });
  const data=await res.json().catch(()=>({})) as any;
  if(!res.ok||data?.status!==true)throw new Error(data?.message||'Payment verification failed');
  const x=data.data||{};
  return{
    status:String(x.status||''),
    reference:String(x.reference||reference),
    amount:Number(x.amount||0)/100,
    currency:String(x.currency||''),
    paidAt:x.paid_at||x.paidAt||null,
    channel:String(x.channel||''),
    gatewayResponse:String(x.gateway_response||''),
    customerEmail:String(x.customer?.email||''),
    raw:x
  };
}
