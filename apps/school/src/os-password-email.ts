import {createHash} from 'node:crypto';
import type {SchoolConfig} from './config.js';
import {sendMessage} from './providers.js';

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export function osPasswordResetMessage(config:SchoolConfig,email:string,resetToken:string){
  const url=new URL('/password-reset',config.CORE_OS_URL);
  if(url.protocol!=='https:'&&!(config.NODE_ENV!=='production'&&url.protocol==='http:'))throw new Error('OS recovery requires a secure configured origin');
  url.searchParams.set('token',resetToken);
  const link=url.toString();
  return{
    channel:'email' as const,to:email,subject:'Reset your Revolt-X OS password',
    messageKey:'os-password-reset/'+createHash('sha256').update(resetToken).digest('hex'),
    body:'A password reset was requested for your Revolt-X OS account.\n\nReset your OS password: '+link+'\n\nThis link expires in 30 minutes and can be used once. Your school passwords will stay the same. If you did not request this, ignore this email. Your password has not changed.',
    html:'<!doctype html><html lang="en"><body style="margin:0;padding:32px 20px;background:#f4f7fb;font-family:Arial,sans-serif;color:#172536"><main style="max-width:540px;margin:auto;padding:32px;background:white;border-radius:16px"><p style="font-weight:bold;color:#1f63db">REVOLT-X OS</p><h1 style="font-size:26px">Reset your OS password</h1><p>A password reset was requested for your Revolt-X OS account.</p><p><a href="'+escapeHtml(link)+'" style="display:inline-block;padding:15px 24px;background:#1f63db;color:white;text-decoration:none;border-radius:8px;font-weight:bold">Reset OS password</a></p><p>This link expires in 30 minutes and can be used once. Your school passwords will stay the same.</p><p>If you did not request this, ignore this email. Your password has not changed.</p><p style="font-size:12px;color:#718096">If the button does not work, open this link:<br>'+escapeHtml(link)+'</p></main></body></html>'
  };
}

export async function sendOsPasswordReset(config:SchoolConfig,email:string,resetToken:string){
  await sendMessage(config,osPasswordResetMessage(config,email,resetToken));
}
