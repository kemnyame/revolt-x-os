import type {Db} from '../db/index.js';

export async function setSchoolCredential(db:Db,organisationId:string,userId:string,passwordHash:string,mustChange=false){
  await db.query(`INSERT INTO school_credentials(organisation_id,user_id,password_hash,must_change_password,initialized_at)
    VALUES($1,$2,$3,$4,now()) ON CONFLICT(organisation_id,user_id) DO UPDATE
    SET password_hash=EXCLUDED.password_hash,must_change_password=EXCLUDED.must_change_password,initialized_at=now(),updated_at=now()`,
  [organisationId,userId,passwordHash,mustChange]);
}
export async function clearSchoolResetTokens(db:Db,userId:string,organisationId:string){
  await db.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND organisation_id=$2 AND purpose IN('school_admin','school_staff') AND used_at IS NULL",[userId,organisationId]);
}
