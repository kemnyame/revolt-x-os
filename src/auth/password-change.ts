import bcrypt from 'bcryptjs';
import {z} from 'zod';
import type {Db} from '../db/index.js';
import type {AuthContext} from '../core/types.js';
import {maybeOne,transaction} from '../db/index.js';
import {audit} from '../core/audit.js';
import {badRequest,unauthorized} from '../core/errors.js';

export const newPasswordSchema=z.string().min(12,'Use at least 12 characters').max(128)
  .regex(/[a-z]/,'Include a lowercase letter').regex(/[A-Z]/,'Include an uppercase letter').regex(/[0-9]/,'Include a number');

/** OS credentials are independent of every school credential. Revoke all OS
 * sessions so neither the temporary password nor an older token retains access. */
export async function changeOwnOsPassword(db:Db,auth:AuthContext,currentPassword:string,newPassword:string){
  return transaction(db,async client=>{
    const user=await maybeOne<{password_hash:string}>(client,`SELECT u.password_hash FROM users u
      JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id
      WHERE u.id=$1 AND m.organisation_id=$2 AND u.status='active' AND m.status='active' AND o.status='active'
      FOR UPDATE OF u`,[auth.userId,auth.organisationId]);
    if(!user)throw unauthorized('This account is no longer active');
    if(!await bcrypt.compare(currentPassword,user.password_hash))throw badRequest('The current password is incorrect');
    if(await bcrypt.compare(newPassword,user.password_hash))throw badRequest('Choose a password different from your temporary or current password');
    const hash=await bcrypt.hash(newPassword,12);
    await client.query('UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2',[hash,auth.userId]);
    await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND purpose='account' AND used_at IS NULL",[auth.userId]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[auth.userId]);
    await audit(client,{organisationId:auth.organisationId,actorUserId:auth.userId,sessionId:auth.sessionId,
      action:'auth.password_changed',resourceType:'user',resourceId:auth.userId,afterState:{passwordChanged:true}});
    return{changed:true,requiresSignIn:true};
  });
}
