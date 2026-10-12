import type {Config} from '../config.js';
import {AppError} from '../core/errors.js';

/** Use the existing trusted mail service. Credentials and reset URLs stay out of errors. */
export async function deliverOsPasswordReset(config:Config,email:string,resetToken:string){
  if(!config.SCHOOL_APP_URL||!config.SCHOOL_SERVICE_KEY)
    throw new AppError(503,'OS_RECOVERY_UNAVAILABLE','OS password recovery is temporarily unavailable.');
  const response=await fetch(config.SCHOOL_APP_URL.replace(/\/$/,'')+'/api/internal/os-password-reset-email',{
    method:'POST',headers:{'content-type':'application/json','x-revolt-service-key':config.SCHOOL_SERVICE_KEY},
    body:JSON.stringify({email,resetToken}),signal:AbortSignal.timeout(20000)
  }).catch(()=>null);
  const result:any=response?.ok?await response.json().catch(()=>null):null;
  if(result?.sent!==true)throw new AppError(503,'OS_RECOVERY_UNAVAILABLE','OS password recovery is temporarily unavailable.');
}
