import {createHash} from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js'; import type { Db } from '../db/index.js';
import { login, logout, refresh, registerOrganisation, requestPasswordReset, resetPassword } from './service.js';
import {deliverOsPasswordReset} from './password-reset-email.js';
import { unauthorized } from '../core/errors.js';
import {changeOwnOsPassword,newPasswordSchema} from './password-change.js';
import { revokeLinkedSchoolSessions } from './school-sessions.js';
const password=z.string().min(8,'Password must be at least 8 characters').max(128).regex(/[a-z]/,'Password must contain a lowercase letter').regex(/[A-Z]/,'Password must contain an uppercase letter').regex(/[0-9]/,'Password must contain a number');
const meta=(r:FastifyRequest)=>({ipAddress:r.ip,userAgent:r.headers['user-agent']});
export async function authRoutes(app:FastifyInstance,options:{db:Db;config:Config}){
 app.post('/v1/auth/register-organisation',{schema:{body:{type:'object'}}},async(request,reply)=>{const body=z.object({organisationName:z.string().trim().min(2).max(200),slug:z.string().trim().min(3).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),firstName:z.string().trim().min(1).max(100),lastName:z.string().trim().min(1).max(100),email:z.string().trim().toLowerCase().email(),password}).parse(request.body);return reply.code(201).send(await registerOrganisation(options.db,options.config,body,meta(request)))});
 app.post('/v1/auth/login',async request=>login(options.db,options.config,z.object({email:z.string().trim().toLowerCase().email(),password:z.string().min(1),organisationId:z.string().uuid().optional()}).parse(request.body),meta(request)));
 app.post('/v1/auth/change-password',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{
   if(!request.auth)throw unauthorized();
   reply.header('cache-control','no-store');
   const body=z.object({currentPassword:z.string().min(1).max(128),newPassword:newPasswordSchema}).parse(request.body);
   return changeOwnOsPassword(options.db,request.auth,body.currentPassword,body.newPassword);
 });
 app.post('/v1/auth/password-reset/request',{config:{rateLimit:{max:10,timeWindow:'1 hour'}}},async(request,reply)=>{
   reply.header('cache-control','no-store');
   const body=z.object({email:z.string().trim().toLowerCase().email()}).parse(request.body);
   const result=await requestPasswordReset(options.db,body.email,meta(request));
   if(result.resetToken)try{await deliverOsPasswordReset(options.config,body.email,result.resetToken)}
   catch{request.log.error({code:'OS_RECOVERY_DELIVERY_FAILED'},'OS recovery email could not be delivered');}
   return{accepted:true};
 });
 app.get('/v1/auth/password-reset/context',{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(request,reply)=>{
   reply.header('cache-control','no-store');
   const query=z.object({
     token:z.string().trim().min(32).max(500).regex(/^[A-Za-z0-9_-]+$/),
     schoolId:z.string().trim().min(1).max(120),
     purpose:z.literal('school_admin').default('school_admin')
   }).parse(request.query);
   const tokenHash=createHash('sha256').update(query.token).digest('hex');
   const result=await options.db.query(`SELECT pr.user_id,u.email,u.first_name,u.last_name,o.id organisation_id,o.slug organisation_slug,o.name organisation_name
     FROM password_reset_tokens pr JOIN users u ON u.id=pr.user_id
     JOIN organisation_memberships m ON m.user_id=pr.user_id AND m.organisation_id=pr.organisation_id
     JOIN organisations o ON o.id=pr.organisation_id
     WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at>now() AND pr.purpose='school_admin'
       AND (lower(o.slug)=lower($2) OR o.id::text=$2)
       AND u.status='active' AND m.status='active' AND o.status='active'
       AND o.settings->>'primaryAdminUserId'=u.id::text
       AND EXISTS(SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school')
       AND EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.membership_id=m.id AND r.key='owner')
     LIMIT 1`,[tokenHash,query.schoolId]);
   const row=result.rows[0] as any;if(!row)throw unauthorized('Reset link is invalid, expired, or does not belong to this school. Generate a new link.');
   return{administrator:{id:row.user_id,email:row.email,name:[row.first_name,row.last_name].filter(Boolean).join(' ')},school:{id:row.organisation_slug,name:row.organisation_name}};
 });
 app.post('/v1/auth/password-reset/confirm',async(request,reply)=>{
   reply.header('cache-control','no-store');
   const body=z.object({token:z.string().trim().min(32).max(500).regex(/^[A-Za-z0-9_-]+$/),password,
     schoolId:z.preprocess(v=>v==null||(typeof v==='string'&&!v.trim())?undefined:v,z.string().trim().min(1).max(120).optional()),
     purpose:z.enum(['account','school_admin']).optional()
   }).parse(request.body);
   return resetPassword(options.db,body.token,body.password,meta(request),{
     schoolId:body.schoolId,purpose:body.purpose,
     revokeSchoolSessions:(userId,organisationId)=>revokeLinkedSchoolSessions(options.db,options.config,userId,undefined,organisationId)
   });
 });
 app.post('/v1/auth/refresh',async request=>refresh(options.db,options.config,z.object({refreshToken:z.string().min(32)}).parse(request.body).refreshToken,meta(request)));
 app.get('/v1/auth/context',{config:{rateLimit:{max:1200,timeWindow:'1 minute'}}},async request=>{if(!request.auth)throw unauthorized();const a=request.auth;const user=await options.db.query(`SELECT u.id,u.email,u.first_name,u.last_name,u.status,m.id membership_id,m.job_title,m.status membership_status,o.id organisation_id,o.name organisation_name,o.slug organisation_slug FROM users u JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id WHERE u.id=$1 AND o.id=$2 LIMIT 1`,[a.userId,a.organisationId]);if(!user.rowCount)throw unauthorized('User context is no longer available');return{...user.rows[0],sessionId:a.sessionId,permissions:a.permissions,preview:a.preview===true,requiresPasswordChange:Boolean(a.passwordChangeRequired)}});
 app.post('/v1/auth/logout',async(request,reply)=>{if(!request.auth)throw unauthorized();await logout(options.db,request.auth,meta(request));return reply.code(204).send()});
}

