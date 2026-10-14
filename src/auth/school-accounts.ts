import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Db } from '../db/index.js';
import { maybeOne, one } from '../db/index.js';

export function findSchoolAccount(db:Db,organisationId:string,email:string){
  return maybeOne<any>(db,`SELECT user_id id,email,first_name,last_name,status FROM school_accounts
    WHERE organisation_id=$1 AND lower(email)=lower($2)`,[organisationId,email.trim()]);
}

export async function nextSchoolStaffId(db:Db,organisationId:string){
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['school-staff-number:'+organisationId]);
  const row=await one<{next_no:number}>(db,`SELECT COALESCE(MAX(
    CASE WHEN employee_number ~ '^STF-[0-9]{6}$' THEN substring(employee_number from 5)::int ELSE NULL END
  ),0)+1 next_no FROM organisation_memberships WHERE organisation_id=$1`,[organisationId]);
  return 'STF-'+String(row.next_no).padStart(6,'0');
}

/** New school accounts never reuse an OS/other-school email record. The internal
 * user key satisfies existing foreign keys; its random OS credential is unrelated
 * to the school password. School identity and profile live in school_accounts. */
export async function createSchoolAccount(db:Db,organisationId:string,input:{email?:string|null;firstName:string;lastName:string;status?:string}){
  const user=await one<{id:string}>(db,`INSERT INTO users(email,password_hash,first_name,last_name,status,must_change_password,school_password_bootstrapped_at)
    VALUES($1,$2,$3,$4,$5,true,now()) RETURNING id`,[
    'school-'+randomBytes(24).toString('hex')+'@revolt-x.local',
    await bcrypt.hash(randomBytes(32).toString('base64url'),12),input.firstName,input.lastName,input.status??'active'
  ]);
  return one<any>(db,`INSERT INTO school_accounts(organisation_id,user_id,email,first_name,last_name,status)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING user_id id,email,first_name,last_name,status`,[
    organisationId,user.id,input.email?.trim().toLowerCase()||null,input.firstName,input.lastName,input.status??'active'
  ]);
}
