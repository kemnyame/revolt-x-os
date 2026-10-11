import type { SchoolConfig } from './config.js';

export type DeliveryFailureKind='configuration'|'permanent'|'transient'|'review';
export class DeliveryError extends Error{
  constructor(message:string,public readonly kind:DeliveryFailureKind){super(message);this.name='DeliveryError';}
}

export function normalizeMessagePhone(value:string){
  let phone=String(value||'').trim().replace(/^whatsapp:/i,'').replace(/[\s().-]/g,'');
  if(phone.startsWith('00'))phone='+'+phone.slice(2);
  else if(/^0\d{9}$/.test(phone))phone='+233'+phone.slice(1);
  else if(/^[1-9]\d{7,14}$/.test(phone))phone='+'+phone;
  if(!/^\+[1-9]\d{7,14}$/.test(phone))throw new DeliveryError('Enter a valid phone number, for example 0557485233 or +233557485233.','permanent');
  return phone;
}

function usesResendTestSender(config:SchoolConfig){
  return /(?:^|<)[^<>\s]+@resend\.dev>?$/i.test(String(config.RESEND_FROM_EMAIL||'').trim());
}

export function selectedWhatsappProvider(config:SchoolConfig){
  if(config.WHATSAPP_PROVIDER==='meta'||config.WHATSAPP_PROVIDER==='twilio')return config.WHATSAPP_PROVIDER;
  return config.WHATSAPP_TOKEN||config.WHATSAPP_PHONE_NUMBER_ID?'meta':'twilio';
}

function responseError(provider:string,status:number,data:any):DeliveryError{
  const code=String(data?.error?.code??data?.code??data?.name??'');
  const message=String(data?.error?.message||data?.message||'Request rejected').slice(0,1200);
  if(provider==='Meta'&&(code==='190'||code==='10'||code==='200'))return new DeliveryError('WhatsApp access token is expired or lacks access to the sending number. Configure a production system-user token.','configuration');
  if(provider==='Meta'&&['132001','132015','132016'].includes(code))return new DeliveryError('WhatsApp template is missing, paused, disabled or uses the wrong language. Configure an approved template.','configuration');
  if(provider==='Twilio'&&['63007','63016','63015'].includes(code))return new DeliveryError('WhatsApp sender or template is not ready. Use an approved production sender and template; sandbox recipients must join the sandbox.','configuration');
  const details=provider+' ('+status+(code?', '+code:'')+'): '+message;
  if(status===401||status===403||/domain.*(verif|not)|testing.*(email|recipient)|verify.*sender/i.test(message))return new DeliveryError(details,'configuration');
  if(status===429||status>=500)return new DeliveryError(details,'transient');
  return new DeliveryError(details,'permanent');
}

async function messageRequest(provider:string,url:string,options:RequestInit,idempotent=false){
  let response:Response;
  try{response=await fetch(url,{...options,signal:AbortSignal.timeout(15000)});}
  catch{throw new DeliveryError(provider+' connection timed out or failed. '+(idempotent?'The queued message can be retried safely.':'The provider may have accepted the message. Check its delivery log before retrying.'),idempotent?'transient':'review');}
  const data=await response.json().catch(()=>({})) as any;
  if(response.status>=500&&!idempotent&&options.method==='POST')throw new DeliveryError(provider+' returned a server error with an uncertain delivery outcome. Check the provider log before retrying.','review');
  if(!response.ok)throw responseError(provider,response.status,data);
  return data;
}

