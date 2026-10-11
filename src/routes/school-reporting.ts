import type {FastifyInstance} from 'fastify';
import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import {maybeOne} from '../db/index.js';
import {requirePermission} from '../core/http.js';
import {AppError,notFound} from '../core/errors.js';
import {schoolReportQuery,csvReport} from './commercial-reporting.js';

async function managedSchool(db:Db,providerId:string,schoolId:string){
  const school=await maybeOne<any>(db,`SELECT o.id,o.name,o.slug FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id
    WHERE c.provider_organisation_id=$1 AND c.customer_organisation_id=$2 AND c.customer_type='school'`,[providerId,schoolId]);
  if(!school)throw notFound('Managed school');return school;
}

export function registerCommercialSchoolReporting(app:FastifyInstance,{db,config}:{db:Db;config:Config}){
  app.get('/v1/commercial-control/support/admin-activity',async(request,reply)=>{
    const a=requirePermission(request,'commercial.read'),q=schoolReportQuery.parse(request.query);
    const school=await managedSchool(db,a.organisationId,q.schoolId);
    if(!config.SCHOOL_APP_URL||!config.SCHOOL_SERVICE_KEY)throw new AppError(503,'SCHOOL_NOT_CONFIGURED','The School connection is not configured.');
    const url=new URL(config.SCHOOL_APP_URL.replace(/\/$/,'')+'/api/internal/admin-activity');
    url.searchParams.set('organisationId',school.id);url.searchParams.set('limit',String(q.format==='csv'?10000:q.limit));
    if(q.from)url.searchParams.set('from',q.from);if(q.to)url.searchParams.set('to',q.to);
    const response=await fetch(url,{headers:{'x-revolt-service-key':config.SCHOOL_SERVICE_KEY},signal:AbortSignal.timeout(20000)}).catch(()=>null);
    if(!response?.ok)throw new AppError(503,'SCHOOL_LOGS_UNAVAILABLE','School administrator logs could not be loaded. Please try again.');
    const payload:any=await response.json().catch(()=>null);
    if(!Array.isArray(payload?.rows))throw new AppError(503,'SCHOOL_LOGS_UNAVAILABLE','The School log response could not be verified.');
    if(q.format==='csv'&&Number(payload.total)>payload.rows.length)throw new AppError(413,'REPORT_TOO_LARGE','The report has more than 10,000 entries. Select a shorter reporting period.');
    const ids=[...new Set(payload.rows.map((row:any)=>row.actor_os_user_id).filter(Boolean))];
    const users=ids.length?(await db.query('SELECT id,email,first_name,last_name FROM users WHERE id=ANY($1::uuid[])',[ids])).rows:[];
    const rows=payload.rows.map((row:any)=>{const user=users.find((u:any)=>u.id===row.actor_os_user_id);return{...row,school_id:school.id,school_name:school.name,school_slug:school.slug,actor_name:user?[user.first_name,user.last_name].filter(Boolean).join(' '):'System',actor_email:user?.email??null}});
    if(q.format==='csv')return reply.header('cache-control','no-store').header('content-disposition','attachment; filename="school-admin-logs-'+school.id+'-'+(q.from||'all')+'-'+(q.to||'all')+'.csv"')
      .type('text/csv; charset=utf-8').send(csvReport(rows,[{key:'created_at',label:'Time (UTC)'},{key:'school_name',label:'School'},{key:'actor_name',label:'Administrator'},{key:'actor_email',label:'Email'},{key:'action',label:'Action'},{key:'resource_type',label:'Resource'},{key:'resource_id',label:'Record'}]));
    return rows;
  });

  app.get('/v1/commercial-control/support/school-billing',async request=>{
    const a=requirePermission(request,'commercial.read'),q=schoolReportQuery.parse(request.query),school=await managedSchool(db,a.organisationId,q.schoolId);
    const params=[a.organisationId,q.schoolId,q.from??null,q.to??null];
    const invoices=(await db.query(`SELECT * FROM saas_invoices WHERE provider_organisation_id=$1 AND customer_organisation_id=$2
      AND ($3::date IS NULL OR created_at>=($3::date::timestamp AT TIME ZONE 'UTC')) AND ($4::date IS NULL OR created_at<(($4::date+interval '1 day') AT TIME ZONE 'UTC')) ORDER BY created_at DESC,id`,params)).rows;
    const payments=(await db.query(`SELECT p.*,i.invoice_no FROM saas_subscription_payments p LEFT JOIN saas_invoices i ON i.id=p.invoice_id
      WHERE p.provider_organisation_id=$1 AND p.customer_organisation_id=$2
        AND ($3::date IS NULL OR p.paid_at>=($3::date::timestamp AT TIME ZONE 'UTC')) AND ($4::date IS NULL OR p.paid_at<(($4::date+interval '1 day') AT TIME ZONE 'UTC')) ORDER BY p.paid_at DESC,p.id`,params)).rows;
    return{school,invoices,payments};
  });
}
