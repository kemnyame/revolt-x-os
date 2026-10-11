import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Db} from '../db/index.js';
import {maybeOne,one,transaction} from '../db/index.js';
import {requirePermission} from '../core/http.js';
import {audit} from '../core/audit.js';
import {AppError,conflict,notFound} from '../core/errors.js';

export const schoolSetupSchema=z.object({
  name:z.string().trim().min(2,'Enter the school name.').max(200),
  slug:z.string().trim().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  schoolType:z.string().trim().max(80).optional(),
  adminFirstName:z.string().trim().min(1).max(100),adminLastName:z.string().trim().min(1).max(100),
  adminEmail:z.string().trim().toLowerCase().email(),contactPhone:z.string().trim().max(50).optional(),
  address:z.string().trim().max(1000).optional(),planId:z.string().uuid(),
  billingFrequency:z.enum(['monthly','termly','annual']).default('monthly')
});
const money=z.coerce.number().min(0.01,'Enter a positive payment amount.').max(1_000_000_000)
  .refine(value=>Math.abs(value*100-Math.round(value*100))<0.00001,'Use no more than two decimal places.');
export const commercialPaymentSchema=z.object({amount:money,
  paymentMethod:z.enum(['bank_transfer','mobile_money','card','cash','manual']).default('bank_transfer'),
  providerReference:z.string().trim().max(160).optional(),idempotencyKey:z.string().uuid().optional()});
export const paidInvoiceNumber=z.string().trim().toUpperCase().min(1,'Enter the paid invoice number before creating a school.').max(60);
export function newInvoiceNumber(){return 'RX-'+randomBytes(12).toString('hex').toUpperCase()}
const cents=(value:unknown)=>Math.round(Number(value)*100);

/** The invoice row remains locked until school creation commits. This prevents
 * concurrent requests from using the same payment for two different schools. */
export async function lockPaidSchoolOrder(db:Db,providerId:string,invoiceNumber:string){
  const order=await maybeOne<any>(db,'SELECT * FROM saas_school_orders WHERE provider_organisation_id=$1 AND invoice_no=$2 FOR UPDATE',[providerId,invoiceNumber.trim().toUpperCase()]);
  if(!order)throw notFound('School setup invoice');
  if(order.claimed_school_id)throw conflict('This invoice has already been used to create a school. Open that school to manage it or retry provisioning.');
  const ledger=await one<any>(db,'SELECT COALESCE(sum(amount),0) paid FROM saas_school_order_payments WHERE order_id=$1 AND provider_organisation_id=$2',[order.id,providerId]);
  if(order.status!=='paid'||cents(order.total)<=0||cents(order.amount_paid)!==cents(order.total)||cents(ledger.paid)!==cents(order.total))
    throw new AppError(409,'INVOICE_NOT_PAID','The invoice must be fully paid before the school can be created. Record the outstanding payment first.');
  return {...order,schoolDetails:schoolSetupSchema.parse(order.school_details)};
}

/** Carry the original invoice number, payments and references into the school's
 * billing history. All writes share the organisation-creation transaction. */
export async function claimSchoolOrder(db:Db,order:any,schoolId:string,subscriptionId:string){
  await db.query(`INSERT INTO saas_invoices(id,provider_organisation_id,customer_organisation_id,subscription_id,invoice_no,status,currency,subtotal,total,amount_paid,issued_at,due_at,paid_at,created_by)
    VALUES($1,$2,$3,$4,$5,'paid',$6,$7,$7,$7,$8,$9,$10,$11)`,[order.id,order.provider_organisation_id,schoolId,subscriptionId,order.invoice_no,order.currency,order.total,order.created_at,order.due_at,order.paid_at,order.created_by]);
  await db.query('INSERT INTO saas_invoice_lines(invoice_id,description,quantity,unit_price,amount) VALUES($1,$2,1,$3,$3)',[order.id,'School setup: '+order.schoolDetails.name,order.total]);
  await db.query(`INSERT INTO saas_subscription_payments(id,provider_organisation_id,customer_organisation_id,invoice_id,subscription_id,amount,currency,payment_method,provider_reference,idempotency_key,recorded_by,paid_at,created_at)
    SELECT id,provider_organisation_id,$2,order_id,$3,amount,currency,payment_method,provider_reference,idempotency_key,recorded_by,paid_at,created_at
    FROM saas_school_order_payments WHERE order_id=$1`,[order.id,schoolId,subscriptionId]);
  await db.query('UPDATE saas_school_orders SET claimed_school_id=$1,claimed_at=now(),updated_at=now() WHERE id=$2',[schoolId,order.id]);
}