export type MessageChannel='email'|'sms'|'whatsapp';
export type PaystackChannel='card'|'bank'|'apple_pay'|'ussd'|'qr'|'mobile_money'|'bank_transfer'|'eft'|'capitec_pay'|'payattitude';

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
  const emailCandidates=emailProviderCandidates(config);
  const emailProvider=selectedEmailProvider(config);
  const emailConfigured=emailProvider==='brevo'
    ?Boolean(config.BREVO_API_KEY)
    :Boolean(config.RESEND_API_KEY&&config.RESEND_FROM_EMAIL);
  const whatsappProvider=selectedWhatsappProvider(config);
  const whatsappCredentials=whatsappProvider==='meta'?Boolean(config.WHATSAPP_TOKEN&&config.WHATSAPP_PHONE_NUMBER_ID):Boolean(twilioAuth&&config.TWILIO_WHATSAPP_FROM);
  const whatsappTemplate=whatsappProvider==='meta'?Boolean(config.WHATSAPP_TEMPLATE_NAME):Boolean(config.TWILIO_WHATSAPP_CONTENT_SID);
  return{
    email:{
      provider:emailProvider,
      candidates:emailCandidates,
      fallbackConfigured:emailCandidates.length>1,
      configured:emailConfigured,
      sender:emailProvider==='brevo'?config.BREVO_FROM_EMAIL:config.RESEND_FROM_EMAIL,
      mode:config.EMAIL_DELIVERY_MODE==='testing'||(emailProvider==='resend'&&usesResendTestSender(config))?'testing':'production',
      productionReady:null as boolean|null,
      setupNote:emailProvider==='resend'&&usesResendTestSender(config)?'Test sender: only the configured test recipient can receive email. Verify a sending domain to contact parents.':'Credentials do not confirm sender verification or inbox delivery. Use Check connections.'
    },
    sms:{
      provider:'twilio',
      configured:Boolean(twilioAuth&&(config.TWILIO_MESSAGING_SERVICE_SID||config.TWILIO_SMS_FROM)),
      authentication:config.TWILIO_API_KEY_SID?'api_key':config.TWILIO_AUTH_TOKEN?'auth_token':'missing'
    },
    whatsapp:{
      provider:whatsappProvider,
      configured:Boolean(whatsappCredentials&&(whatsappTemplate||config.WHATSAPP_ALLOW_SESSION_MESSAGES)),
      credentialsConfigured:whatsappCredentials,
      authentication:whatsappProvider==='meta'?(config.WHATSAPP_TOKEN?'access_token':'missing'):(config.TWILIO_API_KEY_SID?'api_key':config.TWILIO_AUTH_TOKEN?'auth_token':'missing'),
      productionTemplateReady:whatsappTemplate,
      setupNote:!whatsappCredentials?'Connect a production WhatsApp account and sending number.':!whatsappTemplate?'Configure an approved template for school alerts outside the 24-hour service window.':'Template configured; provider approval and business-number registration must still be checked.'
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
  if(!res.ok)throw responseError('Brevo',res.status,data);
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

// Read-only checks: these never send messages or disclose provider credentials.
export async function checkMessagingConnections(config:SchoolConfig){
  const status=providerStatus(config);
  const emailCheck=async()=>{
    if(!status.email.configured)return{ready:false,note:'Connect an email provider and a verified sender.'};
    if(status.email.mode==='testing')return{ready:false,note:'Email testing is limited to the configured account-owner recipient. Verify a sending domain before contacting parents.'};
    if(status.email.provider==='brevo'){
      const connection=await validateBrevoConnection(config);
      return{ready:connection.authenticated&&connection.senderReady,note:'Brevo account and sender are connected. Confirm domain authentication in Brevo before commercial delivery.'};
    }
    const sender=String(config.RESEND_FROM_EMAIL||'').match(/(?:^|<)([^<>\s]+@([^<>\s]+))>?$/)?.[2]?.toLowerCase();
    const data=await messageRequest('Resend','https://api.resend.com/domains?limit=100',{headers:{authorization:'Bearer '+config.RESEND_API_KEY}});
    const domain=(Array.isArray(data.data)?data.data:[]).find((d:any)=>String(d.name).toLowerCase()===sender);
    const ready=domain?.status==='verified'&&domain?.capabilities?.sending!=='disabled';
    return{ready,note:ready?'Resend sending domain is verified. API acceptance does not prove inbox delivery.':'Resend sending domain is '+(domain?.status||'not registered')+'. Add the required DNS records and verify it in Resend.'};
  };
  const whatsappCheck=async()=>{
    if(!status.whatsapp.configured)return{ready:false,note:status.whatsapp.setupNote};
    if(status.whatsapp.provider!=='meta')return{ready:null,note:'Twilio credentials are configured. Confirm the sender and content-template approval in Twilio before commercial delivery.'};
    const headers={authorization:'Bearer '+config.WHATSAPP_TOKEN};
    const base='https://graph.facebook.com/'+config.WHATSAPP_API_VERSION+'/';
    const phone=await messageRequest('Meta',base+config.WHATSAPP_PHONE_NUMBER_ID+'?fields=id,display_phone_number,verified_name,code_verification_status',{headers});
    if(!config.WHATSAPP_BUSINESS_ACCOUNT_ID||!config.WHATSAPP_TEMPLATE_NAME)return{ready:null,sender:phone.display_phone_number,note:'Meta sending number is accessible. Add the WhatsApp Business Account ID to check template approval; session messages require an active 24-hour service window.'};
    const templates=await messageRequest('Meta',base+config.WHATSAPP_BUSINESS_ACCOUNT_ID+'/message_templates?name='+encodeURIComponent(config.WHATSAPP_TEMPLATE_NAME)+'&limit=100',{headers});
    const template=(templates.data||[]).find((t:any)=>t.name===config.WHATSAPP_TEMPLATE_NAME&&t.language===config.WHATSAPP_TEMPLATE_LANGUAGE);
    const body=template?.components?.find((c:any)=>c.type==='BODY')?.text||'';
    const positions=[...new Set((body.match(/\{\{\d+\}\}/g)||[]))].sort();
    const compatible=positions.join(',')==='{{1}},{{2}},{{3}}'&&template?.parameter_format!=='NAMED';
    const ready=phone.code_verification_status==='VERIFIED'&&template?.status==='APPROVED'&&compatible;
    return{ready,sender:phone.display_phone_number,note:ready?'Meta number is verified and the three-variable template is approved. Billing and recipient delivery still depend on Meta.':!compatible&&template?'Use a body template with exactly three positional variables: recipient name, subject and message.':'WhatsApp number verification or template approval is incomplete ('+(template?.status||'template not found')+').'};
  };
  const [email,whatsapp]=await Promise.allSettled([emailCheck(),whatsappCheck()]);
  const result=(r:PromiseSettledResult<any>)=>r.status==='fulfilled'?r.value:{ready:false,note:String(r.reason?.message||'Provider check failed')};
  return{email:result(email),whatsapp:result(whatsapp),checkedAt:new Date().toISOString()};
}

function htmlEscape(v:string){
  return v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c));
}

