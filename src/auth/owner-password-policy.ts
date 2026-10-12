import bcrypt from 'bcryptjs';
import type {Db} from '../db/index.js';
import {maybeOne,transaction} from '../db/index.js';

/** Checkpoint the historical override without changing existing passwords.
 * Future explicit configuration changes run once; user resets survive restarts. */
export async function applyOwnerPasswordPolicy(db:Db,password:string,revokeSchoolSessions?:(userId:string)=>Promise<void>){
  if(!password||password.length<10)return 0;
  return transaction(db,async q=>{
    await q.query("SELECT pg_advisory_xact_lock(hashtext('owner-password-policy'))");
    const state=await maybeOne<any>(q,"SELECT value_hash FROM auth_configuration_state WHERE key='owner_password_reset' FOR UPDATE");
    if(state&&await bcrypt.compare(password,state.value_hash))return 0;
    const hash=await bcrypt.hash(password,12);let changed=0;
    if(state){
      const result=await q.query(`UPDATE users u SET password_hash=$1,must_change_password=false,updated_at=now()
        WHERE u.status='active' AND EXISTS(SELECT 1 FROM organisation_memberships m
          JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id
          WHERE m.user_id=u.id AND m.status='active' AND m.organisation_id IN(SELECT DISTINCT provider_organisation_id FROM saas_customers)
            AND (r.key='owner' OR EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id AND p.key='commercial.manage')))
        RETURNING id`,[hash]);
      changed=result.rowCount??0;
      for(const user of result.rows)await revokeSchoolSessions?.(user.id);
      if(changed)await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL',[result.rows.map(x=>x.id)]);
    }
    await q.query("INSERT INTO auth_configuration_state(key,value_hash) VALUES('owner_password_reset',$1) ON CONFLICT(key) DO UPDATE SET value_hash=EXCLUDED.value_hash,updated_at=now()",[hash]);
    return changed;
  });
}
