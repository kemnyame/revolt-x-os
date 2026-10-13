import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { maybeOne, one, transaction } from '../db/index.js';
import { setSchoolCredential } from './school-credentials.js';
import { audit } from '../core/audit.js';

// These profiles already exist in the requested School demonstration roster.
// Keep their keys so existing class, subject and assessment links remain intact.
export const graceDemoTeachers = [
  ['35223a97-0d70-38eb-f3d8-e8477c1cac4b','Akosua','Boateng'],
  ['874347a9-338a-a8a7-66e0-3dca04e0bb53','Kwame','Asare'],
  ['78d1dcc9-7115-0433-88c6-5e56caaed34a','Esi','Amankwah'],
  ['7a87b2e7-844b-2330-381a-0d04d0c1b8fa','Yaw','Ofori'],
  ['b288d48c-ec45-1d55-9183-7668808ec8b3','Adwoa','Kusi'],
  ['c8562138-0c2f-1001-1605-f88530cea2d4','Kofi','Appiah'],
  ['7585fe2d-02f3-f244-f9d6-b8e999174b92','Ama','Agyeman'],
  ['cefb0b86-b823-5c3a-fa15-64806c0cbdfe','Kojo','Frimpong'],
  ['1ad69fe7-2c95-ee10-4413-0e9866eda3d7','Afia','Darko'],
  ['f681c6a8-b2b7-c28d-a95d-f27299d920a8','Nana','Acheampong'],
  ['9d7f4e43-77ce-85f8-3697-6149067f200b','Mavis','Addo'],
  ['969d4d7d-cdd3-827b-8ca9-48c0235ce6ec','Joseph','Tetteh'],
  ['5dae211d-9e70-072a-c8e9-2dfa62c42c11','Grace','Quaye'],
  ['8bff1cf8-ab64-4642-17cc-8be218e56402','Michael','Arthur'],
  ['f8ceb8c3-4502-51b8-1d11-bf1843ec2251','Linda','Amoako']
] as const;
const schoolId='f0941926-e7cf-46cf-b994-888ba642dd7d';
const marker='grace_demo_teachers_repaired_20261013';

/** Complete the explicitly requested demo assignments in the live Core database.
 * New credentials are random, separate from OS passwords and require a change.
 * Administrators issue usable temporary credentials through the existing reset
 * flow. Existing users, account status, roles and passwords are never replaced. */
export async function repairGraceDemoTeachers(db:Db){
  return transaction(db,async c=>{
    const school=await maybeOne<any>(c,"SELECT id,settings FROM organisations WHERE id=$1 AND slug='grace-prep-school' AND status='active' FOR UPDATE",[schoolId]);
    if(!school||school.settings?.[marker])return 0;
    const role=await one<{id:string}>(c,"SELECT id FROM roles WHERE key='member' AND organisation_id IS NULL");
    let created=0;
    for(const [index,profile] of graceDemoTeachers.entries()){
      const [id,firstName,lastName]=profile;
      const email='teacher'+String(index+1).padStart(2,'0')+'.demo@graceprep.example';
      let user=await maybeOne<any>(c,'SELECT id,email,status FROM users WHERE id=$1',[id]);
      if(user&&user.email!==email)throw Error('A demonstration teacher key belongs to another account');
      if(!user){
        const osHash=await bcrypt.hash(randomBytes(32).toString('base64url'),12);
        user=await one<any>(c,`INSERT INTO users(id,email,password_hash,first_name,last_name,status,must_change_password,school_password_bootstrapped_at)
          VALUES($1,$2,$3,$4,$5,'active',true,now()) RETURNING id,email,status`,[id,email,osHash,firstName,lastName]);
        created++;
      }
      const membership=await c.query(`INSERT INTO organisation_memberships(organisation_id,user_id,job_title,employee_number,login_staff_id,status)
        VALUES($1,$2,'Teacher',$3,$4,'active') ON CONFLICT(organisation_id,user_id) DO NOTHING RETURNING id`,
        [schoolId,id,'STF-'+String(100001+index),'GRACE-PREP-STF-'+String(100001+index)]);
      if(membership.rowCount)await c.query(`INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id)
        VALUES($1,$2,'organisation',$3) ON CONFLICT DO NOTHING`,[membership.rows[0].id,role.id,schoolId]);
      if(!await maybeOne(c,'SELECT 1 FROM school_credentials WHERE organisation_id=$1 AND user_id=$2',[schoolId,id])){
        await setSchoolCredential(c,schoolId,id,await bcrypt.hash(randomBytes(32).toString('base64url'),12),true);
      }
    }
    await c.query("UPDATE organisations SET settings=jsonb_set(COALESCE(settings,'{}'::jsonb),$2::text[],'true'::jsonb,true),updated_at=now() WHERE id=$1",[schoolId,[marker]]);
    await audit(c,{organisationId:schoolId,actorUserId:null,sessionId:null,action:'school_demo.teachers_linked',resourceType:'organisation',resourceId:schoolId,afterState:{created,profiles:graceDemoTeachers.length}});
    return created;
  });
}