function toWhatsappAddress(v:string){
  return 'whatsapp:'+normalizeMessagePhone(v);
}

async function sendTwilio(config:SchoolConfig,channel:'sms'|'whatsapp',to:string,body:string,subject?:string|null,recipientName?:string|null){
  if(!config.TWILIO_ACCOUNT_SID)throw new Error('Twilio Account SID is not configured');
  const useApiKey=Boolean(config.TWILIO_API_KEY_SID&&config.TWILIO_API_KEY_SECRET);
  const username=useApiKey?config.TWILIO_API_KEY_SID!:config.TWILIO_ACCOUNT_SID;
  const password=useApiKey?config.TWILIO_API_KEY_SECRET:config.TWILIO_AUTH_TOKEN;
  if(!password)throw new Error('Twilio API key or Auth Token is not configured');
  const from=channel==='sms'?config.TWILIO_SMS_FROM:config.TWILIO_WHATSAPP_FROM;
  if(channel==='sms'&&!config.TWILIO_MESSAGING_SERVICE_SID&&!from)throw new Error('SMS sender or Messaging Service is not configured');
  if(channel==='whatsapp'&&!from)throw new Error('WhatsApp sender is not configured');
  const form=new URLSearchParams();
  if(channel==='whatsapp'&&!config.TWILIO_WHATSAPP_CONTENT_SID&&!config.WHATSAPP_ALLOW_SESSION_MESSAGES)throw new DeliveryError('Configure an approved Twilio WhatsApp content template before sending school alerts.','configuration');
  form.set('To',channel==='whatsapp'?toWhatsappAddress(to):normalizeMessagePhone(to));
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
  const data=await messageRequest('Twilio',`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.TWILIO_ACCOUNT_SID)}/Messages.json`,{
    method:'POST',
    headers:{authorization:'Basic '+auth,'content-type':'application/x-www-form-urlencoded'},
    body:form.toString(),
    signal:AbortSignal.timeout(15000)
  });
  if(!data.sid)throw new DeliveryError('Twilio accepted the request without returning a message ID. Check the provider log before retrying.','review');
  if(['failed','undelivered'].includes(String(data.status)))throw new DeliveryError('Twilio rejected the message: '+String(data.error_message||data.error_code||data.status),'permanent');
  return{provider:'twilio',messageId:String(data.sid||''),providerStatus:String(data.status||'queued')};
}

