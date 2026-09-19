import type { SchoolConfig } from './config.js';

export type MessageChannel='email'|'sms'|'whatsapp';

export function providerStatus(config:SchoolConfig){
  return{
    email:{
      provider:'resend',
      configured:Boolean(config.RESEND_API_KEY&&config.RESEND_FROM_EMAIL)
    },
    sms:{
      provider:'twilio',
      configured:Boolean(config.TWILIO_ACCOUNT_SID&&config.TWILIO_AUTH_TOKEN&&config.TWILIO_SMS_FROM)
    },
    whatsapp:{
      provider:'twilio',
      configured:Boolean(config.TWILIO_ACCOUNT_SID&&config.TWILIO_AUTH_TOKEN&&config.TWILIO_WHATSAPP_FROM)
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

async function sendTwilio(config:SchoolConfig,channel:'sms'|'whatsapp',to:string,body:string){
  if(!config.TWILIO_ACCOUNT_SID||!config.TWILIO_AUTH_TOKEN)throw new Error('Twilio is not configured');
  const from=channel==='sms'?config.TWILIO_SMS_FROM:config.TWILIO_WHATSAPP_FROM;
  if(!from)throw new Error(channel==='sms'?'SMS sender is not configured':'WhatsApp sender is not configured');
  const form=new URLSearchParams();
  form.set('To',channel==='whatsapp'?toWhatsappAddress(to):to);
  form.set('From',channel==='whatsapp'?toWhatsappAddress(from):from);
  form.set('Body',body);
  const auth=Buffer.from(config.TWILIO_ACCOUNT_SID+':'+config.TWILIO_AUTH_TOKEN).toString('base64');
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
  return sendTwilio(config,input.channel,input.to,input.body);
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
