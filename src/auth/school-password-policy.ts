import bcrypt from 'bcryptjs';
import type {Db} from '../db/index.js';
import {transaction} from '../db/index.js';

/** Initialize only legacy staff invitations already marked for a password change.
 * Primary administrators and deliberately assigned passwords must survive restarts. */
export async function bootstrapSchoolStaffPasswords(db:Db,temporaryPassword:string){
  return transaction(db,async q=>{
    const eligible=await q.query<{id:string}>(`SELECT u.id FROM users u
      WHERE u.school_password_bootstrapped_at IS NULL AND u.must_change_password=true
        AND u.status IN('active','invited') AND lower(u.email)<>'preview@revolt-x.local'
        AND EXISTS(SELECT 1 FROM organisation_memberships m
          JOIN organisations o ON o.id=m.organisation_id
          JOIN saas_customers c ON c.customer_organisation_id=m.organisation_id AND c.customer_type='school'
          WHERE m.user_id=u.id AND m.status IN('active','invited') AND o.status='active' AND c.status<>'archived')
        AND NOT EXISTS(SELECT 1 FROM organisations o WHERE o.settings->>'primaryAdminUserId'=u.id::text)
      FOR UPDATE OF u`);
    if(!eligible.rowCount)return 0;
    const ids=eligible.rows.map(x=>x.id),hash=await bcrypt.hash(temporaryPassword,12);
    await q.query(`UPDATE users SET password_hash=$1,status='active',school_password_bootstrapped_at=now(),updated_at=now()
      WHERE id=ANY($2::uuid[])`,[hash,ids]);
    await q.query(`UPDATE organisation_memberships m SET status='active'
      WHERE m.user_id=ANY($1::uuid[]) AND m.status='invited'
        AND EXISTS(SELECT 1 FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id
          WHERE c.customer_organisation_id=m.organisation_id AND c.customer_type='school' AND c.status<>'archived' AND o.status='active')`,[ids]);
    return ids.length;
  });
}