async function sendMetaWhatsapp(config:SchoolConfig,input:{to:string;body:string;subject?:string|null|undefined;recipientName?:string|null|undefined}){
  if(!config.WHATSAPP_TOKEN||!config.WHATSAPP_PHONE_NUMBER_ID)throw new DeliveryError('Connect the Meta WhatsApp production token and Phone Number ID.','configuration');
  const payload:any={messaging_product:'whatsapp',recipient_type:'individual',to:normalizeMessagePhone(input.to).slice(1)};
  if(config.WHATSAPP_TEMPLATE_NAME){
    payload.type='template';
    payload.template={name:config.WHATSAPP_TEMPLATE_NAME,language:{code:config.WHATSAPP_TEMPLATE_LANGUAGE},components:[{type:'body',parameters:[input.recipientName||'Parent or Guardian',input.subject||'School update',input.body].map(text=>({type:'text',text:text.replace(/\s+/g,' ').trim()}))}]};
  }else if(config.WHATSAPP_ALLOW_SESSION_MESSAGES){
    payload.type='text';payload.text={preview_url:false,body:input.body};
  }else throw new DeliveryError('Configure an approved Meta WhatsApp template for commercial school alerts.','configuration');
  const data=await messageRequest('Meta','https://graph.facebook.com/'+config.WHATSAPP_API_VERSION+'/'+config.WHATSAPP_PHONE_NUMBER_ID+'/messages',{
    method:'POST',headers:{authorization:'Bearer '+config.WHATSAPP_TOKEN,'content-type':'application/json'},body:JSON.stringify(payload)
  });
  const messageId=String(data.messages?.[0]?.id||'');
  if(!messageId)throw new DeliveryError('Meta accepted the request without returning a message ID. Check WhatsApp Manager before retrying.','review');
  return{provider:'meta',messageId,providerStatus:'accepted'};
}

