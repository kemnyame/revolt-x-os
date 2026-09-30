import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { maybeOne, one } from '../db/index.js';
import { requirePermission } from '../core/http.js';
import { audit } from '../core/audit.js';
import { AppError, notFound } from '../core/errors.js';

type ReportDef={key:string;name:string;category:string;description:string;scope:'commercial'|'school'|'assurance'|'combined'};

const REPORT_CATALOG:ReportDef[]=[
  {key:'executive_summary',name:'Executive Organisation Summary',category:'Executive',description:'High-level organisation, licence, billing, usage, service and operational position.',scope:'combined'},
  {key:'customer_360',name:'Customer 360 Report',category:'Executive',description:'Complete commercial and operational summary for one customer organisation.',scope:'combined'},
  {key:'service_health',name:'Service Health Report',category:'Executive',description:'Provisioning, request health, licence sync, backup and operational health.',scope:'combined'},
  {key:'data_inventory',name:'Organisation Data Inventory',category:'Data & Assurance',description:'High-level inventory of tenant data areas and record coverage.',scope:'school'},
  {key:'licence_status',name:'Licence Status Report',category:'Licensing',description:'Current licence, expiry, plan, limits and commercial status.',scope:'commercial'},
  {key:'renewal_forecast',name:'Renewal & Expiry Forecast',category:'Licensing',description:'Renewal date, days remaining, grace state and subscription exposure.',scope:'commercial'},
  {key:'module_entitlements',name:'Module Entitlement Report',category:'Licensing',description:'Plan modules and school-specific entitlement overrides.',scope:'commercial'},
  {key:'usage_capacity',name:'Usage & Capacity Report',category:'Licensing',description:'Student, staff, campus and storage usage against plan limits.',scope:'combined'},
  {key:'billing_statement',name:'Subscription Billing Statement',category:'Billing',description:'Invoices, payments, balances and current subscription charges.',scope:'commercial'},
  {key:'outstanding_debt',name:'Outstanding Subscription Debt',category:'Billing',description:'Open, part-paid and overdue subscription balances.',scope:'commercial'},
  {key:'subscription_payments',name:'Subscription Payment History',category:'Billing',description:'Commercial payments received from the organisation.',scope:'commercial'},
  {key:'provisioning_history',name:'Provisioning History',category:'Service Delivery',description:'Tenant provisioning jobs, outcomes, errors and completion history.',scope:'commercial'},
  {key:'backup_history',name:'Backup & Recovery History',category:'Data & Assurance',description:'Backup jobs, status, size, checksum and retention history.',scope:'assurance'},
  {key:'audit_activity',name:'Audit Activity Report',category:'Data & Assurance',description:'Recent OS audit activity, failures, critical events and integrity coverage.',scope:'assurance'},
  {key:'security_access',name:'Access & Security Summary',category:'Data & Assurance',description:'Staff access, portal sessions and request-error indicators.',scope:'school'},
  {key:'enrolment_summary',name:'Student Enrolment Summary',category:'School Operations',description:'Student population and status distribution.',scope:'school'},
  {key:'student_status',name:'Student Status Report',category:'School Operations',description:'Active, graduated, withdrawn, suspended and other student status counts.',scope:'school'},
  {key:'admissions_summary',name:'Admissions Pipeline Summary',category:'School Operations',description:'Application pipeline counts by current admissions status.',scope:'school'},
  {key:'staff_summary',name:'Staff & Role Summary',category:'School Operations',description:'Active staff and distribution by School role.',scope:'school'},
  {key:'attendance_summary',name:'Attendance Summary',category:'Academics',description:'Attendance totals, present/absent/late counts and attendance rate.',scope:'school'},
  {key:'academic_structure',name:'Academic Structure Summary',category:'Academics',description:'Academic years, terms, grade levels, classes and subjects.',scope:'school'},
  {key:'assessment_summary',name:'Assessment & Scores Summary',category:'Academics',description:'Assessment, score and homework activity at a high level.',scope:'school'},
  {key:'fee_collection',name:'Fees & Collection Summary',category:'Finance',description:'Fees billed, collections and estimated outstanding amount.',scope:'school'},
  {key:'finance_summary',name:'Finance & Ledger Summary',category:'Finance',description:'Journal volume, debit/credit totals and finance activity.',scope:'school'},
  {key:'expense_summary',name:'Expense Summary',category:'Finance',description:'Expense count and aggregate expenditure.',scope:'school'},
  {key:'portal_adoption',name:'Parent & Student Portal Adoption',category:'Digital Adoption',description:'Parent and student portal session usage.',scope:'school'},
  {key:'communications_delivery',name:'Communications Delivery Summary',category:'Digital Adoption',description:'Queued, sent, failed and configuration-pending communications.',scope:'school'},
  {key:'request_health',name:'Application Request Health',category:'Technology',description:'Request volume, error count, server errors and average response time.',scope:'school'},
  {key:'audit_readiness',name:'Audit Readiness Pack',category:'Data & Assurance',description:'Licence, audit, backup, provisioning, finance and data inventory evidence.',scope:'combined'},
  {key:'management_pack',name:'Management Reporting Pack',category:'Executive',description:'Board/management-level commercial, operational, finance and assurance summary.',scope:'combined'},
  {key:'data_quality_summary',name:'Data Quality & Completeness Summary',category:'Data & Assurance',description:'High-level population and configuration indicators used to assess data completeness.',scope:'school'}
];

