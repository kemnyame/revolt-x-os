import type { SchoolConfig } from './config.js';

export type MessageChannel='email'|'sms'|'whatsapp';

export function providerStatus(config:SchoolConfig){
  const twilioAuth=Boolean(config.TWILIO_ACCOUNT_SID&&((config.TWILIO_API_KEY_SID&&config.TWILIO_API_KEY_SECRET)||config.TWILIO_AUTH_TOKEN));
  return{
    email:{
      provider:'resend',
      configured:Boolean(config.RESEND_API_KEY&&config.RESEND_FROM_EMAIL),
      mode:config.RESEND_FROM_EMAIL&&/(@|<)[^>]*resend\.dev>?$/i.test(config.RESEND_FROM_EMAIL)?'testing':'production'
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
    if(!config.RESEND_API_KEY||!config.RESEND_FROM_EMAIL)throw new Error('Email provider is not configured');
    const res=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{authorization:'Bearer '+config.RESEND_API_KEY,'content-type':'application/json'},
      body:JSON.stringify({
        from:config.RESEND_FROM_EMAIL,
        to:[input.to],
        subject:input.subject||'Revolt-X School notification',
        html:'<div style="font-family:Arial,sans-serif;white-space:pre-wrap">'+htmlEscape(input.body).replace(/\n/g,'<br>')+'</div>'
      }),
      signal:AbortSignal.timeout(15000)
    });
    const data=await res.json().catch(()=>({})) as any;
    if(!res.ok)throw new Error(data?.message||data?.error?.message||'Email request failed');
    return{provider:'resend',messageId:String(data.id||''),providerStatus:'sent'};
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
