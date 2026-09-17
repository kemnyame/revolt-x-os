import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { one } from '../db/index.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function previewRoutes(app:FastifyInstance,{db,config}:{db:Db;config:Config}){
  app.post('/v1/auth/preview-session',async()=>{
    const owner=await one<{user_id:string;organisation_id:string}>(db,`SELECT m.user_id,m.organisation_id FROM organisation_memberships m JOIN users u ON u.id=m.user_id JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id WHERE m.status='active' AND u.status='active' AND r.key='owner' ORDER BY m.joined_at LIMIT 1`);
    const p=await db.query<{key:string}>(`SELECT DISTINCT p.key FROM organisation_memberships m JOIN membership_roles mr ON mr.membership_id=m.id JOIN role_permissions rp ON rp.role_id=mr.role_id JOIN permissions p ON p.id=rp.permission_id WHERE m.user_id=$1 AND m.organisation_id=$2 AND m.status='active'`,[owner.user_id,owner.organisation_id]);
    const refreshToken=randomBytes(48).toString('base64url');
    const session=await one<{id:string}>(db,`INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '8 hours') RETURNING id`,[owner.user_id,owner.organisation_id,hash(refreshToken)]);
    const accessToken=await new SignJWT({organisationId:owner.organisation_id,sessionId:session.id,permissions:p.rows.map(x=>x.key),preview:true}).setProtectedHeader({alg:'HS256'}).setSubject(owner.user_id).setIssuedAt().setExpirationTime('8h').sign(new TextEncoder().encode(config.JWT_SECRET));
    return {accessToken,expiresIn:28800,organisationId:owner.organisation_id,preview:true};
  });
}