function schoolBase(config:Config){
  const x=String(config.SCHOOL_APP_URL||'').replace(/\/$/,'');
  if(!x)throw new AppError(503,'SCHOOL_APP_NOT_CONFIGURED','Revolt-X School application URL is not configured');
  return x;
}
function schoolHeaders(config:Config){
  if(!config.SCHOOL_SERVICE_KEY)throw new AppError(503,'SCHOOL_SERVICE_NOT_CONFIGURED','School service authentication is not configured');
  return {'x-revolt-service-key':config.SCHOOL_SERVICE_KEY};
}
async function fetchSchoolJson(config:Config,path:string,timeout=30000){
  const res=await fetch(schoolBase(config)+path,{headers:schoolHeaders(config),signal:AbortSignal.timeout(timeout)}).catch(()=>null);
  if(!res)throw new Error('Revolt-X School could not be reached');
  const payload=await res.json().catch(()=>null) as any;
  if(!res.ok)throw new Error(payload?.error?.message||'Revolt-X School request failed');
  return payload;
}
function canonical(value:unknown):string{
  if(value===null||value===undefined)return JSON.stringify(value??null);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object'){
    const o=value as Record<string,unknown>;
    return '{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}';
  }
  return JSON.stringify(value);
}
function statusCounts(rows:any[]){
  return Object.fromEntries(rows.map((x:any)=>[String(x.status),Number(x.count||0)]));
}
async function managedCustomer(db:Db,providerId:string,customerId:string){
  const row=await maybeOne<any>(db,`SELECT c.*,o.name,o.slug,o.status organisation_status
    FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id
    WHERE c.provider_organisation_id=$1 AND c.customer_organisation_id=$2`,[providerId,customerId]);
  if(!row)throw notFound('Customer organisation');
  return row;
}
async function commercialPack(db:Db,providerId:string,customerId:string){
  const customer=await managedCustomer(db,providerId,customerId);
  const subscription=await maybeOne<any>(db,`SELECT s.*,p.product_key,p.name product_name,pl.plan_key,pl.name plan_name
    FROM saas_subscriptions s JOIN saas_products p ON p.id=s.product_id
    LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id
    WHERE s.provider_organisation_id=$1 AND s.customer_organisation_id=$2
    ORDER BY s.created_at DESC LIMIT 1`,[providerId,customerId]);

  const [invoices,payments,domains,provisioning,usage,modules,backups,audits]=await Promise.all([
    db.query('SELECT invoice_no,status,currency,total,amount_paid,issued_at,due_at,paid_at,created_at FROM saas_invoices WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC',[providerId,customerId]),
    db.query('SELECT amount,currency,payment_method,provider,provider_reference,paid_at FROM saas_subscription_payments WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY paid_at DESC',[providerId,customerId]),
    db.query('SELECT domain,domain_type,status,verified_at,created_at FROM saas_customer_domains WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC',[providerId,customerId]),
    db.query('SELECT action,status,error,created_at,completed_at,details FROM saas_provisioning_jobs WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 ORDER BY created_at DESC LIMIT 50',[providerId,customerId]),
    db.query(`SELECT DISTINCT ON(metric_key) metric_key,metric_value,measured_at
      FROM saas_usage_snapshots WHERE provider_organisation_id=$1 AND customer_organisation_id=$2
      ORDER BY metric_key,measured_at DESC`,[providerId,customerId]),
    subscription?db.query(`SELECT pm.module_key,pm.name,
      COALESCE(sm.enabled,COALESCE(x.included,false)) enabled,
      sm.price_override,sm.limits
      FROM saas_product_modules pm
      LEFT JOIN saas_plan_modules x ON x.module_id=pm.id AND x.plan_id=$1
      LEFT JOIN saas_subscription_modules sm ON sm.module_id=pm.id AND sm.subscription_id=$2
      WHERE pm.product_id=$3 AND pm.is_active=true ORDER BY pm.sort_order,pm.name`,
      [subscription.plan_id,subscription.id,subscription.product_id]):Promise.resolve({rows:[]}),
    db.query(`SELECT id,status,progress,phase,table_count,row_count,size_bytes,checksum_sha256,
      requested_at,started_at,completed_at,retention_until,error
      FROM saas_backup_jobs WHERE provider_organisation_id=$1 AND customer_organisation_id=$2
      ORDER BY requested_at DESC LIMIT 30`,[providerId,customerId]),
    db.query(`SELECT id,action,resource_type,resource_id,outcome,severity,source,event_hash,created_at
      FROM audit_logs WHERE organisation_id=$1 AND (
        resource_id=$2 OR metadata->>'customerOrganisationId'=$2 OR after_state->>'customer_organisation_id'=$2
      ) ORDER BY created_at DESC LIMIT 100`,[providerId,customerId])
  ]);
  return{
    customer,subscription,
    invoices:invoices.rows,payments:payments.rows,domains:domains.rows,provisioning:provisioning.rows,
    usage:Object.fromEntries(usage.rows.map((x:any)=>[x.metric_key,{value:Number(x.metric_value),measuredAt:x.measured_at}])),
    modules:modules.rows,backups:backups.rows,audit:audits.rows
  };
}

