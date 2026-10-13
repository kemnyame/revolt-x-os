import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';
import { maybeOne } from './db.js';
import { authorize } from './auth.js';

export async function reportDeliveryPolicy(db:SchoolDb,organisationId:string){
  const row=await maybeOne<any>(db,`SELECT block_report_delivery_when_fees_owed
    FROM school_security_settings WHERE organisation_id=$1`,[organisationId]);
  return {blockReportDeliveryWhenFeesOwed:Boolean(row?.block_report_delivery_when_fees_owed)};
}

export async function studentsWithOutstandingFees(db:SchoolDb,organisationId:string,studentIds:string[]){
  if(!studentIds.length)return new Set<string>();
  const rows=(await db.query<{student_id:string;outstanding:string}>(`SELECT sf.student_id,
      SUM(GREATEST(0,(sf.amount_due-sf.discount)-COALESCE(p.paid,0)))::text outstanding
    FROM student_fees sf
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pay.amount),0) paid
      FROM payments pay
      WHERE pay.student_fee_id=sf.id AND pay.voided_at IS NULL
    ) p ON true
    WHERE sf.organisation_id=$1 AND sf.student_id=ANY($2::uuid[])
    GROUP BY sf.student_id
    HAVING SUM(GREATEST(0,(sf.amount_due-sf.discount)-COALESCE(p.paid,0)))>0.005`,[organisationId,studentIds])).rows;
  return new Set(rows.map(row=>row.student_id));
}

export async function outstandingFeeBalance(db:SchoolDb,organisationId:string,studentId:string){
  const row=await maybeOne<{outstanding:string}>(db,`SELECT COALESCE(SUM(GREATEST(0,(sf.amount_due-sf.discount)-COALESCE(p.paid,0))),0)::text outstanding
    FROM student_fees sf
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pay.amount),0) paid
      FROM payments pay
      WHERE pay.student_fee_id=sf.id AND pay.voided_at IS NULL
    ) p ON true
    WHERE sf.organisation_id=$1 AND sf.student_id=$2`,[organisationId,studentId]);
  return Number(row?.outstanding||0);
}

export function registerReportFeePolicyRoutes(app:FastifyInstance,{db,config}:{db:SchoolDb;config:SchoolConfig}){
  app.get('/api/security/report-delivery-policy',async request=>{
    const access=await authorize(request,db,config);
    if(access.role!=='school_admin')throw Object.assign(new Error('Only the School Administrator can manage report delivery rules.'),{statusCode:403});
    return reportDeliveryPolicy(db,access.core.organisation_id);
  });

  app.put('/api/security/report-delivery-policy',async request=>{
    const access=await authorize(request,db,config);
    if(access.role!=='school_admin')throw Object.assign(new Error('Only the School Administrator can manage report delivery rules.'),{statusCode:403});
    const body=z.object({blockReportDeliveryWhenFeesOwed:z.boolean()}).parse(request.body);
    await db.query(`INSERT INTO school_security_settings(
        organisation_id,idle_timeout_minutes,absolute_timeout_minutes,updated_by_os_user_id,block_report_delivery_when_fees_owed
      ) VALUES($1,30,480,$2,$3)
      ON CONFLICT(organisation_id) DO UPDATE SET
        block_report_delivery_when_fees_owed=EXCLUDED.block_report_delivery_when_fees_owed,
        updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now()`,[
      access.core.organisation_id,access.core.id,body.blockReportDeliveryWhenFeesOwed
    ]);
    return reportDeliveryPolicy(db,access.core.organisation_id);
  });
}