export async function sendMessage(config:SchoolConfig,input:{
  channel:MessageChannel;
  to:string;
  subject?:string|null|undefined;
  recipientName?:string|null|undefined;
  body:string;
  html?:string|null|undefined;
  messageKey?:string|undefined;
}){
  if(input.channel==='email'){
    if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.to))throw new DeliveryError('Enter a valid recipient email address.','permanent');
    if(config.EMAIL_DELIVERY_MODE==='testing'&&input.to.toLowerCase()!==config.RESEND_TEST_RECIPIENT?.toLowerCase())throw new DeliveryError('Email is in testing mode. This recipient has not been contacted. Verify a sending domain and enable production delivery.','configuration');
    const subject=input.subject||'Revolt-X School notification';
    const htmlContent=input.html||('<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172027">'+
      '<h2 style="margin:0 0 14px">Revolt-X School</h2>'+
      (input.recipientName?'<p>Hello '+htmlEscape(input.recipientName)+',</p>':'')+
      '<div style="white-space:pre-wrap">'+htmlEscape(input.body).replace(/\n/g,'<br>')+'</div>'+
      '<p style="margin-top:24px;color:#667780;font-size:12px">This is an automated notification from Revolt-X School.</p></div>');
    const candidates=emailProviderCandidates(config);
    if(!candidates.length)throw new DeliveryError('No email provider is configured.','configuration');
    const failures:string[]=[];

    for(const provider of candidates){
      try{
        if(provider==='brevo'){
          if(!config.BREVO_API_KEY)throw new Error('Brevo email provider is not configured');
          const sender=await resolveBrevoSender(config);
          const data=await messageRequest('Brevo','https://api.brevo.com/v3/smtp/email',{
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
              textContent:input.body,
              ...(config.EMAIL_REPLY_TO?{replyTo:{email:config.EMAIL_REPLY_TO}}:{}),
              tags:['revolt-x-school']
            }),
            signal:AbortSignal.timeout(15000)
          });
          const messageId=String(data.messageId||data.messageIds?.[0]||'');
          if(!messageId)throw new DeliveryError('Brevo returned no message ID. Check its delivery log before retrying.','review');
          return{provider:'brevo',messageId,providerStatus:'accepted'};
        }

        if(!config.RESEND_API_KEY||!config.RESEND_FROM_EMAIL)throw new DeliveryError('Resend email provider is not configured.','configuration');
        const resendTesting=usesResendTestSender(config);
        if(resendTesting&&(config.EMAIL_DELIVERY_MODE==='production'||input.to.toLowerCase()!==config.RESEND_TEST_RECIPIENT?.toLowerCase()))throw new DeliveryError('Resend test sender cannot contact this recipient. No test copy was redirected. Verify a sending domain and update the sender address.','configuration');
        const data=await messageRequest('Resend','https://api.resend.com/emails',{
          method:'POST',
          headers:{authorization:'Bearer '+config.RESEND_API_KEY,'content-type':'application/json',...(input.messageKey?{'Idempotency-Key':'school-message/'+input.messageKey}:{})},
          body:JSON.stringify({
            from:config.RESEND_FROM_EMAIL,
            to:[input.to],
            subject,
            html:htmlContent,
            text:input.body,
            ...(config.EMAIL_REPLY_TO?{reply_to:config.EMAIL_REPLY_TO}:{})
          }),
          signal:AbortSignal.timeout(15000)
        },Boolean(input.messageKey));
        if(!data.id)throw new DeliveryError('Resend returned no message ID. Check its delivery log before retrying.','review');
        return{provider:'resend',messageId:String(data.id),providerStatus:'accepted'};
      }catch(error:any){
        failures.push(provider+': '+String(error?.message||error));
        if(config.EMAIL_PROVIDER!=='auto'||(error instanceof DeliveryError&&error.kind!=='configuration'))throw error;
      }
    }
    throw new DeliveryError('All configured email providers failed. '+failures.join(' | '),'configuration');
  }
  if(input.channel==='whatsapp'&&selectedWhatsappProvider(config)==='meta')return sendMetaWhatsapp(config,input);
  return sendTwilio(config,input.channel,input.to,input.body,input.subject,input.recipientName);
}

export async function initializePaystack(config:SchoolConfig,input:{
  email:string;
  amount:number;
  currency:string;
  reference:string;
  channels?:PaystackChannel[]|undefined;
  callbackUrl:string;
  metadata:Record<string,unknown>;
}){
  if(!config.PAYSTACK_SECRET_KEY)throw new Error('Paystack is not configured');
  const payload:any={
    email:input.email,
    amount:String(Math.round(input.amount*100)),
    currency:input.currency,
    reference:input.reference,
    callback_url:input.callbackUrl,
    metadata:input.metadata
  };
  if(input.channels?.length)payload.channels=input.channels;
  const res=await fetch('https://api.paystack.co/transaction/initialize',{
    method:'POST',
    headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY,'content-type':'application/json'},
    body:JSON.stringify(payload),
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