function reportSelection(key:string,commercial:any,school:any){
  const licence={subscription:commercial.subscription,modules:commercial.modules,usage:commercial.usage};
  const billing={invoices:commercial.invoices,payments:commercial.payments};
  const service={domains:commercial.domains,provisioning:commercial.provisioning};
  const assurance={backups:commercial.backups,audit:commercial.audit,schoolAssurance:school?.assurance??null};
  const map:Record<string,any>={
    executive_summary:{customer:commercial.customer,licence,billingSummary:{
      invoices:commercial.invoices.length,
      outstanding:commercial.invoices.reduce((n:number,x:any)=>n+Math.max(0,Number(x.total)-Number(x.amount_paid)),0)
    },school},
    customer_360:{commercial,school},
    service_health:{service,licenceStatus:commercial.subscription?.status,schoolHealth:school?.assurance,backup:commercial.backups[0]??null},
    data_inventory:school?.dataInventory,
    licence_status:licence,
    renewal_forecast:{subscription:commercial.subscription},
    module_entitlements:commercial.modules,
    usage_capacity:{usage:commercial.usage,limits:commercial.subscription?.limits,students:school?.students,staff:school?.staff},
    billing_statement:billing,
    outstanding_debt:{invoices:commercial.invoices.filter((x:any)=>['issued','part_paid','overdue'].includes(x.status))},
    subscription_payments:commercial.payments,
    provisioning_history:commercial.provisioning,
    backup_history:commercial.backups,
    audit_activity:{osAudit:commercial.audit,schoolAudit:school?.assurance?.audit},
    security_access:{staff:school?.staff,portalAdoption:school?.portalAdoption,requestHealth:school?.assurance?.requests30Days},
    enrolment_summary:school?.students,
    student_status:school?.students?.byStatus,
    admissions_summary:school?.admissions,
    staff_summary:school?.staff,
    attendance_summary:school?.attendance,
    academic_structure:school?.academics,
    assessment_summary:school?.academics,
    fee_collection:school?.fees,
    finance_summary:school?.finance,
    expense_summary:school?.expenses,
    portal_adoption:school?.portalAdoption,
    communications_delivery:school?.communications,
    request_health:school?.assurance?.requests30Days,
    audit_readiness:{licence,service,assurance,finance:school?.finance,fees:school?.fees,dataInventory:school?.dataInventory},
    management_pack:{customer:commercial.customer,licence,billing,service,school,assurance},
    data_quality_summary:{
      students:school?.students,staff:school?.staff,academics:school?.academics,
      admissions:school?.admissions,dataInventory:school?.dataInventory
    }
  };
  return map[key]??{commercial,school};
}

