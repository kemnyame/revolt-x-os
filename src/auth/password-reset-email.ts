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

/** All identities come from authenticated Core workflows, not arbitrary public mail requests. */
export async function deliverSchoolAccessEmail(config:Config,input:{organisationId:string;schoolSlug:string;schoolName:string;email:string;kind:'welcome'|'password_reset';name?:string;resetToken?:string;userId?:string}){
  if(!config.SCHOOL_ACCESS_EMAILS)return{status:'not_configured'};
  if(!config.SCHOOL_APP_URL||!config.SCHOOL_SERVICE_KEY)return{status:'pending_configuration'};
  try{
    const response=await fetch(config.SCHOOL_APP_URL.replace(/\/$/,'')+'/api/internal/school-access-email',{method:'POST',headers:{'content-type':'application/json','x-revolt-service-key':config.SCHOOL_SERVICE_KEY},body:JSON.stringify({...input,administrator:true}),signal:AbortSignal.timeout(20000)});
    const result:any=response.ok?await response.json().catch(()=>null):null;
    return{status:result?.sent===true?'accepted':'needs_review'};
  }catch{return{status:'needs_review'};}
}
