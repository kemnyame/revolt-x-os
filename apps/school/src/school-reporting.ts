import { schoolRecordId } from './record-id.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {SchoolDb} from './db.js';
import {maybeOne} from './db.js';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/,'Use YYYY-MM-DD for the reporting period.')
  .refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Select a valid calendar date.');
export function registerSchoolReportingRoutes(app:FastifyInstance,options:{db:SchoolDb;requireCoreServiceRequest:(request:any)=>void}){
  app.get('/api/internal/admin-activity',async request=>{
    options.requireCoreServiceRequest(request);
    const q=z.object({organisationId:schoolRecordId,from:date.optional(),to:date.optional(),limit:z.coerce.number().int().min(1).max(10000).default(200)})
      .refine(v=>!v.from||!v.to||v.from<=v.to,{path:['to'],message:'The end date must be on or after the start date.'}).parse(request.query);
    const school=await maybeOne(options.db,'SELECT school_name,tenant_slug FROM school_profiles WHERE organisation_id=$1',[q.organisationId]);
    if(!school)throw Object.assign(new Error('School tenant was not found'),{statusCode:404});
    // The end date is inclusive, using an exclusive midnight boundary on the next day.
    const rows=(await options.db.query(`SELECT id,actor_os_user_id,action,resource_type,resource_id,created_at,count(*) OVER() total_count
      FROM school_audit_logs WHERE organisation_id=$1
        AND ($2::date IS NULL OR created_at>=($2::date::timestamp AT TIME ZONE 'UTC'))
        AND ($3::date IS NULL OR created_at<(($3::date+interval '1 day') AT TIME ZONE 'UTC'))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[q.organisationId,q.from??null,q.to??null,q.limit])).rows;
    return{school,rows,total:Number(rows[0]?.total_count||0)};
  });
}