async function runReportJob(db:Db,config:Config,id:string){
  const job=await maybeOne<any>(db,'SELECT * FROM saas_report_requests WHERE id=$1',[id]);if(!job)return;
  try{
    await db.query("UPDATE saas_report_requests SET status='running',progress=10,started_at=now(),updated_at=now() WHERE id=$1",[id]);
    const commercial=job.customer_organisation_id
      ? await commercialPack(db,job.provider_organisation_id,job.customer_organisation_id)
      : null;
    await db.query("UPDATE saas_report_requests SET progress=45,updated_at=now() WHERE id=$1",[id]);
    let school:any=null;
    if(job.customer_organisation_id){
      school=await fetchSchoolJson(config,'/api/internal/report-summary?organisationId='+encodeURIComponent(job.customer_organisation_id),45000);
    }
    await db.query("UPDATE saas_report_requests SET progress=80,updated_at=now() WHERE id=$1",[id]);
    const result={
      report:{key:job.report_key,name:job.report_name,category:job.category,format:job.format},
      generatedAt:new Date().toISOString(),
      organisation:commercial?.customer??null,
      data:reportSelection(job.report_key,commercial,school)
    };
    await db.query(`UPDATE saas_report_requests SET status='completed',progress=100,result=$1,error=NULL,
      completed_at=now(),expires_at=now()+interval '90 days',updated_at=now() WHERE id=$2`,
      [JSON.stringify(result),id]);
    await audit(db,{organisationId:job.provider_organisation_id,actorUserId:job.requested_by,
      action:'commercial.report.completed',resourceType:'saas_report_request',resourceId:id,
      metadata:{customerOrganisationId:job.customer_organisation_id,reportKey:job.report_key},source:'assurance'});
  }catch(error:any){
    await db.query("UPDATE saas_report_requests SET status='failed',progress=100,error=$1,completed_at=now(),updated_at=now() WHERE id=$2",
      [String(error?.message||error).slice(0,4000),id]);
    await audit(db,{organisationId:job.provider_organisation_id,actorUserId:job.requested_by,
      action:'commercial.report.failed',resourceType:'saas_report_request',resourceId:id,outcome:'failure',severity:'warning',
      metadata:{customerOrganisationId:job.customer_organisation_id,reportKey:job.report_key,error:String(error?.message||error)},source:'assurance'}).catch(()=>{});
  }
}

async function runBackupJob(db:Db,config:Config,id:string){
  const job=await maybeOne<any>(db,'SELECT * FROM saas_backup_jobs WHERE id=$1',[id]);if(!job)return;
  try{
    await db.query("UPDATE saas_backup_jobs SET status='running',progress=10,phase='Connecting to School tenant',started_at=now(),updated_at=now() WHERE id=$1",[id]);
    const snapshot=await fetchSchoolJson(config,'/api/internal/backup-snapshot?organisationId='+encodeURIComponent(job.customer_organisation_id),120000);
    await db.query("UPDATE saas_backup_jobs SET progress=70,phase='Validating snapshot',updated_at=now() WHERE id=$1",[id]);
    const serialized=canonical(snapshot);
    const checksum=createHash('sha256').update(serialized).digest('hex');
    const size=Buffer.byteLength(JSON.stringify(snapshot),'utf8');
    await db.query("UPDATE saas_backup_jobs SET progress=90,phase='Writing independent OS backup',updated_at=now() WHERE id=$1",[id]);
    await db.query(`UPDATE saas_backup_jobs SET status='completed',progress=100,phase='Completed',
      table_count=$1,row_count=$2,size_bytes=$3,checksum_sha256=$4,snapshot=$5,error=NULL,
      completed_at=now(),retention_until=now()+interval '30 days',updated_at=now() WHERE id=$6`,
      [Number(snapshot.tableCount||0),Number(snapshot.rowCount||0),size,checksum,JSON.stringify(snapshot),id]);
    await audit(db,{organisationId:job.provider_organisation_id,actorUserId:job.requested_by,
      action:'commercial.backup.completed',resourceType:'saas_backup_job',resourceId:id,
      metadata:{customerOrganisationId:job.customer_organisation_id,rowCount:snapshot.rowCount,tableCount:snapshot.tableCount,checksum},source:'assurance'});
  }catch(error:any){
    await db.query("UPDATE saas_backup_jobs SET status='failed',progress=100,phase='Failed',error=$1,completed_at=now(),updated_at=now() WHERE id=$2",
      [String(error?.message||error).slice(0,4000),id]);
    await audit(db,{organisationId:job.provider_organisation_id,actorUserId:job.requested_by,
      action:'commercial.backup.failed',resourceType:'saas_backup_job',resourceId:id,outcome:'failure',severity:'critical',
      metadata:{customerOrganisationId:job.customer_organisation_id,error:String(error?.message||error)},source:'assurance'}).catch(()=>{});
  }
}
async function createBackupJob(db:Db,providerId:string,customerId:string,userId:string){
  await managedCustomer(db,providerId,customerId);
  const existing=await maybeOne<any>(db,`SELECT id,status,progress FROM saas_backup_jobs
    WHERE provider_organisation_id=$1 AND customer_organisation_id=$2 AND status IN('queued','running')
    ORDER BY requested_at DESC LIMIT 1`,[providerId,customerId]);
  if(existing)return existing;
  return one<any>(db,`INSERT INTO saas_backup_jobs(provider_organisation_id,customer_organisation_id,status,progress,phase,requested_by)
    VALUES($1,$2,'queued',0,'Queued',$3) RETURNING *`,[providerId,customerId,userId]);
}

