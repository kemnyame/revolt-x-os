import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js'; import type { Db } from '../db/index.js';
import { login, logout, refresh, registerOrganisation, requestPasswordReset, resetPassword } from './service.js';
import { unauthorized } from '../core/errors.js';
const password=z.string().min(8,'Password must be at least 8 characters').max(128).regex(/[a-z]/,'Password must contain a lowercase letter').regex(/[A-Z]/,'Password must contain an uppercase letter').regex(/[0-9]/,'Password must contain a number');
const meta=(r:FastifyRequest)=>({ipAddress:r.ip,userAgent:r.headers['user-agent']});
export async function authRoutes(app:FastifyInstance,options:{db:Db;config:Config}){
 app.post('/v1/auth/register-organisation',{schema:{body:{type:'object'}}},async(request,reply)=>{const body=z.object({organisationName:z.string().trim().min(2).max(200),slug:z.string().trim().min(3).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),firstName:z.string().trim().min(1).max(100),lastName:z.string().trim().min(1).max(100),email:z.string().trim().toLowerCase().email(),password}).parse(request.body);return reply.code(201).send(await registerOrganisation(options.db,options.config,body,meta(request)))});
 app.post('/v1/auth/login',async request=>login(options.db,options.config,z.object({email:z.string().trim().toLowerCase().email(),password:z.string().min(1),organisationId:z.string().uuid().optional()}).parse(request.body),meta(request)));
 app.post('/v1/auth/password-reset/request',async request=>{const body=z.object({email:z.string().trim().toLowerCase().email()}).parse(request.body);return requestPasswordReset(options.db,body.email,meta(request))});
 app.post('/v1/auth/password-reset/confirm',async request=>{const body=z.object({token:z.string().min(32),password}).parse(request.body);return resetPassword(options.db,body.token,body.password,meta(request))});
 app.post('/v1/auth/refresh',async request=>refresh(options.db,options.config,z.object({refreshToken:z.string().min(32)}).parse(request.body).refreshToken,meta(request)));
 app.get('/v1/auth/context',{config:{rateLimit:{max:1200,timeWindow:'1 minute'}}},async request=>{if(!request.auth)throw unauthorized();const a=request.auth;const user=await options.db.query(`SELECT u.id,u.email,u.first_name,u.last_name,u.status,m.id membership_id,m.job_title,m.status membership_status,o.id organisation_id,o.name organisation_name,o.slug organisation_slug FROM users u JOIN organisation_memberships m ON m.user_id=u.id JOIN organisations o ON o.id=m.organisation_id WHERE u.id=$1 AND o.id=$2 LIMIT 1`,[a.userId,a.organisationId]);if(!user.rowCount)throw unauthorized('User context is no longer available');return{...user.rows[0],sessionId:a.sessionId,permissions:a.permissions,preview:a.preview===true}});
 app.post('/v1/auth/logout',async(request,reply)=>{if(!request.auth)throw unauthorized();await logout(options.db,request.auth,meta(request));return reply.code(204).send()});
}
