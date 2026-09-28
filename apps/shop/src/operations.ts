import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import { maybeOne, tx } from './db.js';
import type { ShopConfig } from './config.js';
import { authorize, hasShopCapability } from './auth.js';
import { assertSalonBookingAvailability } from './salon.js';

const uuid=z.string().uuid();
const positive=z.coerce.number().finite().positive();
const money=z.coerce.number().finite().min(0);

function code(prefix:string){
  return prefix+'-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+randomBytes(3).toString('hex').toUpperCase();
}
function sha(v:string){return createHash('sha256').update(v).digest('hex');}
function cookieValue(header:string|undefined,name:string){
  if(!header)return'';
  for(const part of header.split(';')){
    const p=part.trim(),i=p.indexOf('=');
    if(i>0&&p.slice(0,i)===name)return decodeURIComponent(p.slice(i+1));
  }
  return'';
}
function customerCookie(value:string,maxAge:number,secure:boolean){
  return 'rx_customer_session='+encodeURIComponent(value)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(secure?'; Secure':'');
}
function randomPasswordHash(){
  const salt=randomBytes(16).toString('hex');
  return 'scrypt$'+salt+'$'+scryptSync(randomBytes(32).toString('hex'),salt,64).toString('hex');
}
async function audit(db:Db,orgId:string,userId:string|null,action:string,type:string,id:string|null,shopId:string|null,branchId:string|null,metadata:any={}){
  await db.query(
    `INSERT INTO shop_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,branch_id,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [orgId,userId,action,type,id,shopId,branchId,JSON.stringify(metadata)]
  );
}
async function customerContext(db:Db,request:FastifyRequest){
  const raw=cookieValue(request.headers.cookie,'rx_customer_session');
  if(!raw)throw Object.assign(new Error('Customer sign-in required'),{statusCode:401,code:'CUSTOMER_AUTH_REQUIRED'});
  const row=await maybeOne<any>(db,`
    SELECT s.id session_id,a.id account_id,a.customer_id,a.shop_id,
           c.organisation_id,c.branch_id,c.name,c.phone,c.email,c.status,
           sh.public_slug,sh.currency,sh.name shop_name
    FROM shop_customer_sessions s
    JOIN shop_customer_portal_accounts a ON a.id=s.account_id AND a.status='active'
    JOIN shop_customers c ON c.id=a.customer_id
    JOIN shops sh ON sh.id=a.shop_id AND sh.status='active'
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
    LIMIT 1`,[sha(raw)]);
  if(!row)throw Object.assign(new Error('Customer session has expired. Please sign in again.'),{statusCode:401,code:'CUSTOMER_SESSION_EXPIRED'});
  await db.query('UPDATE shop_customer_sessions SET last_used_at=now() WHERE id=$1',[row.session_id]);
  return row;
}
async function businessDate(db:Db,shopId:string){
  const row=await maybeOne<any>(db,`
    SELECT (now() AT TIME ZONE coalesce(timezone,'Africa/Accra'))::date business_date
    FROM salon_settings WHERE shop_id=$1`,[shopId]);
  return row?.business_date||new Date().toISOString().slice(0,10);
}
async function activeCashierSession(db:Db,orgId:string,userId:string){
  return maybeOne<any>(db,`
    SELECT s.*,d.business_date,d.status business_day_status,sh.name shop_name,b.name branch_name
    FROM shop_cashier_sessions s
    JOIN shop_business_days d ON d.id=s.business_day_id
    JOIN shops sh ON sh.id=s.shop_id
    JOIN shop_branches b ON b.id=s.branch_id
    WHERE s.organisation_id=$1 AND s.cashier_user_id=$2 AND s.status='open'
    ORDER BY s.started_at DESC LIMIT 1`,[orgId,userId]);
}
async function sessionExpectedCash(db:Db,session:any,endAt=new Date()){
  const pay=await maybeOne<any>(db,`
    SELECT coalesce(sum(amount),0) total
    FROM shop_payments
    WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3
      AND method='cash' AND status='successful'
      AND created_at >= $4 AND created_at <= $5`,
    [session.organisation_id,session.shop_id,session.branch_id,session.started_at,endAt]
  );
  const exp=await maybeOne<any>(db,`
    SELECT coalesce(sum(amount),0) total
    FROM shop_expenses
    WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3
      AND payment_method='cash'
      AND created_at >= $4 AND created_at <= $5`,
    [session.organisation_id,session.shop_id,session.branch_id,session.started_at,endAt]
  );
  return Number(session.opening_cash||0)+Number(pay?.total||0)-Number(exp?.total||0);
}
async function dayExpectedCash(db:Db,day:any,endAt=new Date()){
  const pay=await maybeOne<any>(db,`
    SELECT coalesce(sum(amount),0) total
    FROM shop_payments
    WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3
      AND method='cash' AND status='successful'
      AND created_at >= $4 AND created_at <= $5`,
    [day.organisation_id,day.shop_id,day.branch_id,day.opened_at,endAt]
  );
  const exp=await maybeOne<any>(db,`
    SELECT coalesce(sum(amount),0) total
    FROM shop_expenses
    WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3
      AND payment_method='cash'
      AND created_at >= $4 AND created_at <= $5`,
    [day.organisation_id,day.shop_id,day.branch_id,day.opened_at,endAt]
  );
  return Number(day.opening_cash||0)+Number(pay?.total||0)-Number(exp?.total||0);
}
async function createCustomerSession(db:Db,config:ShopConfig,reply:any,accountId:string){
  const token=randomBytes(36).toString('base64url');
  await db.query(
    `INSERT INTO shop_customer_sessions(account_id,token_hash,expires_at)
     VALUES($1,$2,now()+($3||' days')::interval)`,
    [accountId,sha(token),String(config.CUSTOMER_PORTAL_SESSION_DAYS)]
  );
  reply.header('Set-Cookie',customerCookie(token,config.CUSTOMER_PORTAL_SESSION_DAYS*86400,config.NODE_ENV==='production'));
}
function csvCell(v:any){
  const s=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);
  return '"'+s.replace(/"/g,'""')+'"';
}
function csv(rows:any[]){
  if(!rows.length)return '';
  const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return columns.map(csvCell).join(',')+'\n'+rows.map(r=>columns.map(k=>csvCell(r[k])).join(',')).join('\n');
}
async function reportRows(db:Db,orgId:string,type:string,shopId:string,branchId:string|null,from:string,to:string){
  const p=[orgId,shopId,branchId,from,to];
  switch(type){
    case 'executive_summary': return (await db.query(`
      SELECT
       (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND booked_for::date BETWEEN $4::date AND $5::date) appointments,
       (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND status='completed' AND booked_for::date BETWEEN $4::date AND $5::date) completed_services,
       (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND status='no_show' AND booked_for::date BETWEEN $4::date AND $5::date) no_shows,
       (SELECT coalesce(sum(total),0) FROM shop_orders WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND created_at::date BETWEEN $4::date AND $5::date) invoiced_sales,
       (SELECT coalesce(sum(amount),0) FROM shop_payments WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND status='successful' AND created_at::date BETWEEN $4::date AND $5::date) payments_received,
       (SELECT coalesce(sum(amount),0) FROM shop_expenses WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND expense_date BETWEEN $4::date AND $5::date) expenses,
       (SELECT count(*)::int FROM shop_customers WHERE organisation_id=$1 AND shop_id=$2 AND status='active') active_customers,
       (SELECT count(*)::int FROM shop_customers WHERE organisation_id=$1 AND shop_id=$2 AND status='inactive') inactive_customers,
       (SELECT count(*)::int FROM shop_inventory_alerts WHERE organisation_id=$1 AND shop_id=$2 AND status='open') inventory_alerts,
       (SELECT count(*)::int FROM shop_tickets WHERE organisation_id=$1 AND shop_id=$2 AND status NOT IN('resolved','closed','cancelled')) open_tickets`,p)).rows;
    case 'sales': return (await db.query(`
      SELECT o.created_at,o.order_no,c.name customer,o.subtotal,o.discount,o.tax,o.total,o.amount_paid,o.balance,o.status
      FROM shop_orders o LEFT JOIN shop_customers c ON c.id=o.customer_id
      WHERE o.organisation_id=$1 AND o.shop_id=$2 AND ($3::uuid IS NULL OR o.branch_id=$3)
        AND o.created_at::date BETWEEN $4::date AND $5::date ORDER BY o.created_at DESC LIMIT 3000`,p)).rows;
    case 'payments': return (await db.query(`
      SELECT p.created_at,p.reference,p.provider,p.method,p.amount,p.fee,p.status,p.reconciliation_status,o.order_no,c.name customer
      FROM shop_payments p LEFT JOIN shop_orders o ON o.id=p.order_id LEFT JOIN shop_customers c ON c.id=p.customer_id
      WHERE p.organisation_id=$1 AND p.shop_id=$2 AND ($3::uuid IS NULL OR p.branch_id=$3)
        AND p.created_at::date BETWEEN $4::date AND $5::date ORDER BY p.created_at DESC LIMIT 3000`,p)).rows;
    case 'appointments': return (await db.query(`
      SELECT b.booked_for,b.customer_name,b.phone,s.name service,st.full_name barber,ch.name chair,b.appointment_type,b.source,b.status,b.check_in_at,b.service_started_at,b.service_completed_at
      FROM shop_bookings b LEFT JOIN shop_services s ON s.id=b.service_id LEFT JOIN salon_staff st ON st.id=b.salon_staff_id LEFT JOIN salon_chairs ch ON ch.id=b.salon_chair_id
      WHERE b.organisation_id=$1 AND b.shop_id=$2 AND ($3::uuid IS NULL OR b.branch_id=$3)
        AND b.booked_for::date BETWEEN $4::date AND $5::date ORDER BY b.booked_for DESC LIMIT 3000`,p)).rows;
    case 'customers': return (await db.query(`
      SELECT customer_no,name,phone,email,customer_type,status,loyalty_points,credit_limit,last_visit_at,created_at
      FROM shop_customers WHERE organisation_id=$1 AND shop_id=$2 ORDER BY created_at DESC LIMIT 5000`,[orgId,shopId])).rows;
    case 'staff_performance': return (await db.query(`
      SELECT st.staff_no,st.full_name,st.role,st.specialty,st.commission_percent,
             count(b.id) FILTER(WHERE b.status='completed')::int completed_services,
             count(b.id) FILTER(WHERE b.status='no_show')::int no_shows,
             coalesce(sum(s.price) FILTER(WHERE b.status='completed'),0) service_value,
             coalesce(sum(ce.commission_amount),0) commission_earned
      FROM salon_staff st
      LEFT JOIN shop_bookings b ON b.salon_staff_id=st.id AND b.booked_for::date BETWEEN $4::date AND $5::date
      LEFT JOIN shop_services s ON s.id=b.service_id
      LEFT JOIN salon_commission_entries ce ON ce.staff_id=st.id AND ce.earned_at::date BETWEEN $4::date AND $5::date
      WHERE st.organisation_id=$1 AND st.shop_id=$2 AND ($3::uuid IS NULL OR st.branch_id=$3 OR st.branch_id IS NULL)
      GROUP BY st.id ORDER BY completed_services DESC,st.full_name`,p)).rows;
    case 'inventory': return (await db.query(`
      SELECT sku,name,category,cost_price,selling_price,stock_quantity,reorder_level,
             CASE WHEN stock_quantity<=0 THEN 'out_of_stock' WHEN stock_quantity<=reorder_level THEN 'reorder' ELSE 'healthy' END status
      FROM shop_products WHERE organisation_id=$1 AND shop_id=$2 AND active=true ORDER BY name`,[orgId,shopId])).rows;
    case 'stock_movements': return (await db.query(`
      SELECT sm.created_at,p.sku,p.name product,sm.movement_type,sm.quantity,sm.source_type,sm.source_id,sm.note
      FROM shop_stock_movements sm JOIN shop_products p ON p.id=sm.product_id
      WHERE sm.organisation_id=$1 AND sm.shop_id=$2 AND ($3::uuid IS NULL OR sm.branch_id=$3)
        AND sm.created_at::date BETWEEN $4::date AND $5::date ORDER BY sm.created_at DESC LIMIT 3000`,p)).rows;
    case 'expenses': return (await db.query(`
      SELECT expense_date,category,description,amount,payment_method,reference,created_at
      FROM shop_expenses WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3)
        AND expense_date BETWEEN $4::date AND $5::date ORDER BY expense_date DESC,created_at DESC LIMIT 3000`,p)).rows;
    case 'cashier_sessions': return (await db.query(`
      SELECT d.business_date,s.session_no,u.first_name||' '||u.last_name cashier,b.name branch,s.started_at,s.ended_at,s.status,s.end_reason,
             s.opening_cash,s.expected_cash,s.actual_cash,s.variance,s.handover_note
      FROM shop_cashier_sessions s JOIN shop_business_days d ON d.id=s.business_day_id
      LEFT JOIN revolt_x_os.users u ON u.id=s.cashier_user_id JOIN shop_branches b ON b.id=s.branch_id
      WHERE s.organisation_id=$1 AND s.shop_id=$2 AND ($3::uuid IS NULL OR s.branch_id=$3)
        AND d.business_date BETWEEN $4::date AND $5::date ORDER BY s.started_at DESC LIMIT 3000`,p)).rows;
    case 'leave': return (await db.query(`
      SELECT l.leave_type,l.start_date,l.end_date,l.reason,l.status,l.relief_notes,
             coalesce(st.full_name,u.first_name||' '||u.last_name) applicant,rel.full_name relief_staff,
             l.requested_at,l.reviewed_at,l.review_note
      FROM shop_staff_leave_requests l
      LEFT JOIN salon_staff st ON st.id=l.salon_staff_id LEFT JOIN salon_staff rel ON rel.id=l.relief_staff_id
      LEFT JOIN revolt_x_os.users u ON u.id=l.applicant_user_id
      WHERE l.organisation_id=$1 AND l.shop_id=$2 AND ($3::uuid IS NULL OR l.branch_id=$3)
        AND l.start_date <= $5::date AND l.end_date >= $4::date ORDER BY l.start_date DESC LIMIT 3000`,p)).rows;
    case 'commissions': return (await db.query(`
      SELECT ce.earned_at,st.full_name barber,ce.gross_amount,ce.commission_percent,ce.commission_amount,ce.status,ce.paid_at,ce.note
      FROM salon_commission_entries ce JOIN salon_staff st ON st.id=ce.staff_id
      WHERE ce.organisation_id=$1 AND ce.shop_id=$2 AND ($3::uuid IS NULL OR ce.branch_id=$3)
        AND ce.earned_at::date BETWEEN $4::date AND $5::date ORDER BY ce.earned_at DESC LIMIT 3000`,p)).rows;
    case 'eod': return (await db.query(`
      SELECT business_date,opening_cash,expected_cash,actual_cash,variance,momo_total,card_total,bank_total,total_sales,total_expenses,close_mode,review_status,closed_at
      FROM salon_eod_closures WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3)
        AND business_date BETWEEN $4::date AND $5::date ORDER BY business_date DESC LIMIT 1000`,p)).rows;
    case 'tickets': return (await db.query(`
      SELECT t.ticket_no,t.created_at,c.name customer,t.source,t.category,t.subject,t.priority,t.status,t.resolved_at
      FROM shop_tickets t LEFT JOIN shop_customers c ON c.id=t.customer_id
      WHERE t.organisation_id=$1 AND t.shop_id=$2 AND ($3::uuid IS NULL OR t.branch_id=$3)
        AND t.created_at::date BETWEEN $4::date AND $5::date ORDER BY t.created_at DESC LIMIT 3000`,p)).rows;
    case 'procurement': return (await db.query(`
      SELECT po.po_no,po.order_date,v.name vendor,po.expected_date,po.status,po.subtotal,po.tax,po.total,po.approved_at
      FROM shop_purchase_orders po LEFT JOIN shop_finance_vendors v ON v.id=po.vendor_id
      WHERE po.organisation_id=$1 AND po.shop_id=$2 AND ($3::uuid IS NULL OR po.branch_id=$3)
        AND po.order_date BETWEEN $4::date AND $5::date ORDER BY po.order_date DESC LIMIT 2000`,p)).rows;
    case 'assets': return (await db.query(`
      SELECT asset_no,name,category,brand,model,serial_number,purchase_date,purchase_cost,current_value,condition,status,next_service_date,warranty_expiry
      FROM shop_assets WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) ORDER BY category,name`,[orgId,shopId,branchId])).rows;
    case 'audit': return (await db.query(`
      SELECT created_at,action,resource_type,resource_id,actor_os_user_id,metadata
      FROM shop_audit_logs WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2)
        AND created_at::date BETWEEN $4::date AND $5::date ORDER BY created_at DESC LIMIT 3000`,[orgId,shopId,branchId,from,to])).rows;
    case 'reconciliation': return (await db.query(`
      SELECT created_at,reference,provider,method,amount,fee,settlement_amount,status,reconciliation_status,reconciled_at
      FROM shop_payments WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3)
        AND created_at::date BETWEEN $4::date AND $5::date ORDER BY created_at DESC LIMIT 3000`,p)).rows;
    case 'service_performance': return (await db.query(`
      SELECT s.name service,s.category,s.price,
             count(b.id)::int bookings,
             count(b.id) FILTER(WHERE b.status='completed')::int completed,
             count(b.id) FILTER(WHERE b.status='cancelled')::int cancelled,
             count(b.id) FILTER(WHERE b.status='no_show')::int no_shows,
             coalesce(sum(s.price) FILTER(WHERE b.status='completed'),0) completed_service_value
      FROM shop_services s
      LEFT JOIN shop_bookings b ON b.service_id=s.id
        AND b.booked_for::date BETWEEN $4::date AND $5::date
        AND ($3::uuid IS NULL OR b.branch_id=$3)
      WHERE s.organisation_id=$1 AND s.shop_id=$2
      GROUP BY s.id ORDER BY completed DESC,s.name`,p)).rows;
    case 'booking_sources': return (await db.query(`
      SELECT source,appointment_type,status,count(*)::int bookings
      FROM shop_bookings
      WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3)
        AND booked_for::date BETWEEN $4::date AND $5::date
      GROUP BY source,appointment_type,status ORDER BY bookings DESC`,p)).rows;
    case 'customer_retention': return (await db.query(`
      SELECT status,count(*)::int customers,
             coalesce(avg(extract(day from now()-coalesce(last_visit_at,created_at))),0)::numeric(12,1) average_days_since_activity,
             count(*) FILTER(WHERE portal_registered_at IS NOT NULL)::int portal_customers,
             coalesce(sum(loyalty_points),0) loyalty_points
      FROM shop_customers WHERE organisation_id=$1 AND shop_id=$2
      GROUP BY status ORDER BY status`,[orgId,shopId])).rows;
    case 'branch_performance': return (await db.query(`
      SELECT br.name branch,
        count(DISTINCT b.id) FILTER(WHERE b.booked_for::date BETWEEN $4::date AND $5::date)::int appointments,
        count(DISTINCT b.id) FILTER(WHERE b.status='completed' AND b.booked_for::date BETWEEN $4::date AND $5::date)::int completed_services,
        coalesce((SELECT sum(o.total) FROM shop_orders o WHERE o.organisation_id=$1 AND o.shop_id=$2 AND o.branch_id=br.id AND o.created_at::date BETWEEN $4::date AND $5::date),0) invoiced_sales,
        coalesce((SELECT sum(py.amount) FROM shop_payments py WHERE py.organisation_id=$1 AND py.shop_id=$2 AND py.branch_id=br.id AND py.status='successful' AND py.created_at::date BETWEEN $4::date AND $5::date),0) collections
      FROM shop_branches br
      LEFT JOIN shop_bookings b ON b.branch_id=br.id
      WHERE br.organisation_id=$1 AND br.shop_id=$2
      GROUP BY br.id ORDER BY collections DESC,br.name`,p)).rows;
    case 'approvals': return (await db.query(`
      SELECT requested_at,action_key,target_type,request_title,reason,status,resolved_at,applied_at,apply_error
      FROM shop_approval_requests
      WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2)
        AND requested_at::date BETWEEN $4::date AND $5::date
      ORDER BY requested_at DESC LIMIT 3000`,[orgId,shopId,branchId,from,to])).rows;
    case 'communications': return (await db.query(`
      SELECT created_at,channel,status,recipient,subject,attempt_count,sent_at,last_error
      FROM shop_communication_outbox
      WHERE organisation_id=$1 AND shop_id=$2
        AND created_at::date BETWEEN $4::date AND $5::date
      ORDER BY created_at DESC LIMIT 3000`,[orgId,shopId,branchId,from,to])).rows;
    default: throw Object.assign(new Error('Unknown report type.'),{statusCode:400,code:'UNKNOWN_REPORT'});
  }
}

export async function registerShopOperationsRoutes(app:FastifyInstance,{db,config}:{db:Db;config:ShopConfig}){
  app.get('/api/cashier/session/current',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const session=await activeCashierSession(db,a.core.organisation_id,a.core.id);
    let branchSession:any=null;
    const q=z.object({shopId:uuid.optional(),branchId:uuid.optional()}).parse(req.query);
    if(q.shopId&&q.branchId&&['shop_admin','manager','finance'].includes(a.role)){
      branchSession=await maybeOne<any>(db,`
        SELECT s.*,u.first_name||' '||u.last_name cashier_name,d.business_date
        FROM shop_cashier_sessions s JOIN shop_business_days d ON d.id=s.business_day_id
        LEFT JOIN revolt_x_os.users u ON u.id=s.cashier_user_id
        WHERE s.organisation_id=$1 AND s.shop_id=$2 AND s.branch_id=$3 AND s.status='open' LIMIT 1`,
        [a.core.organisation_id,q.shopId,q.branchId]);
    }
    return{role:a.role,session,branchSession,required:a.role==='cashier'};
  });

  app.post('/api/cashier/session/start',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(!['cashier','shop_admin','manager'].includes(a.role))return reply.code(403).send({error:{code:'CASHIER_ROLE_REQUIRED',message:'Only a cashier, manager or Shop administrator can start a cashier session.'}});
    const b=z.object({shopId:uuid,branchId:uuid,openingCash:money.default(0),note:z.string().max(1000).optional()}).parse(req.body);
    const date=await businessDate(db,b.shopId);
    const result=await tx(db,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",['cashier:'+b.shopId+':'+b.branchId]);
      const branch=await maybeOne<any>(client,`
        SELECT b.id FROM shop_branches b JOIN shops s ON s.id=b.shop_id
        WHERE b.id=$1 AND b.shop_id=$2 AND b.organisation_id=$3 AND b.status='active' AND s.status='active'`,
        [b.branchId,b.shopId,a.core.organisation_id]);
      if(!branch)throw Object.assign(new Error('The selected branch is not active or does not belong to this Shop.'),{statusCode:400,code:'INVALID_BRANCH'});
      const own=await maybeOne<any>(client,"SELECT * FROM shop_cashier_sessions WHERE organisation_id=$1 AND cashier_user_id=$2 AND status='open'",[a.core.organisation_id,a.core.id]);
      if(own)return{alreadyOpen:true,session:own};
      const occupied=await maybeOne<any>(client,`
        SELECT s.*,u.first_name||' '||u.last_name cashier_name
        FROM shop_cashier_sessions s LEFT JOIN revolt_x_os.users u ON u.id=s.cashier_user_id
        WHERE s.shop_id=$1 AND s.branch_id=$2 AND s.status='open' LIMIT 1`,[b.shopId,b.branchId]);
      if(occupied)throw Object.assign(new Error('This branch already has an open cashier session for '+(occupied.cashier_name||'another cashier')+'. That session must be handed over or closed first.'),{statusCode:409,code:'CASHIER_SESSION_ALREADY_OPEN'});

      let day=await maybeOne<any>(client,'SELECT * FROM shop_business_days WHERE shop_id=$1 AND branch_id=$2 AND business_date=$3 FOR UPDATE',[b.shopId,b.branchId,date]);
      if(day?.status==='closed')throw Object.assign(new Error('The business day for this branch has already been closed. A manager must open the next business day before another cashier can start.'),{statusCode:409,code:'BUSINESS_DAY_CLOSED'});
      const previous=await maybeOne<any>(client,`
        SELECT * FROM shop_cashier_sessions
        WHERE shop_id=$1 AND branch_id=$2 AND business_day_id=$3 AND status IN('handed_over','closed')
        ORDER BY ended_at DESC NULLS LAST,started_at DESC LIMIT 1`,[b.shopId,b.branchId,day?.id||'00000000-0000-0000-0000-000000000000']);
      let opening=Number(b.openingCash||0);
      if(day&&previous){
        if(previous.handover_to_user_id&&previous.handover_to_user_id!==a.core.id&&!['shop_admin','manager'].includes(a.role)){
          throw Object.assign(new Error('This cash position was handed over to another cashier. Ask a manager to reassign the handover or sign in as the designated cashier.'),{statusCode:409,code:'HANDOVER_ASSIGNED_TO_ANOTHER_CASHIER'});
        }
        if(previous.actual_cash!=null)opening=Number(previous.actual_cash);
      }
      if(!day){
        day=(await client.query(`
          INSERT INTO shop_business_days(organisation_id,shop_id,branch_id,business_date,opening_cash,opened_by,notes)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [a.core.organisation_id,b.shopId,b.branchId,date,opening,a.core.id,b.note||null]
        )).rows[0];
      }
      const session=(await client.query(`
        INSERT INTO shop_cashier_sessions(
          organisation_id,shop_id,branch_id,business_day_id,cashier_user_id,session_no,opening_cash,previous_session_id
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [a.core.organisation_id,b.shopId,b.branchId,day.id,a.core.id,code('CSH'),opening,previous?.id||null]
      )).rows[0];
      return{day,session};
    });
    await audit(db,a.core.organisation_id,a.core.id,'cashier.session_started','cashier_session',result.session.id,b.shopId,b.branchId,{openingCash:result.session.opening_cash});
    return reply.code(result.alreadyOpen?200:201).send(result);
  });

  app.post('/api/cashier/session/:id/end',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    const id=uuid.parse((req.params as any).id);
    const b=z.object({
      mode:z.enum(['handover','shift_end','end_day']),
      actualCash:money,
      handoverToUserId:uuid.optional(),
      note:z.string().max(1500).optional()
    }).parse(req.body);
    const result=await tx(db,async client=>{
      const sr=await client.query('SELECT * FROM shop_cashier_sessions WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
      if(!sr.rowCount)return null;
      const session=sr.rows[0];
      if(session.status!=='open')throw Object.assign(new Error('This cashier session is already closed.'),{statusCode:409,code:'CASHIER_SESSION_CLOSED'});
      if(a.role==='cashier'&&session.cashier_user_id!==a.core.id)throw Object.assign(new Error('You can only close your own cashier session.'),{statusCode:403,code:'NOT_SESSION_OWNER'});
      if(b.mode==='handover'&&b.handoverToUserId){
        const next=await maybeOne<any>(client,`
          SELECT sm.os_user_id FROM shop_memberships sm
          WHERE sm.organisation_id=$1 AND sm.os_user_id=$2 AND sm.role='cashier' AND sm.status='active'`,
          [a.core.organisation_id,b.handoverToUserId]);
        if(!next)throw Object.assign(new Error('The selected handover user is not an active cashier.'),{statusCode:400,code:'INVALID_HANDOVER_CASHIER'});
      }
      const expected=await sessionExpectedCash(client,session,new Date());
      const variance=Number(b.actualCash)-expected;
      const status=b.mode==='handover'?'handed_over':'closed';
      const ended=(await client.query(`
        UPDATE shop_cashier_sessions SET status=$1,expected_cash=$2,actual_cash=$3,variance=$4,ended_at=now(),
          end_reason=$5,handover_to_user_id=$6,handover_note=$7
        WHERE id=$8 RETURNING *`,
        [status,expected,b.actualCash,variance,b.mode,b.handoverToUserId||null,b.note||null,id]
      )).rows[0];
      const day=await maybeOne<any>(client,'SELECT * FROM shop_business_days WHERE id=$1 FOR UPDATE',[session.business_day_id]);
      let closure:any=null;
      if(b.mode==='end_day'&&day){
        const dayExpected=await dayExpectedCash(client,day,new Date());
        const dayVariance=Number(b.actualCash)-dayExpected;
        await client.query(`
          UPDATE shop_business_days SET status='closed',expected_cash=$1,actual_cash=$2,variance=$3,
            closed_by=$4,closed_at=now(),updated_at=now(),notes=concat_ws(E'\\n',notes,$5)
          WHERE id=$6`,
          [dayExpected,b.actualCash,dayVariance,a.core.id,b.note||null,day.id]
        );
        const totals=await maybeOne<any>(client,`
          SELECT
            coalesce(sum(CASE WHEN method='mobile_money' AND status='successful' THEN amount ELSE 0 END),0) momo,
            coalesce(sum(CASE WHEN method='card' AND status='successful' THEN amount ELSE 0 END),0) card,
            coalesce(sum(CASE WHEN method='bank_transfer' AND status='successful' THEN amount ELSE 0 END),0) bank,
            coalesce(sum(CASE WHEN status='successful' THEN amount ELSE 0 END),0) total
          FROM shop_payments WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3
            AND created_at >= $4 AND created_at <= now()`,
          [session.organisation_id,session.shop_id,session.branch_id,day.opened_at]);
        const expenses=await maybeOne<any>(client,`
          SELECT coalesce(sum(amount),0) total FROM shop_expenses
          WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3 AND created_at >= $4 AND created_at <= now()`,
          [session.organisation_id,session.shop_id,session.branch_id,day.opened_at]);
        closure=(await client.query(`
          INSERT INTO salon_eod_closures(
            organisation_id,shop_id,branch_id,business_date,opening_cash,expected_cash,actual_cash,variance,
            momo_total,card_total,bank_total,total_sales,total_expenses,notes,closed_by,close_mode,review_status
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'cashier','confirmed')
          ON CONFLICT(shop_id,branch_id,business_date) DO UPDATE SET
            expected_cash=EXCLUDED.expected_cash,actual_cash=EXCLUDED.actual_cash,variance=EXCLUDED.variance,
            momo_total=EXCLUDED.momo_total,card_total=EXCLUDED.card_total,bank_total=EXCLUDED.bank_total,
            total_sales=EXCLUDED.total_sales,total_expenses=EXCLUDED.total_expenses,notes=EXCLUDED.notes,
            closed_by=EXCLUDED.closed_by,closed_at=now(),close_mode='cashier',review_status='confirmed'
          RETURNING *`,
          [session.organisation_id,session.shop_id,session.branch_id,day.business_date,day.opening_cash,dayExpected,b.actualCash,dayVariance,
           totals?.momo||0,totals?.card||0,totals?.bank||0,totals?.total||0,expenses?.total||0,b.note||'Cashier close of day',a.core.id]
        )).rows[0];
      }
      return{session:ended,closure};
    });
    if(!result)return reply.code(404).send({error:{code:'SESSION_NOT_FOUND',message:'Cashier session not found.'}});
    await audit(db,a.core.organisation_id,a.core.id,'cashier.session_ended','cashier_session',id,result.session.shop_id,result.session.branch_id,{mode:b.mode,actualCash:b.actualCash,variance:result.session.variance});
    return result;
  });

  app.get('/api/cashier/available-cashiers',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    return (await db.query(`
      SELECT u.id,u.first_name,u.last_name,u.email
      FROM shop_memberships sm
      JOIN revolt_x_os.users u ON u.id=sm.os_user_id
      WHERE sm.organisation_id=$1 AND sm.role='cashier' AND sm.status='active' AND u.status='active'
      ORDER BY u.first_name,u.last_name,u.email`,
      [a.core.organisation_id])).rows;
  });

  app.get('/api/cashier/sessions',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'reports.read');
    const q=z.object({shopId:uuid,branchId:uuid.optional(),from:z.string().optional(),to:z.string().optional()}).parse(req.query);
    return (await db.query(`
      SELECT s.*,d.business_date,u.first_name||' '||u.last_name cashier_name,b.name branch_name
      FROM shop_cashier_sessions s JOIN shop_business_days d ON d.id=s.business_day_id
      LEFT JOIN revolt_x_os.users u ON u.id=s.cashier_user_id JOIN shop_branches b ON b.id=s.branch_id
      WHERE s.organisation_id=$1 AND s.shop_id=$2 AND ($3::uuid IS NULL OR s.branch_id=$3)
        AND ($4::date IS NULL OR d.business_date >= $4::date) AND ($5::date IS NULL OR d.business_date <= $5::date)
      ORDER BY s.started_at DESC LIMIT 1000`,[a.core.organisation_id,q.shopId,q.branchId||null,q.from||null,q.to||null])).rows;
  });

  app.get('/api/role-dashboard',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const q=z.object({shopId:uuid.optional(),branchId:uuid.optional()}).parse(req.query);
    const shopId=q.shopId||null,branchId=q.branchId||null,org=a.core.organisation_id;
    const base=await maybeOne<any>(db,`
      SELECT
        (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND ($3::uuid IS NULL OR branch_id=$3) AND booked_for::date=CURRENT_DATE) appointments_today,
        (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND ($3::uuid IS NULL OR branch_id=$3) AND status IN('queued','checked_in')) waiting_now,
        (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND ($3::uuid IS NULL OR branch_id=$3) AND source IN('public','customer_portal') AND request_seen_at IS NULL) new_requests,
        (SELECT coalesce(sum(total),0) FROM shop_orders WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND ($3::uuid IS NULL OR branch_id=$3) AND created_at::date=CURRENT_DATE) sales_today,
        (SELECT coalesce(sum(amount),0) FROM shop_payments WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND ($3::uuid IS NULL OR branch_id=$3) AND status='successful' AND created_at::date=CURRENT_DATE) payments_today,
        (SELECT count(*)::int FROM shop_inventory_alerts WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND status='open') stock_alerts,
        (SELECT count(*)::int FROM shop_approval_requests WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND status='pending') pending_approvals,
        (SELECT count(*)::int FROM shop_tickets WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) AND status NOT IN('resolved','closed','cancelled')) open_tickets`,
      [org,shopId,branchId]
    );
    const session=a.role==='cashier'?await activeCashierSession(db,org,a.core.id):null;
    const profiles:any={
      shop_admin:{title:'Business Command Centre',subtitle:'Operations, finance, people and controls across your Shop.',metrics:['sales_today','appointments_today','new_requests','stock_alerts','pending_approvals','open_tickets']},
      manager:{title:'Salon Operations',subtitle:'Keep appointments, staff, customers and stock moving smoothly.',metrics:['appointments_today','waiting_now','new_requests','sales_today','stock_alerts','open_tickets']},
      cashier:{title:'Cashier & Reception',subtitle:'Start your session, receive customers, check appointments and collect payments.',metrics:['appointments_today','waiting_now','new_requests','payments_today','open_tickets']},
      finance:{title:'Finance Control Desk',subtitle:'Collections, reconciliation, cash close and financial controls.',metrics:['payments_today','sales_today','pending_approvals']},
      service:{title:'Service Workspace',subtitle:'Today’s clients, waiting queue and service progress.',metrics:['appointments_today','waiting_now','new_requests']},
      inventory:{title:'Stock & Assets',subtitle:'Inventory availability, reorder exceptions and equipment.',metrics:['stock_alerts']},
      auditor:{title:'Audit & Oversight',subtitle:'Read-only view of controls, transactions and exceptions.',metrics:['sales_today','payments_today','pending_approvals','stock_alerts']}
    };
    return{role:a.role,profile:profiles[a.role]||profiles.manager,metrics:base||{},cashierSession:session};
  });

  app.get('/api/notifications',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const q=z.object({shopId:uuid.optional(),after:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(40)}).parse(req.query);
    const rows=(await db.query(`
      SELECT n.*,r.read_at,(r.read_at IS NULL) unread
      FROM shop_notifications n
      LEFT JOIN shop_notification_reads r ON r.notification_id=n.id AND r.os_user_id=$2
      WHERE n.organisation_id=$1
        AND ($3::uuid IS NULL OR n.shop_id=$3)
        AND (n.target_user_id IS NULL OR n.target_user_id=$2)
        AND (n.target_role IS NULL OR n.target_role=$4)
        AND ($5::timestamptz IS NULL OR n.created_at>$5::timestamptz)
      ORDER BY n.created_at DESC LIMIT $6`,
      [a.core.organisation_id,a.core.id,q.shopId||null,a.role,q.after||null,q.limit])).rows;
    return rows;
  });

  app.post('/api/notifications/:id/read',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const id=uuid.parse((req.params as any).id);
    const exists=await maybeOne<any>(db,'SELECT id FROM shop_notifications WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!exists)return reply.code(404).send({error:{code:'NOTIFICATION_NOT_FOUND',message:'Notification not found.'}});
    await db.query(`INSERT INTO shop_notification_reads(notification_id,os_user_id) VALUES($1,$2) ON CONFLICT(notification_id,os_user_id) DO UPDATE SET read_at=now()`,[id,a.core.id]);
    return{read:true};
  });

  app.post('/api/requests/:id/seen',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const id=uuid.parse((req.params as any).id);
    const r=await db.query(`
      UPDATE shop_bookings SET request_seen_at=coalesce(request_seen_at,now()),request_seen_by=coalesce(request_seen_by,$1)
      WHERE id=$2 AND organisation_id=$3 AND source IN('public','customer_portal') RETURNING *`,
      [a.core.id,id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(404).send({error:{code:'BOOKING_REQUEST_NOT_FOUND',message:'Booking request not found.'}});
    return r.rows[0];
  });

  app.get('/api/requests/external',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const q=z.object({shopId:uuid,branchId:uuid.optional(),status:z.string().optional()}).parse(req.query);
    return (await db.query(`
      SELECT b.*,s.name service_name,st.full_name barber_name,ch.name chair_name,
             gm.title inspiration_title,gm.media_type inspiration_media_type
      FROM shop_bookings b
      LEFT JOIN shop_services s ON s.id=b.service_id
      LEFT JOIN salon_staff st ON st.id=b.salon_staff_id
      LEFT JOIN salon_chairs ch ON ch.id=b.salon_chair_id
      LEFT JOIN shop_gallery_media gm ON gm.id=b.inspiration_media_id
      WHERE b.organisation_id=$1 AND b.shop_id=$2 AND ($3::uuid IS NULL OR b.branch_id=$3)
        AND b.source IN('public','customer_portal')
        AND ($4='' OR b.status=$4)
      ORDER BY b.created_at DESC LIMIT 500`,
      [a.core.organisation_id,q.shopId,q.branchId||null,q.status||''])).rows;
  });

  app.get('/api/leave',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const q=z.object({shopId:uuid.optional(),branchId:uuid.optional(),status:z.string().optional()}).parse(req.query);
    const canReview=await hasShopCapability(db,a.core.organisation_id,a.role,'leave.review');
    const params=[a.core.organisation_id,q.shopId||null,q.branchId||null,q.status||'',a.core.id,canReview];
    return (await db.query(`
      SELECT l.*,coalesce(st.full_name,u.first_name||' '||u.last_name) applicant_name,
             rel.full_name relief_name,rv.first_name||' '||rv.last_name reviewer_name
      FROM shop_staff_leave_requests l
      LEFT JOIN salon_staff st ON st.id=l.salon_staff_id
      LEFT JOIN salon_staff rel ON rel.id=l.relief_staff_id
      LEFT JOIN revolt_x_os.users u ON u.id=l.applicant_user_id
      LEFT JOIN revolt_x_os.users rv ON rv.id=l.reviewed_by
      WHERE l.organisation_id=$1
        AND ($2::uuid IS NULL OR l.shop_id=$2)
        AND ($3::uuid IS NULL OR l.branch_id=$3)
        AND ($4='' OR l.status=$4)
        AND ($6::boolean=true OR l.applicant_user_id=$5 OR l.requested_by=$5)
      ORDER BY l.requested_at DESC LIMIT 500`,params)).rows;
  });

  app.post('/api/leave',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    const b=z.object({
      shopId:uuid,branchId:uuid.optional(),salonStaffId:uuid.optional(),leaveType:z.string().trim().min(2).max(100),
      startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason:z.string().trim().min(3).max(2000),reliefStaffId:uuid.optional(),reliefNotes:z.string().max(2000).optional()
    }).parse(req.body);
    if(b.endDate<b.startDate)return reply.code(400).send({error:{code:'INVALID_LEAVE_DATES',message:'Leave end date cannot be before the start date.'}});
    let applicantUserId:string|null=a.core.id,salonStaffId:string|null=b.salonStaffId||null;
    const canReview=await hasShopCapability(db,a.core.organisation_id,a.role,'leave.review');
    if(salonStaffId&&!canReview){
      const linked=await maybeOne<any>(db,'SELECT id FROM salon_staff WHERE id=$1 AND organisation_id=$2 AND os_user_id=$3',[salonStaffId,a.core.organisation_id,a.core.id]);
      if(!linked)return reply.code(403).send({error:{code:'LEAVE_APPLICANT_FORBIDDEN',message:'You can only submit a leave request for yourself.'}});
    }
    if(salonStaffId){
      const st=await maybeOne<any>(db,'SELECT id,os_user_id FROM salon_staff WHERE id=$1 AND organisation_id=$2 AND shop_id=$3',[salonStaffId,a.core.organisation_id,b.shopId]);
      if(!st)return reply.code(400).send({error:{code:'STAFF_NOT_FOUND',message:'The selected staff member does not belong to this Shop.'}});
      applicantUserId=st.os_user_id||null;
    }
    const r=await db.query(`
      INSERT INTO shop_staff_leave_requests(
        organisation_id,shop_id,branch_id,applicant_user_id,salon_staff_id,leave_type,start_date,end_date,reason,relief_staff_id,relief_notes,requested_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,applicantUserId,salonStaffId,b.leaveType,b.startDate,b.endDate,b.reason,b.reliefStaffId||null,b.reliefNotes||null,a.core.id]
    );
    await audit(db,a.core.organisation_id,a.core.id,'leave.requested','leave',r.rows[0].id,b.shopId,b.branchId||null,{startDate:b.startDate,endDate:b.endDate,leaveType:b.leaveType});
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/leave/:id/review',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    const canReview=await hasShopCapability(db,a.core.organisation_id,a.role,'leave.review');
    if(!canReview)return reply.code(403).send({error:{code:'LEAVE_REVIEW_FORBIDDEN',message:'Your Shop role cannot approve or reject leave requests.'}});
    const id=uuid.parse((req.params as any).id);
    const b=z.object({decision:z.enum(['approved','rejected']),note:z.string().max(1500).optional()}).parse(req.body);
    const r=await db.query(`
      UPDATE shop_staff_leave_requests SET status=$1,reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now()
      WHERE id=$4 AND organisation_id=$5 AND status='pending' RETURNING *`,
      [b.decision,a.core.id,b.note||null,id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(409).send({error:{code:'LEAVE_NOT_PENDING',message:'This leave request is no longer pending.'}});
    await audit(db,a.core.organisation_id,a.core.id,'leave.'+b.decision,'leave',id,r.rows[0].shop_id,r.rows[0].branch_id,{note:b.note||null});
    return r.rows[0];
  });

  app.patch('/api/leave/:id/cancel',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    const id=uuid.parse((req.params as any).id);
    const r=await db.query(`
      UPDATE shop_staff_leave_requests SET status='cancelled',updated_at=now()
      WHERE id=$1 AND organisation_id=$2 AND status='pending' AND (applicant_user_id=$3 OR requested_by=$3) RETURNING *`,
      [id,a.core.organisation_id,a.core.id]);
    if(!r.rowCount)return reply.code(409).send({error:{code:'LEAVE_CANNOT_CANCEL',message:'Only your own pending leave request can be cancelled.'}});
    return r.rows[0];
  });

  app.get('/api/gallery',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const q=z.object({shopId:uuid}).parse(req.query);
    return (await db.query(`
      SELECT id,shop_id,branch_id,title,description,category,media_type,content_type,external_url,service_id,staff_id,is_published,sort_order,created_at,
             CASE WHEN file_data IS NOT NULL THEN '/api/public/media/'||id::text ELSE external_url END media_url
      FROM shop_gallery_media WHERE organisation_id=$1 AND shop_id=$2 ORDER BY sort_order,created_at DESC`,
      [a.core.organisation_id,q.shopId])).rows;
  });

  app.post('/api/gallery',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'media.manage');
    const b=z.object({
      shopId:uuid,branchId:uuid.optional(),title:z.string().trim().min(2).max(180),description:z.string().max(2000).optional(),
      category:z.string().max(100).optional(),mediaType:z.enum(['image','video']),dataUrl:z.string().optional(),externalUrl:z.string().url().optional(),
      serviceId:uuid.optional(),staffId:uuid.optional(),isPublished:z.boolean().default(true),sortOrder:z.coerce.number().int().min(0).max(10000).default(0)
    }).refine(x=>Boolean(x.dataUrl||x.externalUrl),{message:'Upload a media file or provide a media URL.',path:['dataUrl']}).parse(req.body);
    let contentType:string|null=null,fileData:Buffer|null=null;
    if(b.dataUrl){
      const m=b.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if(!m)return reply.code(400).send({error:{code:'INVALID_MEDIA_FILE',message:'The uploaded media file could not be read. Please choose a valid image or video.'}});
      contentType=m[1].toLowerCase();
      const allowed=b.mediaType==='image'?contentType.startsWith('image/'):contentType.startsWith('video/');
      if(!allowed)return reply.code(400).send({error:{code:'MEDIA_TYPE_MISMATCH',message:'The selected file does not match the chosen media type.'}});
      fileData=Buffer.from(m[2],'base64');
      const max=b.mediaType==='image'?8*1024*1024:24*1024*1024;
      if(fileData.length>max)return reply.code(413).send({error:{code:'MEDIA_TOO_LARGE',message:b.mediaType==='image'?'Image files must be 8 MB or smaller.':'Video files must be 24 MB or smaller.'}});
    }
    const r=await db.query(`
      INSERT INTO shop_gallery_media(
        organisation_id,shop_id,branch_id,title,description,category,media_type,content_type,file_data,external_url,service_id,staff_id,is_published,sort_order,uploaded_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id,title,media_type,is_published,created_at`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.title,b.description||null,b.category||null,b.mediaType,contentType,fileData,b.externalUrl||null,b.serviceId||null,b.staffId||null,b.isPublished,b.sortOrder,a.core.id]
    );
    await audit(db,a.core.organisation_id,a.core.id,'gallery.media_added','gallery_media',r.rows[0].id,b.shopId,b.branchId||null,{title:b.title,mediaType:b.mediaType});
    return reply.code(201).send(r.rows[0]);
  });

  app.patch('/api/gallery/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'media.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({title:z.string().trim().min(2).max(180).optional(),description:z.string().max(2000).nullable().optional(),category:z.string().max(100).nullable().optional(),serviceId:uuid.nullable().optional(),staffId:uuid.nullable().optional(),isPublished:z.boolean().optional(),sortOrder:z.coerce.number().int().min(0).max(10000).optional()}).parse(req.body);
    const r=await db.query(`
      UPDATE shop_gallery_media SET
        title=coalesce($1,title),
        description=CASE WHEN $2 THEN $3 ELSE description END,
        category=CASE WHEN $4 THEN $5 ELSE category END,
        service_id=CASE WHEN $6 THEN $7 ELSE service_id END,
        staff_id=CASE WHEN $8 THEN $9 ELSE staff_id END,
        is_published=coalesce($10,is_published),sort_order=coalesce($11,sort_order),updated_at=now()
      WHERE id=$12 AND organisation_id=$13 RETURNING id,title,is_published,updated_at`,
      [b.title??null,Object.prototype.hasOwnProperty.call(b,'description'),b.description??null,Object.prototype.hasOwnProperty.call(b,'category'),b.category??null,Object.prototype.hasOwnProperty.call(b,'serviceId'),b.serviceId??null,Object.prototype.hasOwnProperty.call(b,'staffId'),b.staffId??null,b.isPublished??null,b.sortOrder??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{code:'MEDIA_NOT_FOUND',message:'Gallery media item not found.'}});
    return r.rows[0];
  });

  app.delete('/api/gallery/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'media.manage');
    const id=uuid.parse((req.params as any).id);
    const r=await db.query('DELETE FROM shop_gallery_media WHERE id=$1 AND organisation_id=$2 RETURNING id,shop_id,branch_id',[id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(404).send({error:{code:'MEDIA_NOT_FOUND',message:'Gallery media item not found.'}});
    await audit(db,a.core.organisation_id,a.core.id,'gallery.media_deleted','gallery_media',id,r.rows[0].shop_id,r.rows[0].branch_id,{});
    return{deleted:true};
  });

  app.get('/api/public/store/:slug/gallery',async(req,reply)=>{
    const slug=z.string().min(2).max(120).parse((req.params as any).slug);
    const shop=await maybeOne<any>(db,"SELECT id FROM shops WHERE public_slug=$1 AND status='active'",[slug]);
    if(!shop)return reply.code(404).send({error:{code:'SHOP_NOT_FOUND',message:'Shop not found.'}});
    return (await db.query(`
      SELECT gm.id,gm.title,gm.description,gm.category,gm.media_type,gm.external_url,gm.service_id,gm.staff_id,gm.created_at,
             s.name service_name,st.full_name barber_name,
             CASE WHEN gm.file_data IS NOT NULL THEN '/api/public/media/'||gm.id::text ELSE gm.external_url END media_url
      FROM shop_gallery_media gm
      LEFT JOIN shop_services s ON s.id=gm.service_id
      LEFT JOIN salon_staff st ON st.id=gm.staff_id
      WHERE gm.shop_id=$1 AND gm.is_published=true
      ORDER BY gm.sort_order,gm.created_at DESC LIMIT 100`,[shop.id])).rows;
  });

  app.get('/api/public/media/:id',async(req,reply)=>{
    const id=uuid.parse((req.params as any).id);
    const media=await maybeOne<any>(db,'SELECT content_type,file_data,external_url FROM shop_gallery_media WHERE id=$1 AND is_published=true',[id]);
    if(!media)return reply.code(404).send({error:{code:'MEDIA_NOT_FOUND',message:'Media item not found.'}});
    if(media.file_data)return reply.type(media.content_type||'application/octet-stream').header('Cache-Control','public, max-age=86400').send(media.file_data);
    return reply.redirect(media.external_url);
  });

  app.get('/api/reports/catalog',async(req,reply)=>{
    await authorize(db,config,req,reply,'reports.read');
    return[
      ['executive_summary','Executive Summary','Management','KPIs across appointments, sales, payments, customers and exceptions'],
      ['sales','Sales & Invoices','Commerce','Invoice totals, discounts, tax, paid values and balances'],
      ['payments','Payments','Commerce','Payment methods, providers, fees and reconciliation status'],
      ['appointments','Appointments & Service','Operations','All appointments, sources, barbers, chairs and service lifecycle'],
      ['customers','Customer Register','Customers','Customer status, loyalty, credit and visit information'],
      ['staff_performance','Staff Performance','People','Completed services, no-shows, service value and commission'],
      ['inventory','Inventory Position','Inventory','Stock, reorder levels, selling prices and health'],
      ['stock_movements','Stock Movements','Inventory','Opening, adjustment, sales and purchase stock movement history'],
      ['expenses','Expenses','Finance','Expense register by date, category and payment method'],
      ['cashier_sessions','Cashier Sessions','Finance','Session starts, handovers, close values and variances'],
      ['leave','Leave & Relief','People','Leave requests, relief plans and approvals'],
      ['commissions','Barber Commissions','People','Earned commissions and payment status'],
      ['eod','End of Day','Finance','Daily sales, cash, digital payments, expenses and variance'],
      ['tickets','Tickets & Requests','Support','Customer and internal request lifecycle'],
      ['procurement','Procurement','Inventory','Purchase orders, suppliers and approval state'],
      ['assets','Assets & Equipment','Inventory','Equipment register, condition and service dates'],
      ['reconciliation','Payment Reconciliation','Finance','Settlement and reconciliation state of collections'],
      ['service_performance','Service Performance','Operations','Demand, completions, cancellations, no-shows and service value by service'],
      ['booking_sources','Booking Sources','Operations','Bookings by public page, customer portal, staff and appointment type'],
      ['customer_retention','Customer Retention','Customers','Active and inactive customer base, portal adoption and engagement age'],
      ['branch_performance','Branch Performance','Management','Appointments, completions, invoiced sales and collections by branch'],
      ['approvals','Approval Workflow','Controls','Controlled changes, decisions and application status'],
      ['communications','Communication Delivery','Customers','SMS, WhatsApp and email outbox delivery and failures'],
      ['audit','Audit Trail','Controls','Recorded system activity and control events']
    ].map(x=>({key:x[0],name:x[1],group:x[2],description:x[3]}));
  });

  app.get('/api/reports/run',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'reports.read');
    const q=z.object({
      type:z.string().min(2),shopId:uuid,branchId:uuid.optional(),
      from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      format:z.enum(['json','csv']).default('json')
    }).parse(req.query);
    const to=q.to||new Date().toISOString().slice(0,10);
    const d=new Date(to+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-30);
    const from=q.from||d.toISOString().slice(0,10);
    if(from>to)return reply.code(400).send({error:{code:'INVALID_REPORT_RANGE',message:'Report start date cannot be after the end date.'}});
    const rows=await reportRows(db,a.core.organisation_id,q.type,q.shopId,q.branchId||null,from,to);
    if(q.format==='csv'){
      reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="'+q.type+'-'+from+'-'+to+'.csv"');
      return csv(rows);
    }
    return{type:q.type,from,to,rows,count:rows.length};
  });

  app.get('/api/customer-portal/payment-preference',async(req,reply)=>{
    const c=await customerContext(db,req);
    const pref=await maybeOne<any>(db,'SELECT * FROM shop_customer_payment_preferences WHERE shop_id=$1 AND customer_id=$2',[c.shop_id,c.customer_id]);
    return pref||{preferred_method:'mobile_money',momo_phone:c.phone||'',receipt_email:c.email||''};
  });

  app.put('/api/customer-portal/payment-preference',async(req,reply)=>{
    const c=await customerContext(db,req);
    const b=z.object({preferredMethod:z.enum(['cash','mobile_money','card','bank_transfer']),momoPhone:z.string().max(60).optional().nullable(),receiptEmail:z.string().email().optional().nullable()}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_customer_payment_preferences(organisation_id,shop_id,customer_id,preferred_method,momo_phone,receipt_email)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(shop_id,customer_id) DO UPDATE SET preferred_method=EXCLUDED.preferred_method,momo_phone=EXCLUDED.momo_phone,receipt_email=EXCLUDED.receipt_email,updated_at=now()
      RETURNING *`,[c.organisation_id,c.shop_id,c.customer_id,b.preferredMethod,b.momoPhone??null,b.receiptEmail??null]);
    return r.rows[0];
  });

  app.post('/api/customer-portal/orders/:id/pay',async(req,reply)=>{
    const c=await customerContext(db,req);
    if(!config.PAYSTACK_SECRET_KEY)return reply.code(503).send({error:{code:'PAYMENT_PROVIDER_NOT_CONFIGURED',message:'Online payment is not yet configured for this Shop. Please choose Pay at Salon or contact the Shop.'}});
    const id=uuid.parse((req.params as any).id);
    const b=z.object({method:z.enum(['mobile_money','card']),amount:positive.optional(),phone:z.string().max(60).optional(),email:z.string().email().optional()}).parse(req.body);
    const order=await maybeOne<any>(db,'SELECT * FROM shop_orders WHERE id=$1 AND shop_id=$2 AND customer_id=$3',[id,c.shop_id,c.customer_id]);
    if(!order)return reply.code(404).send({error:{code:'CUSTOMER_ORDER_NOT_FOUND',message:'Invoice not found in your customer account.'}});
    const outstanding=Math.max(0,Number(order.total)-Number(order.amount_paid));
    if(outstanding<=0)return reply.code(409).send({error:{code:'ORDER_ALREADY_PAID',message:'This invoice is already fully paid.'}});
    const amount=b.amount??outstanding;
    if(amount>outstanding+0.001)return reply.code(400).send({error:{code:'PAYMENT_EXCEEDS_BALANCE',message:'Payment amount cannot be more than the outstanding invoice balance.'}});
    const email=b.email||c.email;
    if(!email)return reply.code(400).send({error:{code:'PAYMENT_EMAIL_REQUIRED',message:'Add an email address to your profile before starting an online payment.'}});
    const reference=code('CUSTPAY');
    const callback=(config.PUBLIC_BASE_URL||'').replace(/\/$/,'')+'/payments/callback?reference='+encodeURIComponent(reference);
    const ps=await fetch('https://api.paystack.co/transaction/initialize',{
      method:'POST',headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY,'content-type':'application/json'},
      body:JSON.stringify({
        email,amount:Math.round(amount*100),currency:config.PAYSTACK_CURRENCY,reference,channels:[b.method],callback_url:callback||undefined,
        metadata:{order_id:order.id,shop_id:c.shop_id,organisation_id:c.organisation_id,customer_id:c.customer_id,payer_phone:b.phone||c.phone||null,source:'customer_portal'}
      }),signal:AbortSignal.timeout(15000)
    });
    const data=await ps.json().catch(()=>null) as any;
    if(!ps.ok||!data?.status)return reply.code(502).send({error:{code:'PAYMENT_INITIALIZATION_FAILED',message:data?.message||'The payment provider could not start this payment. Please try again.'}});
    const payment=(await db.query(`
      INSERT INTO shop_payments(organisation_id,shop_id,branch_id,order_id,customer_id,reference,provider,provider_reference,method,amount,currency,status,payer_phone,payer_email,raw_json,source)
      VALUES($1,$2,$3,$4,$5,$6,'paystack',$7,$8,$9,$10,'pending',$11,$12,$13,'customer_portal') RETURNING *`,
      [c.organisation_id,c.shop_id,order.branch_id,order.id,c.customer_id,reference,data.data?.reference||reference,b.method,amount,config.PAYSTACK_CURRENCY,b.phone||c.phone||null,email,JSON.stringify(data)]
    )).rows[0];
    return{payment,authorization_url:data.data?.authorization_url,access_code:data.data?.access_code};
  });

  app.get('/api/public/store/:slug/auth-config',async(req,reply)=>{
    const slug=z.string().min(2).max(120).parse((req.params as any).slug);
    const shop=await maybeOne<any>(db,"SELECT id FROM shops WHERE public_slug=$1 AND status='active'",[slug]);
    if(!shop)return reply.code(404).send({error:{code:'SHOP_NOT_FOUND',message:'Shop not found.'}});
    return{google:{enabled:Boolean(config.GOOGLE_CLIENT_ID),clientId:config.GOOGLE_CLIENT_ID||null}};
  });

  app.post('/api/customer-portal/:slug/google',async(req,reply)=>{
    if(!config.GOOGLE_CLIENT_ID)return reply.code(503).send({error:{code:'GOOGLE_SIGNIN_NOT_CONFIGURED',message:'Google sign-in is not configured for this Shop.'}});
    const slug=z.string().min(2).max(120).parse((req.params as any).slug);
    const b=z.object({credential:z.string().min(20),phone:z.string().max(60).optional()}).parse(req.body);
    const verify=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(b.credential),{signal:AbortSignal.timeout(12000)});
    const profile=await verify.json().catch(()=>null) as any;
    if(!verify.ok||profile?.aud!==config.GOOGLE_CLIENT_ID||profile?.email_verified!=='true')return reply.code(401).send({error:{code:'GOOGLE_SIGNIN_INVALID',message:'Google could not verify this sign-in. Please try again or use email registration.'}});
    const shop=await maybeOne<any>(db,"SELECT * FROM shops WHERE public_slug=$1 AND status='active'",[slug]);
    if(!shop)return reply.code(404).send({error:{code:'SHOP_NOT_FOUND',message:'Shop not found.'}});
    const result=await tx(db,async client=>{
      let customer=await maybeOne<any>(client,'SELECT * FROM shop_customers WHERE shop_id=$1 AND lower(email)=lower($2) ORDER BY created_at LIMIT 1',[shop.id,profile.email]);
      if(!customer){
        const branch=await maybeOne<any>(client,"SELECT id FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY created_at LIMIT 1",[shop.id]);
        customer=(await client.query(`
          INSERT INTO shop_customers(organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status,portal_registered_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'retail','active',now()) RETURNING *`,
          [shop.organisation_id,shop.id,branch?.id||null,code('CUS'),profile.name||profile.email,b.phone||null,profile.email]
        )).rows[0];
      }else if(customer.status==='inactive'){
        customer=(await client.query("UPDATE shop_customers SET status='active',reactivation_at=now(),inactive_at=NULL WHERE id=$1 RETURNING *",[customer.id])).rows[0];
      }
      let account=await maybeOne<any>(client,'SELECT * FROM shop_customer_portal_accounts WHERE shop_id=$1 AND customer_id=$2',[shop.id,customer.id]);
      let newRegistration=false;
      if(!account){
        newRegistration=true;
        account=(await client.query(`
          INSERT INTO shop_customer_portal_accounts(organisation_id,shop_id,customer_id,email,phone,password_hash,status)
          VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
          [shop.organisation_id,shop.id,customer.id,profile.email,customer.phone,randomPasswordHash()]
        )).rows[0];
      }
      if(newRegistration){
        const setting=await maybeOne<any>(client,'SELECT welcome_discount_percent FROM shop_automation_settings WHERE shop_id=$1 AND branch_id IS NULL ORDER BY created_at LIMIT 1',[shop.id]);
        const pct=Number(setting?.welcome_discount_percent??10);
        if(pct>0)await client.query(`
          INSERT INTO shop_customer_discounts(organisation_id,shop_id,customer_id,code,discount_type,discount_value,reason,expires_at)
          VALUES($1,$2,$3,$4,'percent',$5,'Customer portal registration',now()+interval '90 days')`,
          [shop.organisation_id,shop.id,customer.id,code('WELCOME'),pct]);
      }
      return{account,customer};
    });
    await createCustomerSession(db,config,reply,result.account.id);
    return{ok:true,customer:{id:result.customer.id,name:result.customer.name}};
  });
}
