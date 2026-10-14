import type {Db} from '../db/index.js';
import {maybeOne} from '../db/index.js';
import {notFound} from '../core/errors.js';

export function schoolAdminLoginPath(school:string,administratorId?:string|null){
  return '/s/'+encodeURIComponent(school)+'/admin-login'+(administratorId?'?admin='+encodeURIComponent(administratorId):'');
}
export async function schoolAdministratorContext(db:Db,school:string,administratorId:string){
  const user=await maybeOne<any>(db,`SELECT u.id,sa.email,sa.first_name,sa.last_name,o.id organisation_id,o.slug organisation_slug,o.name organisation_name
    FROM users u JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id JOIN school_accounts sa ON sa.organisation_id=m.organisation_id AND sa.user_id=u.id
    WHERE (lower(o.slug)=lower($1) OR o.id::text=$1) AND u.id=$2
      AND sa.status='active' AND m.status='active' AND o.status='active'
      AND EXISTS(SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school')
      AND (o.settings->>'primaryAdminUserId'=u.id::text OR o.settings->>'primaryAdminUserId' IS NULL)
      AND EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.membership_id=m.id AND r.key='owner')`,[school,administratorId]);
  if(!user)throw notFound('School administrator login link. Open the current link from the school record.');
  return user;
}