export async function assuranceRoutes(app:FastifyInstance,{db,config}:{db:Db;config:Config}){
  app.get('/v1/executive/overview',async request=>{
    const a=requirePermission(request,'commercial.read');
    const [commercial,licences,provisioning,backups,reports,auditStats,internal,renewals,organisations]=await Promise.all([
      db.query(`SELECT
        (SELECT count(*) FROM saas_customers c WHERE c.provider_organisation_id=$1 AND c.status<>'archived')::int organisations,
        (SELECT count(*) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='active')::int active_licences,
        (SELECT count(*) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='trial')::int trials,
        (SELECT count(*) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status IN('grace','suspended','expired'))::int licence_attention,
        (SELECT count(*) FROM saas_invoices i WHERE i.provider_organisation_id=$1)::int invoices,
        (SELECT COALESCE(sum(i.total-i.amount_paid),0) FROM saas_invoices i WHERE i.provider_organisation_id=$1 AND i.status IN('issued','part_paid','overdue'))::numeric outstanding,
        (SELECT COALESCE(sum(p.amount),0) FROM saas_subscription_payments p WHERE p.provider_organisation_id=$1 AND p.paid_at>=date_trunc('month',now()))::numeric collections_month,
        (SELECT COALESCE(sum(CASE s.billing_frequency WHEN 'annual' THEN s.recurring_amount/12 WHEN 'termly' THEN s.recurring_amount/4 ELSE s.recurring_amount END),0) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='active')::numeric mrr,
        (SELECT COALESCE(sum(CASE s.billing_frequency WHEN 'annual' THEN s.recurring_amount WHEN 'termly' THEN s.recurring_amount*3 ELSE s.recurring_amount*12 END),0) FROM saas_subscriptions s WHERE s.provider_organisation_id=$1 AND s.status='active')::numeric arr`,[a.organisationId]),
      db.query('SELECT status,count(*)::int count FROM saas_subscriptions WHERE provider_organisation_id=$1 GROUP BY status ORDER BY status',[a.organisationId]),
      db.query('SELECT status,count(*)::int count FROM saas_provisioning_jobs WHERE provider_organisation_id=$1 GROUP BY status ORDER BY status',[a.organisationId]),
      db.query('SELECT status,count(*)::int count FROM saas_backup_jobs WHERE provider_organisation_id=$1 GROUP BY status ORDER BY status',[a.organisationId]),
      db.query('SELECT status,count(*)::int count FROM saas_report_requests WHERE provider_organisation_id=$1 GROUP BY status ORDER BY status',[a.organisationId]),
      db.query(`SELECT count(*)::int total,
        count(*) FILTER(WHERE created_at>=now()-interval '30 days')::int last_30_days,
        count(*) FILTER(WHERE outcome='failure' AND created_at>=now()-interval '30 days')::int failures_30_days,
        count(*) FILTER(WHERE severity='critical' AND created_at>=now()-interval '30 days')::int critical_30_days,
        count(*) FILTER(WHERE event_hash IS NOT NULL)::int integrity_protected,
        count(*) FILTER(WHERE event_hash IS NULL)::int historical_unhashed
        FROM audit_logs WHERE organisation_id=$1`,[a.organisationId]),
      db.query(`SELECT
        (SELECT count(*) FROM organisation_memberships WHERE organisation_id=$1)::int people,
        (SELECT count(*) FROM operation_items WHERE organisation_id=$1)::int operations,
        (SELECT count(*) FROM documents WHERE organisation_id=$1)::int documents,
        (SELECT count(*) FROM assets WHERE organisation_id=$1)::int assets,
        (SELECT count(*) FROM workflow_instances WHERE organisation_id=$1)::int workflows,
        (SELECT count(*) FROM integrations WHERE organisation_id=$1 AND status='active')::int integrations,
        (SELECT count(*) FROM automations WHERE organisation_id=$1 AND is_active=true)::int automations`,[a.organisationId]),
      db.query(`SELECT o.name,o.slug,s.status,pl.name plan_name,s.current_period_end,s.currency,s.recurring_amount
        FROM saas_subscriptions s JOIN organisations o ON o.id=s.customer_organisation_id
        LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id
        WHERE s.provider_organisation_id=$1 AND s.current_period_end IS NOT NULL
          AND s.current_period_end<=now()+interval '60 days' AND s.status IN('active','trial','grace')
        ORDER BY s.current_period_end LIMIT 20`,[a.organisationId]),
      db.query(`SELECT o.id,o.name,o.slug,c.school_type,c.status customer_status,s.status licence_status,pl.name plan_name,
        s.current_period_end,s.currency,s.recurring_amount,
        (SELECT metric_value FROM saas_usage_snapshots u WHERE u.provider_organisation_id=$1 AND u.customer_organisation_id=o.id AND u.metric_key='students' ORDER BY u.measured_at DESC LIMIT 1) students,
        (SELECT status FROM saas_backup_jobs b WHERE b.provider_organisation_id=$1 AND b.customer_organisation_id=o.id ORDER BY b.requested_at DESC LIMIT 1) last_backup_status,
        (SELECT completed_at FROM saas_backup_jobs b WHERE b.provider_organisation_id=$1 AND b.customer_organisation_id=o.id AND b.status='completed' ORDER BY b.completed_at DESC LIMIT 1) last_backup_at
        FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id
        LEFT JOIN LATERAL (SELECT * FROM saas_subscriptions x WHERE x.provider_organisation_id=c.provider_organisation_id AND x.customer_organisation_id=c.customer_organisation_id ORDER BY x.created_at DESC LIMIT 1) s ON true
        LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id
        WHERE c.provider_organisation_id=$1 AND c.status<>'archived' ORDER BY o.name`,[a.organisationId])
    ]);
    return{
      commercial:commercial.rows[0],licences:statusCounts(licences.rows),provisioning:statusCounts(provisioning.rows),
      backups:statusCounts(backups.rows),reports:statusCounts(reports.rows),audit:auditStats.rows[0],
      internal:internal.rows[0],renewals:renewals.rows,organisations:organisations.rows
    };
  });

  app.get('/v1/assurance/organisations',async request=>{
    const a=requirePermission(request,'commercial.read');
    return (await db.query(`SELECT o.id,o.name,o.slug,c.school_type,c.primary_contact_name,c.primary_contact_email,c.primary_contact_phone,
      c.address,c.status customer_status,s.status licence_status,s.license_code,s.billing_frequency,s.recurring_amount,s.currency,
      s.current_period_end,pl.name plan_name,
      (SELECT status FROM saas_backup_jobs b WHERE b.provider_organisation_id=$1 AND b.customer_organisation_id=o.id ORDER BY requested_at DESC LIMIT 1) last_backup_status,
      (SELECT completed_at FROM saas_backup_jobs b WHERE b.provider_organisation_id=$1 AND b.customer_organisation_id=o.id AND b.status='completed' ORDER BY completed_at DESC LIMIT 1) last_backup_at,
      (SELECT count(*) FROM saas_report_requests r WHERE r.provider_organisation_id=$1 AND r.customer_organisation_id=o.id)::int report_count
      FROM saas_customers c JOIN organisations o ON o.id=c.customer_organisation_id
      LEFT JOIN LATERAL(SELECT * FROM saas_subscriptions x WHERE x.provider_organisation_id=c.provider_organisation_id AND x.customer_organisation_id=c.customer_organisation_id ORDER BY created_at DESC LIMIT 1)s ON true
      LEFT JOIN saas_pricing_plans pl ON pl.id=s.plan_id
      WHERE c.provider_organisation_id=$1 AND c.status<>'archived' ORDER BY o.name`,[a.organisationId])).rows;
  });

  app.get('/v1/assurance/reports/catalog',async request=>{requirePermission(request,'commercial.reports');return REPORT_CATALOG});
  app.get('/v1/assurance/reports',async request=>{
    const a=requirePermission(request,'commercial.reports');
    const q=z.object({customerOrganisationId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
    const params:any[]=[a.organisationId];let where='provider_organisation_id=$1';
    if(q.customerOrganisationId){params.push(q.customerOrganisationId);where+=' AND customer_organisation_id=$2'}
    params.push(q.limit);
    return (await db.query(`SELECT r.*,o.name customer_name FROM saas_report_requests r
      LEFT JOIN organisations o ON o.id=r.customer_organisation_id WHERE ${where}
      ORDER BY requested_at DESC LIMIT $${params.length}`,params)).rows;
  });
  app.post('/v1/assurance/reports',async(request,reply)=>{
    const a=requirePermission(request,'commercial.reports');
    const b=z.object({customerOrganisationId:z.string().uuid(),reportKey:z.string().min(2).max(100)}).parse(request.body);
    const def=REPORT_CATALOG.find(x=>x.key===b.reportKey);if(!def)throw notFound('Report type');
    await managedCustomer(db,a.organisationId,b.customerOrganisationId);
    const job=await one<any>(db,`INSERT INTO saas_report_requests(
      provider_organisation_id,customer_organisation_id,report_key,report_name,category,format,status,progress,requested_by
    ) VALUES($1,$2,$3,$4,$5,'json','queued',0,$6) RETURNING *`,
      [a.organisationId,b.customerOrganisationId,def.key,def.name,def.category,a.userId]);
    await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'commercial.report.requested',
      resourceType:'saas_report_request',resourceId:job.id,ipAddress:request.ip,userAgent:String(request.headers['user-agent']||''),
      metadata:{customerOrganisationId:b.customerOrganisationId,reportKey:def.key},source:'assurance'});
    setImmediate(()=>void runReportJob(db,config,job.id));
    return reply.code(202).send(job);
  });
  app.get('/v1/assurance/reports/:id',async request=>{
    const a=requirePermission(request,'commercial.reports');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const row=await maybeOne<any>(db,'SELECT r.*,o.name customer_name FROM saas_report_requests r LEFT JOIN organisations o ON o.id=r.customer_organisation_id WHERE r.id=$1 AND r.provider_organisation_id=$2',[id,a.organisationId]);
    if(!row)throw notFound('Report request');return row;
  });
  app.get('/v1/assurance/reports/:id/download',async request=>{
    const a=requirePermission(request,'commercial.reports');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const row=await maybeOne<any>(db,"SELECT report_name,result,status FROM saas_report_requests WHERE id=$1 AND provider_organisation_id=$2",[id,a.organisationId]);
    if(!row)throw notFound('Report request');if(row.status!=='completed'||!row.result)throw new AppError(409,'REPORT_NOT_READY','Report is not complete');
    return row.result;
  });

  app.get('/v1/assurance/backups',async request=>{
    const a=requirePermission(request,'commercial.backups');
    await db.query(`UPDATE saas_backup_jobs SET status='failed',progress=100,phase='Failed',error='Job timed out before completion',completed_at=now(),updated_at=now()
      WHERE provider_organisation_id=$1 AND status='running' AND started_at<now()-interval '2 hours'`,[a.organisationId]);
    return (await db.query(`SELECT b.id,b.customer_organisation_id,o.name customer_name,o.slug,b.backup_type,b.status,b.progress,b.phase,
      b.table_count,b.row_count,b.size_bytes,b.checksum_sha256,b.error,b.requested_at,b.started_at,b.completed_at,b.retention_until
      FROM saas_backup_jobs b JOIN organisations o ON o.id=b.customer_organisation_id
      WHERE b.provider_organisation_id=$1 ORDER BY b.requested_at DESC LIMIT 250`,[a.organisationId])).rows;
  });
  app.post('/v1/assurance/backups/organisations/:id',async(request,reply)=>{
    const a=requirePermission(request,'commercial.backups');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const job=await createBackupJob(db,a.organisationId,id,a.userId);
    await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'commercial.backup.requested',
      resourceType:'saas_backup_job',resourceId:job.id,ipAddress:request.ip,userAgent:String(request.headers['user-agent']||''),
      metadata:{customerOrganisationId:id},source:'assurance'});
    if(job.status==='queued')setImmediate(()=>void runBackupJob(db,config,job.id));
    return reply.code(202).send(job);
  });
  app.post('/v1/assurance/backups/run-all',async(request,reply)=>{
    const a=requirePermission(request,'commercial.backups');
    const customers=(await db.query("SELECT customer_organisation_id FROM saas_customers WHERE provider_organisation_id=$1 AND status<>'archived' ORDER BY created_at",[a.organisationId])).rows;
    const jobs:any[]=[];
    for(const c of customers)jobs.push(await createBackupJob(db,a.organisationId,c.customer_organisation_id,a.userId));
    await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'commercial.backup.bulk_requested',
      resourceType:'saas_backup_job',resourceId:null,ipAddress:request.ip,userAgent:String(request.headers['user-agent']||''),
      metadata:{organisationCount:customers.length},source:'assurance'});
    setImmediate(()=>void Promise.allSettled(jobs.filter(j=>j.status==='queued').map(j=>runBackupJob(db,config,j.id))));
    return reply.code(202).send({count:jobs.length,jobs:jobs.map(j=>({id:j.id,customerOrganisationId:j.customer_organisation_id,status:j.status,progress:j.progress}))});
  });
  app.post('/v1/assurance/backups/:id/retry',async(request,reply)=>{
    const a=requirePermission(request,'commercial.backups');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const old=await maybeOne<any>(db,'SELECT * FROM saas_backup_jobs WHERE id=$1 AND provider_organisation_id=$2',[id,a.organisationId]);
    if(!old)throw notFound('Backup job');
    const job=await one<any>(db,`INSERT INTO saas_backup_jobs(provider_organisation_id,customer_organisation_id,status,progress,phase,requested_by,metadata)
      VALUES($1,$2,'queued',0,'Queued',$3,$4) RETURNING *`,
      [a.organisationId,old.customer_organisation_id,a.userId,JSON.stringify({retryOf:id})]);
    setImmediate(()=>void runBackupJob(db,config,job.id));return reply.code(202).send(job);
  });
  app.get('/v1/assurance/backups/:id/download',async request=>{
    const a=requirePermission(request,'commercial.backups');const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const row=await maybeOne<any>(db,'SELECT snapshot,status,checksum_sha256 FROM saas_backup_jobs WHERE id=$1 AND provider_organisation_id=$2',[id,a.organisationId]);
    if(!row)throw notFound('Backup job');if(row.status!=='completed'||!row.snapshot)throw new AppError(409,'BACKUP_NOT_READY','Backup is not complete');
    return{checksumSha256:row.checksum_sha256,snapshot:row.snapshot};
  });

  app.get('/v1/assurance/audit/summary',async request=>{
    const a=requirePermission(request,'commercial.audit');
    const [summary,actions,recent]=await Promise.all([
      db.query(`SELECT count(*)::int total,
        count(*) FILTER(WHERE created_at>=now()-interval '30 days')::int last_30_days,
        count(*) FILTER(WHERE outcome='failure' AND created_at>=now()-interval '30 days')::int failures_30_days,
        count(*) FILTER(WHERE severity='critical' AND created_at>=now()-interval '30 days')::int critical_30_days,
        count(*) FILTER(WHERE event_hash IS NOT NULL)::int hashed,
        count(*) FILTER(WHERE event_hash IS NULL)::int historical_unhashed
        FROM audit_logs WHERE organisation_id=$1`,[a.organisationId]),
      db.query(`SELECT action,count(*)::int count FROM audit_logs WHERE organisation_id=$1 AND created_at>=now()-interval '30 days'
        GROUP BY action ORDER BY count DESC,action LIMIT 20`,[a.organisationId]),
      db.query(`SELECT l.id,l.action,l.resource_type,l.resource_id,l.outcome,l.severity,l.source,l.event_hash,l.created_at,
        u.first_name,u.last_name,u.email FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id
        WHERE l.organisation_id=$1 ORDER BY l.created_at DESC LIMIT 50`,[a.organisationId])
    ]);
    return{summary:summary.rows[0],topActions:actions.rows,recent:recent.rows};
  });
  app.get('/v1/assurance/audit/events',async request=>{
    const a=requirePermission(request,'commercial.audit');
    const q=z.object({limit:z.coerce.number().int().min(1).max(500).default(200),outcome:z.enum(['success','failure']).optional(),action:z.string().max(160).optional()}).parse(request.query);
    const params:any[]=[a.organisationId];let where='organisation_id=$1';
    if(q.outcome){params.push(q.outcome);where+=' AND outcome=$'+params.length}
    if(q.action){params.push('%'+q.action+'%');where+=' AND action ILIKE $'+params.length}
    params.push(q.limit);
    return (await db.query(`SELECT id,actor_user_id,session_id,action,resource_type,resource_id,outcome,severity,source,
      ip_address,user_agent,metadata,previous_event_hash,event_hash,created_at FROM audit_logs
      WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,params)).rows;
  });
  app.get('/v1/assurance/audit/verify',async request=>{
    const a=requirePermission(request,'commercial.audit');
    const rows=(await db.query(`SELECT * FROM audit_logs WHERE organisation_id=$1 AND event_hash IS NOT NULL ORDER BY created_at,id`,[a.organisationId])).rows;
    let previous:string|null=null,valid=0,broken:any=null;
    for(const row of rows){
      const createdAt=row.created_at instanceof Date?row.created_at.toISOString():new Date(row.created_at).toISOString();
      const hashPayload=[
        row.previous_event_hash??'',row.organisation_id??'',row.actor_user_id??'',row.session_id??'',row.action,row.resource_type,
        row.resource_id??'',row.outcome,row.severity,row.source,row.ip_address??'',row.user_agent??'',
        canonical(row.before_state),canonical(row.after_state),canonical(row.metadata),createdAt
      ].join('|');
      const expected=createHash('sha256').update(hashPayload).digest('hex');
      if(row.previous_event_hash!==previous||row.event_hash!==expected){broken={id:row.id,createdAt:row.created_at};break}
      previous=row.event_hash;valid++;
    }
    const historical=(await db.query('SELECT count(*)::int count FROM audit_logs WHERE organisation_id=$1 AND event_hash IS NULL',[a.organisationId])).rows[0]?.count??0;
    return{ok:broken===null,hashedEvents:rows.length,verifiedEvents:valid,historicalUnhashed:Number(historical),brokenAt:broken};
  });
}