export async function recordCommercialPayment(db:Db,providerId:string,actorId:string,id:string,input:z.infer<typeof commercialPaymentSchema>,setup=false){
  return transaction(db,async q=>{
    const invoice=await maybeOne<any>(q,setup?'SELECT * FROM saas_school_orders WHERE id=$1 AND provider_organisation_id=$2 FOR UPDATE':'SELECT * FROM saas_invoices WHERE id=$1 AND provider_organisation_id=$2 FOR UPDATE',[id,providerId]);
    if(!invoice)throw notFound('Invoice');
    const table=setup?'saas_school_order_payments':'saas_subscription_payments',invoiceColumn=setup?'order_id':'invoice_id';
    if(input.idempotencyKey||input.providerReference){
      const previous=await maybeOne<any>(q,`SELECT * FROM ${table} WHERE provider_organisation_id=$1 AND ${invoiceColumn}=$2
        AND (($3::uuid IS NOT NULL AND idempotency_key=$3) OR ($4::text IS NOT NULL AND provider_reference=$4)) LIMIT 1`,[providerId,id,input.idempotencyKey??null,input.providerReference||null]);
      if(previous){
        if(cents(previous.amount)!==cents(input.amount)||previous.payment_method!==input.paymentMethod)
          throw conflict('This payment reference was already recorded with different details.');
        return{invoice,payment:previous,duplicate:true};
      }
    }
    if(!['issued','part_paid','overdue'].includes(invoice.status)||invoice.claimed_school_id)
      throw conflict('Only an unpaid, issued invoice can receive a new payment.');
    const newPaid=cents(invoice.amount_paid)+cents(input.amount);
    if(newPaid>cents(invoice.total))throw conflict('The payment exceeds the outstanding invoice balance.');
    const values=[providerId,id,input.amount,invoice.currency,input.paymentMethod,input.providerReference||null,input.idempotencyKey??null,actorId];
    const payment=setup
      ?await one<any>(q,`INSERT INTO saas_school_order_payments(provider_organisation_id,order_id,amount,currency,payment_method,provider_reference,idempotency_key,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,values)
      :await one<any>(q,`INSERT INTO saas_subscription_payments(provider_organisation_id,invoice_id,amount,currency,payment_method,provider_reference,idempotency_key,recorded_by,customer_organisation_id,subscription_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[...values,invoice.customer_organisation_id,invoice.subscription_id]);
    const paid=newPaid===cents(invoice.total);
    const updated=await one<any>(q,`UPDATE ${setup?'saas_school_orders':'saas_invoices'} SET amount_paid=$1,status=$2,paid_at=CASE WHEN $3 THEN now() ELSE paid_at END,updated_at=now() WHERE id=$4 RETURNING *`,[newPaid/100,paid?'paid':'part_paid',paid,id]);
    if(paid&&!setup&&invoice.subscription_id){
      const sub=await one<any>(q,'SELECT * FROM saas_subscriptions WHERE id=$1 FOR UPDATE',[invoice.subscription_id]);
      const end=new Date();if(sub.billing_frequency==='annual')end.setUTCFullYear(end.getUTCFullYear()+1);else end.setUTCMonth(end.getUTCMonth()+(sub.billing_frequency==='termly'?4:1));
      await q.query("UPDATE saas_subscriptions SET status='active',grace_ends_at=NULL,current_period_start=now(),current_period_end=$1,updated_at=now() WHERE id=$2",[end.toISOString(),sub.id]);
    }
    return{invoice:updated,payment,duplicate:false};
  });
}

export function registerSchoolOrderRoutes(app:FastifyInstance,db:Db){
  app.get('/v1/commercial-control/school-orders',async request=>{
    const a=requirePermission(request,'commercial.read');
    return(await db.query(`SELECT *,school_details->>'name' customer_name FROM saas_school_orders WHERE provider_organisation_id=$1 ORDER BY created_at DESC`,[a.organisationId])).rows;
  });
  app.get('/v1/commercial-control/school-orders/:invoiceNumber',async request=>{
    const a=requirePermission(request,'commercial.read'),p=z.object({invoiceNumber:paidInvoiceNumber}).parse(request.params);
    const invoice=await maybeOne<any>(db,'SELECT * FROM saas_school_orders WHERE provider_organisation_id=$1 AND invoice_no=$2',[a.organisationId,p.invoiceNumber]);
    if(!invoice)throw notFound('School setup invoice');
    const payments=(await db.query('SELECT * FROM saas_school_order_payments WHERE order_id=$1 AND provider_organisation_id=$2 ORDER BY paid_at DESC',[invoice.id,a.organisationId])).rows;
    return{invoice,payments,canCreate:invoice.status==='paid'&&!invoice.claimed_school_id};
  });
  app.post('/v1/commercial-control/school-orders',async(request,reply)=>{
    const a=requirePermission(request,'commercial.billing');
    const body=z.object({school:schoolSetupSchema,amount:money.optional(),dueDays:z.coerce.number().int().min(1).max(180).default(14)}).parse(request.body);
    const plan=await maybeOne<any>(db,"SELECT pl.* FROM saas_pricing_plans pl JOIN saas_products p ON p.id=pl.product_id WHERE pl.id=$1 AND pl.is_active=true AND p.product_key='school'",[body.school.planId]);
    if(!plan)throw notFound('School pricing plan');
    const administrator=await maybeOne<any>(db,'SELECT status FROM users WHERE email=$1',[body.school.adminEmail]);
    if(administrator&&administrator.status!=='active')throw conflict('The administrator email belongs to an inactive account. Choose an active administrator before raising the invoice.');
    const total=body.amount??Number(plan[body.school.billingFrequency==='annual'?'annual_price':body.school.billingFrequency==='termly'?'termly_price':'monthly_price']);
    const amount=money.parse(total);
    // Reject an existing school slug before issuing an invoice that cannot be used.
    if(body.school.slug&&await maybeOne(db,'SELECT 1 FROM organisations WHERE slug=$1',[body.school.slug]))throw conflict('This school code is already in use. Choose another code.');
    const invoice=await one<any>(db,`INSERT INTO saas_school_orders(provider_organisation_id,invoice_no,school_details,currency,total,due_at,created_by)
      VALUES($1,$2,$3,$4,$5,now()+make_interval(days=>$6),$7) RETURNING *`,[a.organisationId,newInvoiceNumber(),JSON.stringify(body.school),plan.currency,amount,body.dueDays,a.userId]);
    await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'commercial.school_setup_invoice.issued',resourceType:'saas_school_order',resourceId:invoice.id,afterState:invoice});
    return reply.code(201).send(invoice);
  });
  app.post('/v1/commercial-control/school-orders/:id/payments',async(request,reply)=>{
    const a=requirePermission(request,'commercial.billing'),p=z.object({id:z.string().uuid()}).parse(request.params),body=commercialPaymentSchema.parse(request.body);
    const result=await recordCommercialPayment(db,a.organisationId,a.userId,p.id,body,true);
    if(!result.duplicate)await audit(db,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'commercial.school_setup_payment.recorded',resourceType:'saas_school_order',resourceId:p.id,afterState:result});
    return reply.code(result.duplicate?200:201).send(result);
  });
}
