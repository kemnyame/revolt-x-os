import bcrypt from 'bcryptjs';
import type {Db} from '../db/index.js';
import {transaction} from '../db/index.js';

/** Backfill legacy school credentials, then initialize only pending staff invitations.
 * OS passwords, other schools, primary administrators and assigned passwords survive. */
export async function bootstrapSchoolStaffPasswords(db:Db,temporaryPassword:string){
  return transaction(db,async q=>{
    await q.query(`INSERT INTO school_credentials(organisation_id,user_id,password_hash,must_change_password,initialized_at)
      SELECT DISTINCT m.organisation_id,u.id,u.password_hash,u.must_change_password,u.school_password_bootstrapped_at
      FROM organisation_memberships m JOIN users u ON u.id=m.user_id
      JOIN saas_customers c ON c.customer_organisation_id=m.organisation_id AND c.customer_type='school'
      ON CONFLICT(organisation_id,user_id) DO NOTHING`);
    const eligible=await q.query<{user_id:string;organisation_id:string;membership_id:string}>(`
      SELECT sc.user_id,sc.organisation_id,m.id membership_id FROM school_credentials sc
      JOIN users u ON u.id=sc.user_id JOIN school_accounts sa ON sa.user_id=sc.user_id AND sa.organisation_id=sc.organisation_id JOIN organisation_memberships m ON m.user_id=sc.user_id AND m.organisation_id=sc.organisation_id
      JOIN organisations o ON o.id=sc.organisation_id
      JOIN saas_customers c ON c.customer_organisation_id=sc.organisation_id AND c.customer_type='school'
      WHERE sc.initialized_at IS NULL AND sc.must_change_password=true
        AND sa.status IN('active','invited') AND lower(u.email)<>'preview@revolt-x.local'
        AND m.status IN('active','invited') AND o.status='active' AND c.status<>'archived'
        AND (o.settings->>'primaryAdminUserId' IS NULL OR o.settings->>'primaryAdminUserId'<>sc.user_id::text)
      FOR UPDATE OF sc`);
    if(!eligible.rowCount)return 0;
    const hash=await bcrypt.hash(temporaryPassword,12);
    for(const row of eligible.rows)await q.query(`UPDATE school_credentials SET password_hash=$1,initialized_at=now(),updated_at=now()
      WHERE user_id=$2 AND organisation_id=$3`,[hash,row.user_id,row.organisation_id]);
    for(const row of eligible.rows)await q.query("UPDATE school_accounts SET status='active',updated_at=now() WHERE user_id=$1 AND organisation_id=$2 AND status='invited'",[row.user_id,row.organisation_id]);
    await q.query("UPDATE organisation_memberships SET status='active' WHERE id=ANY($1::uuid[]) AND status='invited'",[eligible.rows.map(x=>x.membership_id)]);
    return eligible.rows.length;
  });
}
