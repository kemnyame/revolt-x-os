import {createHash} from 'node:crypto';
import bcrypt from 'bcryptjs';
import type {Db} from '../db/index.js';
import {maybeOne,one,transaction} from '../db/index.js';
import {audit} from '../core/audit.js';

export interface OsPasswordRecoveryRequest{userId:string;requestId:string;password:string}

/** Operator-requested recovery for one existing OS owner, supplied through secret
 * environment configuration. A successful request runs once; failed transactions
 * can be retried. School passwords and sessions remain independent. */
export async function applyOsPasswordRecovery(db:Db,request?:OsPasswordRecoveryRequest){
  if(!request)return 0;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(request.userId)||!uuid.test(request.requestId)
    ||request.password.length<12||request.password.length>128||!/[a-z]/.test(request.password)
    ||!/[A-Z]/.test(request.password)||!/[0-9]/.test(request.password))throw new Error('Invalid OS password recovery configuration');
  const key='os-password-recovery:'+request.requestId,identity=createHash('sha256').update(request.userId).digest('hex');
  return transaction(db,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))',['os-password-recovery:'+request.userId]);
    const state=await maybeOne<{value_hash:string}>(q,'SELECT value_hash FROM auth_configuration_state WHERE key=$1 FOR UPDATE',[key]);
    if(state){if(state.value_hash!==identity)throw new Error('OS password recovery request belongs to a different account');return 0}
    const owner=await maybeOne<{id:string;organisation_id:string}>(q,`SELECT u.id,m.organisation_id FROM users u
      JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id
      WHERE u.id=$1 AND u.status='active' AND m.status='active' AND o.status='active'
        AND EXISTS(SELECT 1 FROM saas_customers c WHERE c.provider_organisation_id=o.id)
        AND EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id
          WHERE mr.membership_id=m.id AND (r.key='owner' OR EXISTS(SELECT 1 FROM role_permissions rp
            JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id AND p.key='commercial.manage')))
      ORDER BY m.joined_at LIMIT 1 FOR UPDATE OF u`,[request.userId]);
    if(!owner)throw new Error('OS password recovery requires an active commercial owner account');
    const passwordHash=await bcrypt.hash(request.password,12);
    const updated=await one<{password_hash:string}>(q,`UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now()
      WHERE id=$2 RETURNING password_hash`,[passwordHash,owner.id]);
    if(!await bcrypt.compare(request.password,updated.password_hash))throw new Error('OS password recovery verification failed');
    await q.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND purpose='account' AND used_at IS NULL",[owner.id]);
    await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[owner.id]);
    await q.query('INSERT INTO auth_configuration_state(key,value_hash) VALUES($1,$2)',[key,identity]);
    await audit(q,{organisationId:owner.organisation_id,actorUserId:null,action:'auth.password_reset.operator_recovery',resourceType:'user',resourceId:owner.id,
      metadata:{requestId:request.requestId,passwordVerified:true,credentialScope:'os'}});
    return 1;
  });
}
