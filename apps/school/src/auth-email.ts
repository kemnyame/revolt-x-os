import {createHash,randomUUID} from 'node:crypto';
import type {SchoolConfig} from './config.js';
import {DeliveryError,sendMessage} from './providers.js';

export type AuthEmail={to:string;subject:string;body:string;html:string;messageKey:string};
const address=(value:string)=>/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value)&&value.length<=254;
export const escapeAuthHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function gmailMailerUrl(value:string|undefined){
 let url:URL;try{url=new URL(value||'')}catch{throw new DeliveryError('Connect the Gmail sender before sending account emails.','configuration')}
 if(url.origin!=='https://script.google.com'||!/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)||url.search||url.hash||url.username||url.password)throw new DeliveryError('Use the deployed Google Apps Script web app URL ending in /exec.','configuration');
 return url.toString();
}
export function authEmailStatus(config:SchoolConfig){
 if(config.AUTH_EMAIL_PROVIDER!=='gmail')return{provider:'existing',configured:false,sender:null,immediate:true,note:'Account email uses the existing provider. Gmail has not been connected.'};
 let valid=false;try{gmailMailerUrl(config.GMAIL_MAILER_URL);valid=Boolean(config.GMAIL_MAILER_SECRET&&config.GMAIL_FROM_EMAIL)}catch{}
 return{provider:'gmail',configured:valid,sender:config.GMAIL_FROM_EMAIL||null,immediate:true,note:valid?'Gmail sender configured. Verify it with a connection test.':'The school Gmail sender needs its one-time Google authorization and connection details.'};
}
/** Security emails are sent now; they never enter the hourly reminder queue. */
export async function sendAuthEmail(config:SchoolConfig,input:AuthEmail){
 if(!address(input.to)||/[\r\n]/.test(input.subject))throw new DeliveryError('The account email address or subject is invalid.','permanent');
 if(config.AUTH_EMAIL_PROVIDER!=='gmail')return sendMessage(config,{channel:'email',...input});
 const url=gmailMailerUrl(config.GMAIL_MAILER_URL),sender=config.GMAIL_FROM_EMAIL,secret=config.GMAIL_MAILER_SECRET;
 if(!sender||!address(sender)||!secret)throw new DeliveryError('The school Gmail sender has not been connected.','configuration');
 const requestId=createHash('sha256').update(input.messageKey).digest('hex');
 let response:Response;
 try{
  response=await fetch(url,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({secret,requestId,expectedSender:sender,to:input.to,subject:input.subject,text:input.body,html:input.html,replyTo:config.EMAIL_REPLY_TO||sender}),signal:AbortSignal.timeout(12000)});
  if(response.status===302||response.status===303){
   const location=response.headers.get('location');let target:URL;try{target=new URL(location||'')}catch{throw new DeliveryError('The Gmail connection returned an invalid response.','configuration')}
   if(target.origin!=='https://script.googleusercontent.com'||target.pathname!=='/macros/echo')throw new DeliveryError('Authorize the Gmail sender and deploy it to run as its owner.','configuration');
   // Google's content-service redirect is a GET. No shared secret or message is forwarded.
   response=await fetch(target.toString(),{redirect:'error',signal:AbortSignal.timeout(8000)});
  }
 }catch(error){if(error instanceof DeliveryError)throw error;throw new DeliveryError('Gmail submission was interrupted. Review the sending log before resending.','review')}
 const result:any=await response.json().catch(()=>null);
 if(response.ok&&result?.ok===true&&typeof result.id==='string'&&result.id.startsWith('gas-')&&result.sender===sender)return{provider:'gmail',messageId:result.id,providerStatus:'accepted'};
 if(['AUTH','NOT_CONFIGURED','WRONG_SENDER'].includes(result?.code))throw new DeliveryError('The Gmail sender connection needs authorization or its settings do not match.','configuration');
 if(result?.code==='QUOTA'||result?.code==='BUSY')throw new DeliveryError('Gmail is temporarily unable to accept another email. Try again later.','transient');
 throw new DeliveryError('Gmail acceptance was not confirmed. Review the sending log before resending.','review');
}
export function schoolAccessEmail(config:SchoolConfig,input:{email:string;schoolSlug:string;schoolName:string;name?:string|undefined;staffId?:string|null|undefined;kind:'welcome'|'password_reset';resetToken?:string|undefined;administrator?:boolean|undefined;userId?:string|undefined}):AuthEmail{
 const base=new URL(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com');
 if(base.protocol!=='https:'&&config.NODE_ENV==='production')throw new DeliveryError('A secure School address is required.','configuration');
 const loginPath='/s/'+encodeURIComponent(input.schoolSlug)+(input.administrator?'/admin-login':'/login');
 const login=new URL(loginPath,base);if(input.administrator&&input.userId)login.searchParams.set('admin',input.userId);
 let action=login.toString(),actionLabel='Open School login';
 if(input.resetToken){
  if(!/^[A-Za-z0-9_-]{32,500}$/.test(input.resetToken))throw new DeliveryError('The reset link is invalid.','permanent');
  action=new URL('/s/'+encodeURIComponent(input.schoolSlug)+(input.administrator?'/admin-password-reset':'/staff-password-setup'),base).toString()+'?token='+encodeURIComponent(input.resetToken);
  actionLabel=input.kind==='welcome'?'Choose your password':'Reset your password';
 }
 const subject=input.kind==='welcome'?'Your '+input.schoolName+' School login':'Reset your '+input.schoolName+' School password';
 const intro=input.kind==='welcome'?'Your school account is ready.':'A password reset was requested for your school account.';
 const details=[intro,'School: '+input.schoolName,...(input.staffId?['Staff ID: '+input.staffId]:[]),'Email: '+input.email];
 const expiry=input.resetToken?'This secure link is single-use and expires in 30 minutes.':'Use the temporary password supplied separately by your administrator. You must choose your own password on first sign-in.';
 const body=[...details,'',actionLabel+': '+action,'',expiry,'If you did not expect this email, contact your school administrator. Your Revolt-X OS password is separate.'].join('\n');
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeAuthHtml(subject)+'</title></head><body style="font:16px/1.7 Arial,sans-serif;background:#f4f7fb;padding:24px;color:#193345"><main style="max-width:560px;margin:auto;background:white;padding:28px;border-radius:14px"><p>REVOLT-X SCHOOL</p><h1 style="font-size:25px">'+escapeAuthHtml(input.kind==='welcome'?'Your School login is ready.':'Reset your School password.')+'</h1>'+details.map(line=>'<p>'+escapeAuthHtml(line)+'</p>').join('')+'<p><a style="display:inline-block;padding:15px 22px;border-radius:8px;background:#315466;color:white;text-decoration:none" href="'+escapeAuthHtml(action)+'">'+actionLabel+'</a></p><p>'+escapeAuthHtml(expiry)+'</p><p>If you did not expect this email, contact your school administrator. Your Revolt-X OS password is separate.</p></main></body></html>';
 return{to:input.email,subject,body,html,messageKey:'school-access/'+(input.resetToken?createHash('sha256').update(input.resetToken).digest('hex'):randomUUID())};
}
