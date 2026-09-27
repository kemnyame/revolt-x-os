import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import { maybeOne, tx } from './db.js';
import type { ShopConfig } from './config.js';
import { authorize } from './auth.js';
import { assertSalonBookingAvailability } from './salon.js';

const uuid=z.string().uuid();
const money=z.coerce.number().finite().min(0);
const positive=z.coerce.number().finite().positive();

function code(prefix:string){
  return prefix+'-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+randomBytes(3).toString('hex').toUpperCase();
}
function sha(v:string){return createHash('sha256').update(v).digest('hex');}
function passwordHash(password:string){
  const salt=randomBytes(16).toString('hex');
  const out=scryptSync(password,salt,64).toString('hex');
  return 'scrypt$'+salt+'$'+out;
}
function passwordOk(password:string,encoded:string){
  const [algo,salt,digest]=String(encoded||'').split('$');
  if(algo!=='scrypt'||!salt||!digest)return false;
  const a=Buffer.from(digest,'hex');
  const b=scryptSync(password,salt,a.length);
  return a.length===b.length&&timingSafeEqual(a,b);
}
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
async function audit(db:Db,orgId:string,actor:string|null,action:string,resourceType:string,resourceId:string|null,shopId:string|null,branchId:string|null,metadata:any={}){
  await db.query(
    `INSERT INTO shop_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,branch_id,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [orgId,actor,action,resourceType,resourceId,shopId,branchId,JSON.stringify(metadata)]
  );
}

const defaultRoles=[
  ['shop_admin','Shop Administrator','Full Shop administration and control'],
  ['manager','Manager','Operations, customers, services, sales and reporting'],
  ['cashier','Cashier / Reception','Bookings, POS, payments and customer reception'],
  ['finance','Finance','Accounts, payments, expenses, EOD and financial reporting'],
  ['service','Service / Barber','Appointments, queue, customer service and service workflow'],
  ['inventory','Inventory','Products, stock, equipment and reorder controls'],
  ['auditor','Auditor','Read-only finance, reporting and audit review']
] as const;

async function ensureDefaultRoles(db:Db,orgId:string){
  for(const [key,name,description] of defaultRoles){
    await db.query(
      `INSERT INTO shop_roles(organisation_id,key,name,description,is_system,is_active)
       VALUES($1,$2,$3,$4,true,true)
       ON CONFLICT(organisation_id,key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,is_active=true,updated_at=now()`,
      [orgId,key,name,description]
    );
  }
}

async function ensureFinanceDefaults(db:Db,orgId:string,shopId:string){
  const rows=[
    ['1000','Cash on Hand','asset','cash',true],
    ['1010','Bank Account','asset','bank',true],
    ['1020','Mobile Money Clearing','asset','mobile_money',true],
    ['1030','Card Clearing','asset','card',true],
    ['1100','Accounts Receivable','asset','receivable',false],
    ['2000','Accounts Payable','liability','payable',false],
    ['2100','Tax Payable','liability','tax',false],
    ['3000','Owner Equity','equity','equity',false],
    ['4000','Service Revenue','income','service_revenue',false],
    ['4010','Product Sales','income','product_sales',false],
    ['5000','Cost of Sales','expense','cost_of_sales',false],
    ['5100','Payment Processing Fees','expense','payment_fees',false],
    ['5200','Staff Commissions & Payroll','expense','payroll',false],
    ['5300','Rent','expense','rent',false],
    ['5400','Utilities','expense','utilities',false],
    ['5500','Consumables & Supplies','expense','supplies',false],
    ['5600','Taxes, Levies & Statutory Charges','expense','tax_expense',false]
  ] as const;
  for(const [codeNo,name,type,subtype,isCash] of rows){
    await db.query(
      `INSERT INTO shop_finance_accounts(organisation_id,shop_id,code,name,account_type,subtype,is_cash_account,is_system,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,true,true)
       ON CONFLICT(organisation_id,shop_id,code)
       DO UPDATE SET name=EXCLUDED.name,account_type=EXCLUDED.account_type,subtype=EXCLUDED.subtype,is_cash_account=EXCLUDED.is_cash_account,is_active=true,updated_at=now()`,
      [orgId,shopId,codeNo,name,type,subtype,isCash]
    );
  }
}

async function ensureAutomationSetting(db:Db,orgId:string,shopId:string,branchId:string|null){
  await db.query(
    `INSERT INTO shop_automation_settings(organisation_id,shop_id,branch_id)
     VALUES($1,$2,$3)
     ON CONFLICT(shop_id,branch_id) DO NOTHING`,
    [orgId,shopId,branchId]
  );
}

async function syncCustomerLifecycle(db:Db,orgId?:string){
  const params:any[]=[];
  let filter='';
  if(orgId){params.push(orgId);filter=' AND c.organisation_id=$1';}
  await db.query(
    `UPDATE shop_customers c SET last_visit_at=v.last_visit
     FROM (
       SELECT customer_id,max(coalesce(service_completed_at,booked_for)) last_visit
       FROM shop_bookings
       WHERE customer_id IS NOT NULL AND status='completed'
       GROUP BY customer_id
     ) v
     WHERE c.id=v.customer_id
       AND (c.last_visit_at IS NULL OR c.last_visit_at<v.last_visit)
       ${filter}`,
    params
  );

  const q=await db.query(
    `SELECT c.id,c.organisation_id,c.shop_id,
            coalesce(a.inactivity_days,90)::int inactivity_days,
            coalesce(c.last_visit_at,c.created_at) activity_at
     FROM shop_customers c
     LEFT JOIN shop_automation_settings a ON a.shop_id=c.shop_id AND a.branch_id IS NULL
     WHERE c.status='active'
       ${orgId?'AND c.organisation_id=$1':''}
       AND coalesce(c.last_visit_at,c.created_at)
           < now()-(coalesce(a.inactivity_days,90)||' days')::interval`,
    orgId?[orgId]:[]
  );
  for(const row of q.rows){
    await db.query('UPDATE shop_customers SET status=\'inactive\',inactive_at=coalesce(inactive_at,now()) WHERE id=$1',[row.id]);
    await audit(db,row.organisation_id,null,'customer.auto_inactivated','customer',row.id,row.shop_id,null,{inactivityDays:row.inactivity_days,lastActivity:row.activity_at});
  }
  return{inactivated:q.rowCount??0};
}

async function syncInventoryAlerts(db:Db,orgId?:string){
  const products=await db.query(
    `SELECT p.*
     FROM shop_products p
     WHERE p.active=true
       ${orgId?'AND p.organisation_id=$1':''}
       AND p.stock_quantity<=p.reorder_level`,
    orgId?[orgId]:[]
  );
  for(const p of products.rows){
    const exists=await maybeOne<any>(db,
      `SELECT id FROM shop_inventory_alerts
       WHERE alert_type IN('reorder','out_of_stock') AND product_id=$1 AND status IN('open','acknowledged')
       ORDER BY created_at DESC LIMIT 1`,
      [p.id]
    );
    if(!exists){
      const type=Number(p.stock_quantity)<=0?'out_of_stock':'reorder';
      await db.query(
        `INSERT INTO shop_inventory_alerts(organisation_id,shop_id,alert_type,product_id,severity,message)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [p.organisation_id,p.shop_id,type,p.id,type==='out_of_stock'?'critical':'warning',
          type==='out_of_stock'?p.name+' is out of stock':p.name+' has reached its reorder level']
      );
    }
  }
  await db.query(
    `UPDATE shop_inventory_alerts a SET status='resolved',resolved_at=now()
     FROM shop_products p
     WHERE a.product_id=p.id AND a.status IN('open','acknowledged')
       AND a.alert_type IN('reorder','out_of_stock')
       AND p.stock_quantity>p.reorder_level
       ${orgId?'AND a.organisation_id=$1':''}`,
    orgId?[orgId]:[]
  );

  const assets=await db.query(
    `SELECT * FROM shop_assets
     WHERE status='active'
       ${orgId?'AND organisation_id=$1':''}
       AND next_service_date IS NOT NULL AND next_service_date<=CURRENT_DATE+7`,
    orgId?[orgId]:[]
  );
  for(const a of assets.rows){
    const exists=await maybeOne<any>(db,
      `SELECT id FROM shop_inventory_alerts
       WHERE alert_type='asset_service' AND asset_id=$1 AND status IN('open','acknowledged')
       LIMIT 1`,[a.id]);
    if(!exists)await db.query(
      `INSERT INTO shop_inventory_alerts(organisation_id,shop_id,branch_id,alert_type,asset_id,severity,message)
       VALUES($1,$2,$3,'asset_service',$4,'warning',$5)`,
      [a.organisation_id,a.shop_id,a.branch_id,a.id,a.name+' is due for maintenance']
    );
  }
  return{lowStock:products.rowCount??0,serviceDue:assets.rowCount??0};
}

async function autoCloseEod(db:Db){
  const eligible=await db.query(`
    SELECT b.organisation_id,b.shop_id,b.id branch_id,
           coalesce(a.auto_eod_time,'21:00'::time) auto_eod_time,
           coalesce(ss.timezone,'Africa/Accra') timezone,
           (now() AT TIME ZONE coalesce(ss.timezone,'Africa/Accra'))::date business_date
    FROM shop_branches b
    JOIN shops s ON s.id=b.shop_id AND s.status='active'
    LEFT JOIN salon_settings ss ON ss.shop_id=b.shop_id
    LEFT JOIN shop_automation_settings a ON a.shop_id=b.shop_id AND a.branch_id=b.id
    WHERE b.status='active'
      AND coalesce(a.auto_eod_enabled,true)=true
      AND (now() AT TIME ZONE coalesce(ss.timezone,'Africa/Accra'))::time>=coalesce(a.auto_eod_time,'21:00'::time)
      AND NOT EXISTS(
        SELECT 1 FROM salon_eod_closures e
        WHERE e.shop_id=b.shop_id AND e.branch_id=b.id
          AND e.business_date=(now() AT TIME ZONE coalesce(ss.timezone,'Africa/Accra'))::date
      )`);
  for(const b of eligible.rows){
    const p=await maybeOne<any>(db,`
      SELECT
        coalesce(sum(CASE WHEN method='cash' AND status='successful' THEN amount ELSE 0 END),0) cash,
        coalesce(sum(CASE WHEN method='mobile_money' AND status='successful' THEN amount ELSE 0 END),0) momo,
        coalesce(sum(CASE WHEN method='card' AND status='successful' THEN amount ELSE 0 END),0) card,
        coalesce(sum(CASE WHEN method='bank_transfer' AND status='successful' THEN amount ELSE 0 END),0) bank,
        coalesce(sum(CASE WHEN status='successful' THEN amount ELSE 0 END),0) total
      FROM shop_payments
      WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3 AND created_at::date=$4`,
      [b.organisation_id,b.shop_id,b.branch_id,b.business_date]
    );
    const e=await maybeOne<any>(db,`
      SELECT coalesce(sum(amount),0) total,
             coalesce(sum(CASE WHEN payment_method='cash' THEN amount ELSE 0 END),0) cash
      FROM shop_expenses
      WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3 AND expense_date=$4`,
      [b.organisation_id,b.shop_id,b.branch_id,b.business_date]
    );
    const prior=await maybeOne<any>(db,`
      SELECT actual_cash FROM salon_eod_closures
      WHERE shop_id=$1 AND branch_id=$2 AND business_date<$3
      ORDER BY business_date DESC LIMIT 1`,
      [b.shop_id,b.branch_id,b.business_date]
    );
    const opening=Number(prior?.actual_cash||0);
    const expected=opening+Number(p?.cash||0)-Number(e?.cash||0);
    const inserted=await db.query(`
      INSERT INTO salon_eod_closures(
        organisation_id,shop_id,branch_id,business_date,opening_cash,expected_cash,actual_cash,variance,
        momo_total,card_total,bank_total,total_sales,total_expenses,notes,closed_by,close_mode,review_status
      )
      VALUES($1,$2,$3,$4,$5,$6,$6,0,$7,$8,$9,$10,$11,
             'Automatically closed from system transactions. Physical cash count requires review.',
             NULL,'automatic','review_required')
      ON CONFLICT(shop_id,branch_id,business_date) DO NOTHING
      RETURNING id`,
      [b.organisation_id,b.shop_id,b.branch_id,b.business_date,opening,expected,p?.momo||0,p?.card||0,p?.bank||0,p?.total||0,e?.total||0]
    );
    if(inserted.rowCount)await audit(db,b.organisation_id,null,'finance.day_auto_closed','salon_eod',inserted.rows[0].id,b.shop_id,b.branch_id,{businessDate:b.business_date,expectedCash:expected});
  }
  return{autoClosed:eligible.rowCount??0};
}

async function dispatchOutbox(db:Db,config:ShopConfig,limit=50){
  const rows=await db.query(
    `SELECT * FROM shop_communication_outbox
     WHERE status='queued' AND scheduled_for<=now()
     ORDER BY created_at LIMIT $1`,[limit]
  );
  let sent=0;
  for(const row of rows.rows){
    let url:string|undefined,token:string|undefined,provider='';
    if(row.channel==='sms'){url=config.SMS_WEBHOOK_URL;token=config.SMS_WEBHOOK_TOKEN;provider='sms_webhook';}
    if(row.channel==='whatsapp'){url=config.WHATSAPP_API_URL;token=config.WHATSAPP_TOKEN;provider='whatsapp_api';}
    if(!url)continue;
    try{
      await db.query("UPDATE shop_communication_outbox SET status='sending',attempt_count=attempt_count+1 WHERE id=$1",[row.id]);
      const res=await fetch(url,{
        method:'POST',
        headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
        body:JSON.stringify({to:row.recipient,body:row.body,subject:row.subject,channel:row.channel,metadata:row.metadata}),
        signal:AbortSignal.timeout(15000)
      });
      const body=await res.json().catch(()=>null) as any;
      if(!res.ok)throw new Error(body?.message||body?.error||'Provider returned '+res.status);
      await db.query(
        `UPDATE shop_communication_outbox
         SET status='sent',provider=$1,provider_message_id=$2,sent_at=now(),last_error=NULL
         WHERE id=$3`,
        [provider,String(body?.id||body?.messageId||body?.reference||''),row.id]
      );
      sent++;
    }catch(e:any){
      await db.query(
        `UPDATE shop_communication_outbox
         SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'queued' END,last_error=$1
         WHERE id=$2`,
        [String(e?.message||e).slice(0,1000),row.id]
      );
    }
  }
  return{processed:rows.rowCount??0,sent};
}

export async function runShopAutomations(db:Db,config:ShopConfig){
  const [customers,inventory,eod,outbox]=await Promise.all([
    syncCustomerLifecycle(db),
    syncInventoryAlerts(db),
    autoCloseEod(db),
    dispatchOutbox(db,config)
  ]);
  return{customers,inventory,eod,outbox};
}

async function customerContext(db:Db,request:FastifyRequest){
  const raw=cookieValue(request.headers.cookie,'rx_customer_session');
  if(!raw){const e:any=new Error('Customer sign-in required');e.statusCode=401;throw e;}
  const tokenHash=sha(raw);
  const row=await maybeOne<any>(db,`
    SELECT s.id session_id,s.expires_at,a.id account_id,a.shop_id,a.customer_id,
           c.organisation_id,c.branch_id,c.customer_no,c.name,c.phone,c.email,c.status,c.loyalty_points,c.last_visit_at,
           sh.name shop_name,sh.slug,sh.public_slug,sh.currency,sh.phone shop_phone,sh.email shop_email,sh.address shop_address
    FROM shop_customer_sessions s
    JOIN shop_customer_portal_accounts a ON a.id=s.account_id AND a.status='active'
    JOIN shop_customers c ON c.id=a.customer_id
    JOIN shops sh ON sh.id=a.shop_id AND sh.status='active'
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
    LIMIT 1`,[tokenHash]);
  if(!row){const e:any=new Error('Customer session has expired');e.statusCode=401;throw e;}
  await db.query('UPDATE shop_customer_sessions SET last_used_at=now() WHERE id=$1',[row.session_id]);
  return row;
}

export async function createApprovalRequest(
  db:Db,
  input:{organisationId:string;shopId?:string|null;branchId?:string|null;actionKey:string;targetType:string;targetId?:string|null;title:string;reason?:string|null;payload:any;requestedBy:string}
){
  const r=await db.query(`
    INSERT INTO shop_approval_requests(
      organisation_id,shop_id,branch_id,action_key,target_type,target_id,request_title,reason,payload,status,requested_by
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending',$10)
    RETURNING *`,
    [input.organisationId,input.shopId||null,input.branchId||null,input.actionKey,input.targetType,input.targetId||null,input.title,input.reason||null,JSON.stringify(input.payload||{}),input.requestedBy]
  );
  return r.rows[0];
}

async function applyApprovedRequest(db:Db,request:any){
  const p=request.payload||{};
  if(request.action_key==='service.update'){
    await db.query(
      `UPDATE shop_services SET
       name=coalesce($1,name),category=coalesce($2,category),description=coalesce($3,description),
       price=coalesce($4,price),duration_minutes=coalesce($5,duration_minutes),
       deposit_percent=coalesce($6,deposit_percent),active=coalesce($7,active)
       WHERE id=$8 AND organisation_id=$9`,
      [p.name??null,p.category??null,p.description??null,p.price??null,p.durationMinutes??null,p.depositPercent??null,p.active??null,request.target_id,request.organisation_id]
    );
  }else if(request.action_key==='service.delete'){
    await db.query('UPDATE shop_services SET active=false WHERE id=$1 AND organisation_id=$2',[request.target_id,request.organisation_id]);
  }else if(request.action_key==='access.role_change'){
    await db.query(
      `INSERT INTO shop_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status`,
      [request.organisation_id,request.target_id,p.role,p.status||'active']
    );
  }
}

export async function registerEnterpriseShopRoutes(app:FastifyInstance,{db,config}:{db:Db;config:ShopConfig}){
  app.get('/api/enterprise/summary',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    await Promise.all([syncCustomerLifecycle(db,a.core.organisation_id),syncInventoryAlerts(db,a.core.organisation_id)]);
    const r=await db.query(`
      SELECT
       (SELECT count(*)::int FROM shop_customers WHERE organisation_id=$1 AND status='inactive') inactive_customers,
       (SELECT count(*)::int FROM shop_inventory_alerts WHERE organisation_id=$1 AND status='open') inventory_alerts,
       (SELECT count(*)::int FROM shop_approval_requests WHERE organisation_id=$1 AND status='pending') pending_approvals,
       (SELECT count(*)::int FROM shop_tickets WHERE organisation_id=$1 AND status NOT IN('resolved','closed','cancelled')) open_tickets,
       (SELECT count(*)::int FROM shop_conversations WHERE organisation_id=$1 AND status<>'closed') open_conversations,
       (SELECT count(*)::int FROM salon_eod_closures WHERE organisation_id=$1 AND review_status='review_required') eod_review_required
    `,[a.core.organisation_id]);
    return r.rows[0];
  });

  app.post('/api/customers/lifecycle/refresh',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'retention.manage');
    return syncCustomerLifecycle(db,a.core.organisation_id);
  });

  app.get('/api/customers/inactive',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'customers.read');
    const shopId=(req.query as any)?.shopId;
    const r=await db.query(`
      SELECT c.*,extract(day from now()-coalesce(c.last_visit_at,c.created_at))::int days_since_visit
      FROM shop_customers c
      WHERE c.organisation_id=$1 AND c.status='inactive'
        AND ($2::uuid IS NULL OR c.shop_id=$2)
      ORDER BY coalesce(c.last_visit_at,c.created_at) ASC`,[a.core.organisation_id,shopId||null]);
    return r.rows;
  });

  app.get('/api/customers/:id/360',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'customers.read');
    const id=uuid.parse((req.params as any).id);
    const customer=await maybeOne<any>(db,`
      SELECT c.*,s.name shop_name,b.name branch_name,p.preferred_staff_id,p.preferred_service_id,
             p.haircut_notes,p.allergies_notes,p.visit_count preference_visit_count,
             st.full_name preferred_barber,sv.name preferred_service
      FROM shop_customers c
      JOIN shops s ON s.id=c.shop_id
      LEFT JOIN shop_branches b ON b.id=c.branch_id
      LEFT JOIN salon_customer_preferences p ON p.customer_id=c.id AND p.shop_id=c.shop_id
      LEFT JOIN salon_staff st ON st.id=p.preferred_staff_id
      LEFT JOIN shop_services sv ON sv.id=p.preferred_service_id
      WHERE c.id=$1 AND c.organisation_id=$2`,[id,a.core.organisation_id]);
    if(!customer)return reply.code(404).send({error:{message:'Customer not found'}});
    const [visits,orders,payments,discounts,tickets,conversations]=await Promise.all([
      db.query(`SELECT b.*,s.name service_name,st.full_name barber_name
                FROM shop_bookings b LEFT JOIN shop_services s ON s.id=b.service_id
                LEFT JOIN salon_staff st ON st.id=b.salon_staff_id
                WHERE b.customer_id=$1 ORDER BY b.booked_for DESC LIMIT 100`,[id]),
      db.query('SELECT * FROM shop_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[id]),
      db.query('SELECT * FROM shop_payments WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[id]),
      db.query('SELECT * FROM shop_customer_discounts WHERE customer_id=$1 ORDER BY created_at DESC',[id]),
      db.query('SELECT * FROM shop_tickets WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[id]),
      db.query('SELECT * FROM shop_conversations WHERE customer_id=$1 ORDER BY last_message_at DESC LIMIT 50',[id])
    ]);
    const completed=visits.rows.filter((v:any)=>v.status==='completed');
    const spend=payments.rows.filter((p:any)=>p.status==='successful').reduce((s:number,p:any)=>s+Number(p.amount||0),0);
    return{
      customer,
      metrics:{
        visits:completed.length,
        lifetimeSpend:spend,
        averageSpend:completed.length?spend/completed.length:0,
        lastVisit:customer.last_visit_at||completed[0]?.service_completed_at||completed[0]?.booked_for||null,
        upcomingAppointments:visits.rows.filter((v:any)=>['booked','queued','checked_in'].includes(v.status)&&new Date(v.booked_for)>=new Date()).length,
        loyaltyPoints:Number(customer.loyalty_points||0),
        openTickets:tickets.rows.filter((t:any)=>!['resolved','closed','cancelled'].includes(t.status)).length
      },
      visits:visits.rows,orders:orders.rows,payments:payments.rows,discounts:discounts.rows,tickets:tickets.rows,conversations:conversations.rows
    };
  });

  async function queueCommunication(a:any,customer:any,channel:'sms'|'whatsapp'|'email',body:string,subject?:string){
    const recipient=channel==='email'?customer.email:customer.phone;
    if(!recipient)throw Object.assign(new Error('Customer does not have a '+(channel==='email'?'valid email':'phone number')),{statusCode:400});
    const r=await db.query(
      `INSERT INTO shop_communication_outbox(
        organisation_id,shop_id,branch_id,customer_id,channel,recipient,subject,body,created_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [a.core.organisation_id,customer.shop_id,customer.branch_id,customer.id,channel,recipient,subject||null,body,a.core.id]
    );
    await dispatchOutbox(db,config,10);
    return maybeOne<any>(db,'SELECT * FROM shop_communication_outbox WHERE id=$1',[r.rows[0].id]);
  }

  app.post('/api/customers/:id/communications',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'communications.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({channel:z.enum(['sms','whatsapp','email']),body:z.string().trim().min(2).max(4000),subject:z.string().max(300).optional()}).parse(req.body);
    const customer=await maybeOne<any>(db,'SELECT * FROM shop_customers WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!customer)return reply.code(404).send({error:{message:'Customer not found'}});
    const out=await queueCommunication(a,customer,b.channel,b.body,b.subject);
    await audit(db,a.core.organisation_id,a.core.id,'customer.message_queued','customer',id,customer.shop_id,customer.branch_id,{channel:b.channel,outboxId:out?.id});
    return reply.code(201).send(out);
  });

  app.post('/api/customers/inactive/communications',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'retention.manage');
    const b=z.object({shopId:uuid,channel:z.enum(['sms','whatsapp','email']),body:z.string().trim().min(2).max(4000),subject:z.string().max(300).optional()}).parse(req.body);
    await syncCustomerLifecycle(db,a.core.organisation_id);
    const customers=(await db.query('SELECT * FROM shop_customers WHERE organisation_id=$1 AND shop_id=$2 AND status=\'inactive\'',[a.core.organisation_id,b.shopId])).rows;
    let queued=0,skipped=0;
    for(const customer of customers){
      try{await queueCommunication(a,customer,b.channel,b.body,b.subject);queued++;}catch{skipped++;}
    }
    await audit(db,a.core.organisation_id,a.core.id,'customer.inactive_campaign','shop',b.shopId,b.shopId,null,{channel:b.channel,queued,skipped});
    return{queued,skipped,total:customers.length};
  });

  app.get('/api/conversations',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'communications.manage');
    const shopId=(req.query as any)?.shopId||null;
    const r=await db.query(`
      SELECT c.*,cu.name customer_name,cu.phone customer_phone,
             (SELECT body FROM shop_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message
      FROM shop_conversations c
      LEFT JOIN shop_customers cu ON cu.id=c.customer_id
      WHERE c.organisation_id=$1 AND ($2::uuid IS NULL OR c.shop_id=$2)
      ORDER BY c.last_message_at DESC LIMIT 250`,[a.core.organisation_id,shopId]);
    return r.rows;
  });

  app.get('/api/conversations/:id/messages',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'communications.manage');
    const id=uuid.parse((req.params as any).id);
    const owns=await maybeOne<any>(db,'SELECT id FROM shop_conversations WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!owns)return reply.code(404).send({error:{message:'Conversation not found'}});
    return (await db.query('SELECT * FROM shop_messages WHERE conversation_id=$1 ORDER BY created_at',[id])).rows;
  });

  app.post('/api/conversations/:id/messages',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'communications.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({body:z.string().trim().min(1).max(5000),channel:z.enum(['in_app','whatsapp','sms','email']).default('in_app')}).parse(req.body);
    const conv=await maybeOne<any>(db,`
      SELECT c.*,cu.phone,cu.email FROM shop_conversations c
      LEFT JOIN shop_customers cu ON cu.id=c.customer_id
      WHERE c.id=$1 AND c.organisation_id=$2`,[id,a.core.organisation_id]);
    if(!conv)return reply.code(404).send({error:{message:'Conversation not found'}});
    const m=await db.query(
      `INSERT INTO shop_messages(conversation_id,sender_type,sender_id,channel,body,delivery_status)
       VALUES($1,'staff',$2,$3,$4,$5) RETURNING *`,
      [id,a.core.id,b.channel,b.body,b.channel==='in_app'?'sent':'queued']
    );
    await db.query('UPDATE shop_conversations SET last_message_at=now(),status=\'open\' WHERE id=$1',[id]);
    if(b.channel!=='in_app'&&conv.customer_id){
      await queueCommunication(a,{id:conv.customer_id,shop_id:conv.shop_id,branch_id:conv.branch_id,phone:conv.phone,email:conv.email},b.channel as any,b.body);
    }
    return reply.code(201).send(m.rows[0]);
  });

  app.get('/api/inventory/alerts',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'inventory.read');
    await syncInventoryAlerts(db,a.core.organisation_id);
    const shopId=(req.query as any)?.shopId||null;
    const r=await db.query(`
      SELECT a.*,p.name product_name,p.stock_quantity,p.reorder_level,sa.name asset_name
      FROM shop_inventory_alerts a
      LEFT JOIN shop_products p ON p.id=a.product_id
      LEFT JOIN shop_assets sa ON sa.id=a.asset_id
      WHERE a.organisation_id=$1 AND ($2::uuid IS NULL OR a.shop_id=$2)
      ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,a.created_at DESC`,
      [a.core.organisation_id,shopId]);
    return r.rows;
  });

  app.patch('/api/inventory/alerts/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'inventory.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({status:z.enum(['acknowledged','resolved'])}).parse(req.body);
    const r=await db.query(
      `UPDATE shop_inventory_alerts SET status=$1,
       acknowledged_at=CASE WHEN $1='acknowledged' THEN now() ELSE acknowledged_at END,
       resolved_at=CASE WHEN $1='resolved' THEN now() ELSE resolved_at END
       WHERE id=$2 AND organisation_id=$3 RETURNING *`,
      [b.status,id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(404).send({error:{message:'Inventory alert not found'}});
    return r.rows[0];
  });

  app.get('/api/assets',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'inventory.read');
    const shopId=(req.query as any)?.shopId||null;
    return (await db.query(`
      SELECT a.*,st.full_name assigned_staff_name
      FROM shop_assets a LEFT JOIN salon_staff st ON st.id=a.assigned_staff_id
      WHERE a.organisation_id=$1 AND ($2::uuid IS NULL OR a.shop_id=$2)
      ORDER BY a.status,a.name`,[a.core.organisation_id,shopId])).rows;
  });

  app.post('/api/assets',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'assets.manage');
    const b=z.object({
      shopId:uuid,branchId:uuid.optional(),assetNo:z.string().trim().min(2).max(100),name:z.string().trim().min(2).max(200),
      category:z.string().trim().min(2).max(100),brand:z.string().max(100).optional(),model:z.string().max(100).optional(),
      serialNumber:z.string().max(150).optional(),purchaseDate:z.string().optional(),purchaseCost:money.default(0),
      currentValue:money.optional(),condition:z.string().max(80).default('good'),assignedStaffId:uuid.optional(),
      nextServiceDate:z.string().optional(),warrantyExpiry:z.string().optional(),notes:z.string().max(2000).optional()
    }).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_assets(
        organisation_id,shop_id,branch_id,asset_no,name,category,brand,model,serial_number,purchase_date,
        purchase_cost,current_value,condition,assigned_staff_id,next_service_date,warranty_expiry,notes
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.assetNo,b.name,b.category,b.brand||null,b.model||null,b.serialNumber||null,b.purchaseDate||null,b.purchaseCost,b.currentValue??null,b.condition,b.assignedStaffId||null,b.nextServiceDate||null,b.warrantyExpiry||null,b.notes||null]
    );
    await syncInventoryAlerts(db,a.core.organisation_id);
    return reply.code(201).send(r.rows[0]);
  });

  app.patch('/api/assets/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'assets.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({
      name:z.string().trim().min(2).max(200).optional(),category:z.string().max(100).optional(),condition:z.string().max(80).optional(),
      status:z.enum(['active','maintenance','retired','lost','disposed']).optional(),assignedStaffId:uuid.nullable().optional(),
      nextServiceDate:z.string().nullable().optional(),currentValue:money.nullable().optional(),notes:z.string().max(2000).nullable().optional()
    }).parse(req.body);
    const r=await db.query(`
      UPDATE shop_assets SET
       name=coalesce($1,name),category=coalesce($2,category),condition=coalesce($3,condition),status=coalesce($4,status),
       assigned_staff_id=CASE WHEN $5 THEN $6 ELSE assigned_staff_id END,
       next_service_date=CASE WHEN $7 THEN $8::date ELSE next_service_date END,
       current_value=CASE WHEN $9 THEN $10 ELSE current_value END,
       notes=CASE WHEN $11 THEN $12 ELSE notes END,updated_at=now()
      WHERE id=$13 AND organisation_id=$14 RETURNING *`,
      [b.name??null,b.category??null,b.condition??null,b.status??null,Object.prototype.hasOwnProperty.call(b,'assignedStaffId'),b.assignedStaffId??null,Object.prototype.hasOwnProperty.call(b,'nextServiceDate'),b.nextServiceDate??null,Object.prototype.hasOwnProperty.call(b,'currentValue'),b.currentValue??null,Object.prototype.hasOwnProperty.call(b,'notes'),b.notes??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Asset not found'}});
    return r.rows[0];
  });

  app.post('/api/assets/:id/maintenance',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'assets.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({maintenanceType:z.string().min(2),description:z.string().optional(),cost:money.default(0),vendorName:z.string().optional(),nextServiceDate:z.string().optional()}).parse(req.body);
    const asset=await maybeOne<any>(db,'SELECT * FROM shop_assets WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!asset)return reply.code(404).send({error:{message:'Asset not found'}});
    const r=await db.query(`
      INSERT INTO shop_asset_maintenance(organisation_id,asset_id,maintenance_type,description,cost,vendor_name,next_service_date,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.core.organisation_id,id,b.maintenanceType,b.description||null,b.cost,b.vendorName||null,b.nextServiceDate||null,a.core.id]
    );
    if(b.nextServiceDate)await db.query('UPDATE shop_assets SET next_service_date=$1,updated_at=now() WHERE id=$2',[b.nextServiceDate,id]);
    return reply.code(201).send(r.rows[0]);
  });

  app.get('/api/approvals',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'approvals.review');
    const status=String((req.query as any)?.status||'pending');
    const r=await db.query(`
      SELECT ar.*,
       (SELECT count(*)::int FROM shop_approval_actions aa WHERE aa.request_id=ar.id AND aa.action='approve') approvals,
       (SELECT count(*)::int FROM shop_approval_actions aa WHERE aa.request_id=ar.id AND aa.action='reject') rejections
      FROM shop_approval_requests ar
      WHERE ar.organisation_id=$1 AND ($2='all' OR ar.status=$2)
      ORDER BY ar.requested_at DESC LIMIT 250`,[a.core.organisation_id,status]);
    return r.rows;
  });

  app.post('/api/approvals/:id/review',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'approvals.review');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({action:z.enum(['approve','reject']),comment:z.string().max(1500).optional()}).parse(req.body);
    const request=await maybeOne<any>(db,'SELECT * FROM shop_approval_requests WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!request)return reply.code(404).send({error:{message:'Approval request not found'}});
    if(request.status!=='pending')return reply.code(409).send({error:{message:'This request is no longer pending'}});
    const policy=await maybeOne<any>(db,`
      SELECT * FROM shop_approval_policies
      WHERE organisation_id=$1 AND action_key=$2 AND (shop_id=$3 OR shop_id IS NULL)
      ORDER BY shop_id NULLS LAST LIMIT 1`,[a.core.organisation_id,request.action_key,request.shop_id]);
    const approverRoles=policy?.approver_roles||['shop_admin','manager'];
    if(a.role!=='shop_admin'&&!approverRoles.includes(a.role))return reply.code(403).send({error:{message:'Your Shop role cannot review this request'}});
    if(policy?.self_approval_allowed===false&&request.requested_by===a.core.id)return reply.code(409).send({error:{message:'The requester cannot approve their own controlled change'}});
    await db.query(
      `INSERT INTO shop_approval_actions(request_id,action,actor_os_user_id,comment)
       VALUES($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,[id,b.action,a.core.id,b.comment||null]);
    if(b.action==='reject'){
      await db.query("UPDATE shop_approval_requests SET status='rejected',resolved_at=now() WHERE id=$1",[id]);
      await audit(db,a.core.organisation_id,a.core.id,'approval.rejected','approval',id,request.shop_id,request.branch_id,{actionKey:request.action_key});
      return{status:'rejected'};
    }
    const votes=await db.query("SELECT count(*)::int c FROM shop_approval_actions WHERE request_id=$1 AND action='approve'",[id]);
    const needed=Number(policy?.minimum_approvals||1);
    if(Number(votes.rows[0]?.c||0)>=needed){
      try{
        await applyApprovedRequest(db,request);
        await db.query("UPDATE shop_approval_requests SET status='applied',resolved_at=now(),applied_at=now() WHERE id=$1",[id]);
        await audit(db,a.core.organisation_id,a.core.id,'approval.applied','approval',id,request.shop_id,request.branch_id,{actionKey:request.action_key});
        return{status:'applied'};
      }catch(e:any){
        await db.query("UPDATE shop_approval_requests SET status='failed',resolved_at=now(),apply_error=$2 WHERE id=$1",[id,String(e?.message||e).slice(0,1500)]);
        throw e;
      }
    }
    return{status:'pending',approvals:Number(votes.rows[0]?.c||0),required:needed};
  });

  app.get('/api/access/roles',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(!['shop_admin','manager','auditor'].includes(a.role))return reply.code(403).send({error:{message:'Access management permission is required'}});
    await ensureDefaultRoles(db,a.core.organisation_id);
    const [roles,capabilities,grants]=await Promise.all([
      db.query('SELECT * FROM shop_roles WHERE organisation_id=$1 ORDER BY is_system DESC,name',[a.core.organisation_id]),
      db.query('SELECT * FROM shop_capabilities ORDER BY module,sort_order,name'),
      db.query('SELECT * FROM shop_role_capabilities WHERE organisation_id=$1',[a.core.organisation_id])
    ]);
    return{roles:roles.rows,capabilities:capabilities.rows,grants:grants.rows};
  });

  app.post('/api/access/roles',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'roles.manage');
    const b=z.object({key:z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,40}$/),name:z.string().trim().min(2).max(100),description:z.string().max(500).optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_roles(organisation_id,key,name,description,is_system,is_active)
       VALUES($1,$2,$3,$4,false,true) RETURNING *`,
      [a.core.organisation_id,b.key,b.name,b.description||null]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.put('/api/access/roles/:role/capabilities',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'roles.manage');
    const role=z.string().min(2).max(60).parse((req.params as any).role);
    const b=z.object({capabilities:z.array(z.string().min(2)).max(200)}).parse(req.body);
    const valid=(await db.query('SELECT key FROM shop_capabilities')).rows.map((x:any)=>x.key);
    const selected=new Set(b.capabilities.filter(x=>valid.includes(x)));
    await tx(db,async c=>{
      await c.query('DELETE FROM shop_role_capabilities WHERE organisation_id=$1 AND role=$2',[a.core.organisation_id,role]);
      for(const key of valid){
        await c.query(
          `INSERT INTO shop_role_capabilities(organisation_id,role,capability_key,allowed)
           VALUES($1,$2,$3,$4)`,
          [a.core.organisation_id,role,key,selected.has(key)]
        );
      }
    });
    await audit(db,a.core.organisation_id,a.core.id,'access.role_capabilities_changed','role',null,null,null,{role,capabilities:[...selected]});
    return{updated:true,role,capabilities:[...selected]};
  });

  app.get('/api/finance/overview',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.read');
    const shopId=uuid.parse(String((req.query as any)?.shopId||''));
    await ensureFinanceDefaults(db,a.core.organisation_id,shopId);
    const params=[a.core.organisation_id,shopId];
    const [accounts,journals,vendors,budgets,taxTypes,taxObligations]=await Promise.all([
      db.query(`SELECT a.*,coalesce(x.debit,0) debit,coalesce(x.credit,0) credit,
                CASE WHEN a.account_type IN('asset','expense') THEN a.opening_balance+coalesce(x.debit,0)-coalesce(x.credit,0)
                     ELSE a.opening_balance+coalesce(x.credit,0)-coalesce(x.debit,0) END balance
                FROM shop_finance_accounts a
                LEFT JOIN (SELECT account_id,sum(debit) debit,sum(credit) credit FROM shop_finance_journal_lines GROUP BY account_id) x ON x.account_id=a.id
                WHERE a.organisation_id=$1 AND a.shop_id=$2 ORDER BY a.code`,params),
      db.query(`SELECT j.*,coalesce(x.total_debit,0) total_debit,coalesce(x.total_credit,0) total_credit
                FROM shop_finance_journal_entries j
                LEFT JOIN (SELECT journal_entry_id,sum(debit) total_debit,sum(credit) total_credit FROM shop_finance_journal_lines GROUP BY journal_entry_id) x ON x.journal_entry_id=j.id
                WHERE j.organisation_id=$1 AND j.shop_id=$2 ORDER BY j.entry_date DESC,j.created_at DESC LIMIT 200`,params),
      db.query('SELECT * FROM shop_finance_vendors WHERE organisation_id=$1 AND shop_id=$2 ORDER BY name',params),
      db.query(`SELECT b.*,a.code account_code,a.name account_name FROM shop_finance_budgets b JOIN shop_finance_accounts a ON a.id=b.account_id
                WHERE b.organisation_id=$1 AND b.shop_id=$2 ORDER BY b.period_start DESC`,params),
      db.query('SELECT * FROM shop_finance_tax_types WHERE organisation_id=$1 AND shop_id=$2 ORDER BY code',params),
      db.query(`SELECT o.*,t.code tax_code,t.name tax_name FROM shop_finance_tax_obligations o JOIN shop_finance_tax_types t ON t.id=o.tax_type_id
                WHERE o.organisation_id=$1 AND o.shop_id=$2 ORDER BY o.due_date NULLS LAST,o.created_at DESC`,params)
    ]);
    const legacy=await maybeOne<any>(db,`
      SELECT
       coalesce((SELECT sum(amount) FROM shop_payments WHERE organisation_id=$1 AND shop_id=$2 AND status='successful'),0) receipts,
       coalesce((SELECT sum(amount) FROM shop_expenses WHERE organisation_id=$1 AND shop_id=$2),0) expenses,
       coalesce((SELECT sum(balance) FROM shop_orders WHERE organisation_id=$1 AND shop_id=$2 AND balance>0),0) receivables`,params);
    return{accounts:accounts.rows,journals:journals.rows,vendors:vendors.rows,budgets:budgets.rows,taxTypes:taxTypes.rows,taxObligations:taxObligations.rows,summary:legacy};
  });

  app.post('/api/finance/accounts',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,code:z.string().trim().min(2).max(20),name:z.string().trim().min(2).max(160),accountType:z.enum(['asset','liability','equity','income','expense']),subtype:z.string().max(80).optional(),isCashAccount:z.boolean().default(false),openingBalance:z.coerce.number().finite().default(0)}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_finance_accounts(organisation_id,shop_id,code,name,account_type,subtype,is_cash_account,opening_balance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.code,b.name,b.accountType,b.subtype||null,b.isCashAccount,b.openingBalance]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/finance/vendors',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,name:z.string().trim().min(2).max(200),taxId:z.string().max(100).optional(),phone:z.string().max(60).optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().max(500).optional(),contactPerson:z.string().max(160).optional()}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_finance_vendors(organisation_id,shop_id,name,tax_id,phone,email,address,contact_person)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.name,b.taxId||null,b.phone||null,b.email||null,b.address||null,b.contactPerson||null]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/finance/journals',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({
      shopId:uuid,branchId:uuid.optional(),entryDate:z.string().optional(),description:z.string().trim().min(2).max(1000),reference:z.string().max(150).optional(),
      lines:z.array(z.object({accountId:uuid,description:z.string().max(500).optional(),debit:money.default(0),credit:money.default(0)})).min(2)
    }).parse(req.body);
    const debit=b.lines.reduce((s,l)=>s+l.debit,0),credit=b.lines.reduce((s,l)=>s+l.credit,0);
    if(Math.abs(debit-credit)>0.005||debit<=0)return reply.code(400).send({error:{message:'Journal debits and credits must balance and be greater than zero'}});
    const entry=await tx(db,async c=>{
      const j=await c.query(`
        INSERT INTO shop_finance_journal_entries(organisation_id,shop_id,branch_id,entry_no,entry_date,description,reference,status,created_by,posted_at)
        VALUES($1,$2,$3,$4,coalesce($5::date,CURRENT_DATE),$6,$7,'posted',$8,now()) RETURNING *`,
        [a.core.organisation_id,b.shopId,b.branchId||null,code('JRN'),b.entryDate||null,b.description,b.reference||null,a.core.id]
      );
      for(const l of b.lines){
        const account=await maybeOne<any>(c,'SELECT * FROM shop_finance_accounts WHERE id=$1 AND organisation_id=$2 AND shop_id=$3 AND is_active=true',[l.accountId,a.core.organisation_id,b.shopId]);
        if(!account)throw Object.assign(new Error('Finance account not found or inactive'),{statusCode:400});
        if((l.debit>0)===(l.credit>0))throw Object.assign(new Error('Each journal line must contain either a debit or a credit'),{statusCode:400});
        await c.query('INSERT INTO shop_finance_journal_lines(journal_entry_id,account_id,description,debit,credit) VALUES($1,$2,$3,$4,$5)',[j.rows[0].id,l.accountId,l.description||null,l.debit,l.credit]);
        await c.query(`
          INSERT INTO shop_ledger_entries(organisation_id,shop_id,branch_id,entry_date,account_code,account_name,debit,credit,source_type,source_id,reference,description)
          VALUES($1,$2,$3,coalesce($4::date,CURRENT_DATE),$5,$6,$7,$8,'finance_journal',$9,$10,$11)`,
          [a.core.organisation_id,b.shopId,b.branchId||null,b.entryDate||null,account.code,account.name,l.debit,l.credit,j.rows[0].id,j.rows[0].entry_no,l.description||b.description]
        );
      }
      return j.rows[0];
    });
    return reply.code(201).send(entry);
  });

  app.post('/api/finance/budgets',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,accountId:uuid,periodStart:z.string(),periodEnd:z.string(),amount:money,notes:z.string().max(1000).optional()}).parse(req.body);
    if(b.periodEnd<b.periodStart)return reply.code(400).send({error:{message:'Budget end date cannot be before start date'}});
    const r=await db.query(`
      INSERT INTO shop_finance_budgets(organisation_id,shop_id,account_id,period_start,period_end,amount,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.accountId,b.periodStart,b.periodEnd,b.amount,b.notes||null,a.core.id]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/finance/tax-types',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,code:z.string().trim().min(2).max(30),name:z.string().trim().min(2).max(160),rate:z.coerce.number().min(0).max(100),authority:z.string().max(160).optional(),payableAccountId:uuid.optional()}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_finance_tax_types(organisation_id,shop_id,code,name,rate,authority,payable_account_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.code,b.name,b.rate,b.authority||null,b.payableAccountId||null]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/finance/tax-obligations',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,taxTypeId:uuid,periodStart:z.string(),periodEnd:z.string(),dueDate:z.string().optional(),amountDue:money,filingReference:z.string().max(150).optional()}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_finance_tax_obligations(organisation_id,shop_id,tax_type_id,period_start,period_end,due_date,amount_due,filing_reference,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.taxTypeId,b.periodStart,b.periodEnd,b.dueDate||null,b.amountDue,b.filingReference||null,a.core.id]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/finance/tax-obligations/:id/payments',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({amount:positive,paymentAccountId:uuid.optional(),authorityReference:z.string().max(150).optional(),receiptReference:z.string().max(150).optional()}).parse(req.body);
    const obligation=await maybeOne<any>(db,'SELECT * FROM shop_finance_tax_obligations WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!obligation)return reply.code(404).send({error:{message:'Tax obligation not found'}});
    const remaining=Math.max(0,Number(obligation.amount_due)-Number(obligation.amount_paid));
    if(b.amount>remaining+0.001)return reply.code(400).send({error:{message:'Tax payment exceeds the outstanding amount'}});
    const r=await db.query(`
      INSERT INTO shop_finance_tax_payments(organisation_id,obligation_id,amount,payment_account_id,authority_reference,receipt_reference,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.core.organisation_id,id,b.amount,b.paymentAccountId||null,b.authorityReference||null,b.receiptReference||null,a.core.id]
    );
    await db.query(`
      UPDATE shop_finance_tax_obligations SET amount_paid=amount_paid+$1,
       status=CASE WHEN amount_paid+$1>=amount_due THEN 'paid' ELSE 'part_paid' END,updated_at=now()
      WHERE id=$2`,[b.amount,id]);
    return reply.code(201).send(r.rows[0]);
  });

  app.get('/api/tickets',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'tickets.manage');
    const shopId=(req.query as any)?.shopId||null;
    return (await db.query(`
      SELECT t.*,c.name customer_name,c.phone customer_phone
      FROM shop_tickets t LEFT JOIN shop_customers c ON c.id=t.customer_id
      WHERE t.organisation_id=$1 AND ($2::uuid IS NULL OR t.shop_id=$2)
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.created_at DESC`,
      [a.core.organisation_id,shopId])).rows;
  });

  app.post('/api/tickets',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'tickets.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),customerId:uuid.optional(),category:z.string().max(100).default('general'),subject:z.string().trim().min(2).max(200),description:z.string().trim().min(2).max(4000),priority:z.enum(['low','normal','high','urgent']).default('normal')}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_tickets(organisation_id,shop_id,branch_id,customer_id,ticket_no,source,category,subject,description,priority,created_by)
      VALUES($1,$2,$3,$4,$5,'admin',$6,$7,$8,$9,$10) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.customerId||null,code('TKT'),b.category,b.subject,b.description,b.priority,a.core.id]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.patch('/api/tickets/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'tickets.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({status:z.enum(['open','in_progress','waiting_customer','resolved','closed','cancelled']).optional(),priority:z.enum(['low','normal','high','urgent']).optional(),assignedUserId:uuid.nullable().optional()}).parse(req.body);
    const r=await db.query(`
      UPDATE shop_tickets SET status=coalesce($1,status),priority=coalesce($2,priority),
       assigned_os_user_id=CASE WHEN $3 THEN $4 ELSE assigned_os_user_id END,
       resolved_at=CASE WHEN $1='resolved' THEN now() ELSE resolved_at END,updated_at=now()
      WHERE id=$5 AND organisation_id=$6 RETURNING *`,
      [b.status??null,b.priority??null,Object.prototype.hasOwnProperty.call(b,'assignedUserId'),b.assignedUserId??null,id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(404).send({error:{message:'Ticket not found'}});
    return r.rows[0];
  });

  app.get('/api/pos/devices',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'sales.manage');
    const shopId=(req.query as any)?.shopId||null;
    return (await db.query('SELECT * FROM shop_pos_devices WHERE organisation_id=$1 AND ($2::uuid IS NULL OR shop_id=$2) ORDER BY device_name',[a.core.organisation_id,shopId])).rows;
  });

  app.post('/api/pos/devices',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'settings.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),deviceName:z.string().min(2).max(160),deviceCode:z.string().min(2).max(100),provider:z.string().max(100).optional(),terminalId:z.string().max(150).optional(),capabilities:z.record(z.string(),z.any()).optional()}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_pos_devices(organisation_id,shop_id,branch_id,device_name,device_code,provider,terminal_id,capabilities)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.deviceName,b.deviceCode,b.provider||null,b.terminalId||null,JSON.stringify(b.capabilities||{})]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/pos/devices/:id/heartbeat',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'sales.manage');
    const id=uuid.parse((req.params as any).id);
    const r=await db.query("UPDATE shop_pos_devices SET status='online',last_seen_at=now() WHERE id=$1 AND organisation_id=$2 RETURNING *",[id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(404).send({error:{message:'POS device not found'}});
    return r.rows[0];
  });

  app.get('/api/automation/settings/:shopId',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'settings.manage');
    const shopId=uuid.parse((req.params as any).shopId);
    const branchId=(req.query as any)?.branchId||null;
    await ensureAutomationSetting(db,a.core.organisation_id,shopId,branchId);
    return maybeOne<any>(db,'SELECT * FROM shop_automation_settings WHERE shop_id=$1 AND branch_id IS NOT DISTINCT FROM $2::uuid',[shopId,branchId]);
  });

  app.put('/api/automation/settings/:shopId',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'settings.manage');
    const shopId=uuid.parse((req.params as any).shopId);
    const b=z.object({branchId:uuid.nullable().optional(),autoEodEnabled:z.boolean().optional(),autoEodTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),inactivityDays:z.coerce.number().int().min(30).max(730).optional(),welcomeDiscountPercent:z.coerce.number().min(0).max(100).optional(),reorderAlertsEnabled:z.boolean().optional()}).parse(req.body);
    const branchId=b.branchId||null;
    await ensureAutomationSetting(db,a.core.organisation_id,shopId,branchId);
    const r=await db.query(`
      UPDATE shop_automation_settings SET
       auto_eod_enabled=coalesce($1,auto_eod_enabled),
       auto_eod_time=coalesce($2::time,auto_eod_time),
       inactivity_days=coalesce($3,inactivity_days),
       welcome_discount_percent=coalesce($4,welcome_discount_percent),
       reorder_alerts_enabled=coalesce($5,reorder_alerts_enabled),
       updated_at=now()
      WHERE shop_id=$6 AND branch_id IS NOT DISTINCT FROM $7::uuid RETURNING *`,
      [b.autoEodEnabled??null,b.autoEodTime??null,b.inactivityDays??null,b.welcomeDiscountPercent??null,b.reorderAlertsEnabled??null,shopId,branchId]
    );
    return r.rows[0];
  });

  app.post('/api/customer-portal/:slug/register',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const b=z.object({name:z.string().trim().min(2).max(160),phone:z.string().trim().min(6).max(60),email:z.string().email(),password:z.string().min(8).max(128)}).parse(req.body);
    const shop=await maybeOne<any>(db,'SELECT * FROM shops WHERE public_slug=$1 AND status=\'active\'',[slug]);
    if(!shop)return reply.code(404).send({error:{message:'Salon not found'}});
    const existing=await maybeOne<any>(db,'SELECT id FROM shop_customer_portal_accounts WHERE shop_id=$1 AND lower(email)=lower($2)',[shop.id,b.email]);
    if(existing)return reply.code(409).send({error:{message:'A customer account already exists for this email'}});
    const result=await tx(db,async c=>{
      let customer=await maybeOne<any>(c,`
        SELECT * FROM shop_customers WHERE shop_id=$1 AND status IN('active','inactive')
          AND (lower(email)=lower($2) OR phone=$3)
        ORDER BY created_at LIMIT 1`,[shop.id,b.email,b.phone]);
      if(!customer){
        const branch=await maybeOne<any>(c,"SELECT id FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY created_at LIMIT 1",[shop.id]);
        const cr=await c.query(`
          INSERT INTO shop_customers(organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status,portal_registered_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'retail','active',now()) RETURNING *`,
          [shop.organisation_id,shop.id,branch?.id||null,code('CUS'),b.name,b.phone,b.email]);
        customer=cr.rows[0];
      }else{
        await c.query(`UPDATE shop_customers SET name=$1,phone=$2,email=$3,status='active',reactivation_at=CASE WHEN status='inactive' THEN now() ELSE reactivation_at END,portal_registered_at=coalesce(portal_registered_at,now()) WHERE id=$4`,[b.name,b.phone,b.email,customer.id]);
      }
      const account=(await c.query(`
        INSERT INTO shop_customer_portal_accounts(organisation_id,shop_id,customer_id,email,phone,password_hash)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [shop.organisation_id,shop.id,customer.id,b.email,b.phone,passwordHash(b.password)])).rows[0];
      await ensureAutomationSetting(c,shop.organisation_id,shop.id,null);
      const setting=await maybeOne<any>(c,'SELECT welcome_discount_percent FROM shop_automation_settings WHERE shop_id=$1 AND branch_id IS NULL',[shop.id]);
      const pct=Number(setting?.welcome_discount_percent??10);
      if(pct>0)await c.query(`
        INSERT INTO shop_customer_discounts(organisation_id,shop_id,customer_id,code,discount_type,discount_value,reason,expires_at)
        VALUES($1,$2,$3,$4,'percent',$5,'Customer portal registration',now()+interval '90 days')`,
        [shop.organisation_id,shop.id,customer.id,code('WELCOME'),pct]);
      return{account,customer,discountPercent:pct};
    });
    const token=randomBytes(36).toString('base64url');
    await db.query(`
      INSERT INTO shop_customer_sessions(account_id,token_hash,user_agent,ip_address,expires_at)
      VALUES($1,$2,$3,$4,now()+($5||' days')::interval)`,
      [result.account.id,sha(token),String(req.headers['user-agent']||''),req.ip,String(config.CUSTOMER_PORTAL_SESSION_DAYS)]
    );
    reply.header('Set-Cookie',customerCookie(token,config.CUSTOMER_PORTAL_SESSION_DAYS*86400,config.NODE_ENV==='production'));
    return reply.code(201).send({ok:true,customer:{id:result.customer.id,name:b.name},welcomeDiscountPercent:result.discountPercent});
  });

  app.post('/api/customer-portal/:slug/login',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const b=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);
    const account=await maybeOne<any>(db,`
      SELECT a.*,s.public_slug,c.name,c.status customer_status
      FROM shop_customer_portal_accounts a
      JOIN shops s ON s.id=a.shop_id
      JOIN shop_customers c ON c.id=a.customer_id
      WHERE s.public_slug=$1 AND lower(a.email)=lower($2) AND a.status='active'`,[slug,b.email]);
    if(!account||!passwordOk(b.password,account.password_hash))return reply.code(401).send({error:{message:'Invalid email or password'}});
    const token=randomBytes(36).toString('base64url');
    await db.query(`
      INSERT INTO shop_customer_sessions(account_id,token_hash,user_agent,ip_address,expires_at)
      VALUES($1,$2,$3,$4,now()+($5||' days')::interval)`,
      [account.id,sha(token),String(req.headers['user-agent']||''),req.ip,String(config.CUSTOMER_PORTAL_SESSION_DAYS)]
    );
    await db.query('UPDATE shop_customer_portal_accounts SET last_login_at=now() WHERE id=$1',[account.id]);
    reply.header('Set-Cookie',customerCookie(token,config.CUSTOMER_PORTAL_SESSION_DAYS*86400,config.NODE_ENV==='production'));
    return{ok:true,name:account.name};
  });

  app.post('/api/customer-portal/logout',async(req,reply)=>{
    const raw=cookieValue(req.headers.cookie,'rx_customer_session');
    if(raw)await db.query('UPDATE shop_customer_sessions SET revoked_at=now() WHERE token_hash=$1',[sha(raw)]);
    reply.header('Set-Cookie',customerCookie('',0,config.NODE_ENV==='production'));
    return{ok:true};
  });

  app.get('/api/customer-portal/dashboard',async(req,reply)=>{
    const c=await customerContext(db,req);
    const [services,appointments,orders,payments,discounts,tickets,conversations,preferences]=await Promise.all([
      db.query('SELECT id,name,category,description,price,duration_minutes,deposit_percent FROM shop_services WHERE shop_id=$1 AND active=true ORDER BY category,name',[c.shop_id]),
      db.query(`SELECT b.*,s.name service_name,st.full_name barber_name
                FROM shop_bookings b LEFT JOIN shop_services s ON s.id=b.service_id LEFT JOIN salon_staff st ON st.id=b.salon_staff_id
                WHERE b.customer_id=$1 ORDER BY b.booked_for DESC LIMIT 100`,[c.customer_id]),
      db.query('SELECT * FROM shop_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[c.customer_id]),
      db.query('SELECT * FROM shop_payments WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[c.customer_id]),
      db.query("SELECT * FROM shop_customer_discounts WHERE customer_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC",[c.customer_id]),
      db.query('SELECT * FROM shop_tickets WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[c.customer_id]),
      db.query('SELECT * FROM shop_conversations WHERE customer_id=$1 ORDER BY last_message_at DESC LIMIT 50',[c.customer_id]),
      db.query(`SELECT p.*,st.full_name preferred_barber,sv.name preferred_service
                FROM salon_customer_preferences p LEFT JOIN salon_staff st ON st.id=p.preferred_staff_id LEFT JOIN shop_services sv ON sv.id=p.preferred_service_id
                WHERE p.customer_id=$1 AND p.shop_id=$2`,[c.customer_id,c.shop_id])
    ]);
    const visits=appointments.rows.filter((x:any)=>x.status==='completed');
    const spend=payments.rows.filter((x:any)=>x.status==='successful').reduce((s:number,x:any)=>s+Number(x.amount||0),0);
    return{
      customer:c,
      metrics:{visits:visits.length,lifetimeSpend:spend,loyaltyPoints:Number(c.loyalty_points||0),lastVisit:c.last_visit_at,openTickets:tickets.rows.filter((x:any)=>!['resolved','closed','cancelled'].includes(x.status)).length},
      services:services.rows,appointments:appointments.rows,orders:orders.rows,payments:payments.rows,discounts:discounts.rows,tickets:tickets.rows,conversations:conversations.rows,preferences:preferences.rows[0]||null
    };
  });

  app.post('/api/customer-portal/appointments',async(req,reply)=>{
    const c=await customerContext(db,req);
    const b=z.object({branchId:uuid.optional(),serviceId:uuid,staffId:uuid.optional(),bookedFor:z.coerce.date(),notes:z.string().max(2000).optional()}).parse(req.body);
    let branchId=b.branchId||c.branch_id;
    if(!branchId){
      const branch=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY created_at LIMIT 1",[c.shop_id]);
      branchId=branch?.id||null;
    }
    if(!branchId)return reply.code(409).send({error:{message:'No active branch is available'}});
    await assertSalonBookingAvailability(db,{organisationId:c.organisation_id,shopId:c.shop_id,branchId,bookedFor:b.bookedFor,serviceId:b.serviceId,staffId:b.staffId||null});
    const r=await db.query(`
      INSERT INTO shop_bookings(organisation_id,shop_id,branch_id,service_id,customer_id,customer_name,phone,email,booked_for,notes,status,salon_staff_id,appointment_type,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'booked',$11,'appointment','customer_portal') RETURNING *`,
      [c.organisation_id,c.shop_id,branchId,b.serviceId,c.customer_id,c.name,c.phone,c.email,b.bookedFor,b.notes||null,b.staffId||null]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.get('/api/customer-portal/messages',async(req,reply)=>{
    const c=await customerContext(db,req);
    let conv=await maybeOne<any>(db,"SELECT * FROM shop_conversations WHERE customer_id=$1 AND shop_id=$2 AND channel='in_app' AND status<>'closed' ORDER BY created_at LIMIT 1",[c.customer_id,c.shop_id]);
    if(!conv){
      conv=(await db.query(`INSERT INTO shop_conversations(organisation_id,shop_id,branch_id,customer_id,channel,subject) VALUES($1,$2,$3,$4,'in_app','Customer chat') RETURNING *`,[c.organisation_id,c.shop_id,c.branch_id,c.customer_id])).rows[0];
    }
    const messages=(await db.query('SELECT * FROM shop_messages WHERE conversation_id=$1 ORDER BY created_at',[conv.id])).rows;
    return{conversation:conv,messages};
  });

  app.post('/api/customer-portal/messages',async(req,reply)=>{
    const c=await customerContext(db,req);
    const b=z.object({body:z.string().trim().min(1).max(5000)}).parse(req.body);
    let conv=await maybeOne<any>(db,"SELECT * FROM shop_conversations WHERE customer_id=$1 AND shop_id=$2 AND channel='in_app' AND status<>'closed' ORDER BY created_at LIMIT 1",[c.customer_id,c.shop_id]);
    if(!conv)conv=(await db.query(`INSERT INTO shop_conversations(organisation_id,shop_id,branch_id,customer_id,channel,subject) VALUES($1,$2,$3,$4,'in_app','Customer chat') RETURNING *`,[c.organisation_id,c.shop_id,c.branch_id,c.customer_id])).rows[0];
    const r=await db.query(`INSERT INTO shop_messages(conversation_id,sender_type,sender_id,channel,body,delivery_status) VALUES($1,'customer',$2,'in_app',$3,'sent') RETURNING *`,[conv.id,c.customer_id,b.body]);
    await db.query("UPDATE shop_conversations SET last_message_at=now(),status='open' WHERE id=$1",[conv.id]);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/customer-portal/tickets',async(req,reply)=>{
    const c=await customerContext(db,req);
    const b=z.object({category:z.string().max(100).default('general'),subject:z.string().trim().min(2).max(200),description:z.string().trim().min(2).max(4000),priority:z.enum(['low','normal','high']).default('normal')}).parse(req.body);
    const r=await db.query(`
      INSERT INTO shop_tickets(organisation_id,shop_id,branch_id,customer_id,ticket_no,source,category,subject,description,priority)
      VALUES($1,$2,$3,$4,$5,'customer_portal',$6,$7,$8,$9) RETURNING *`,
      [c.organisation_id,c.shop_id,c.branch_id,c.customer_id,code('TKT'),b.category,b.subject,b.description,b.priority]
    );
    return reply.code(201).send(r.rows[0]);
  });

  app.put('/api/customer-portal/profile',async(req,reply)=>{
    const c=await customerContext(db,req);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),phone:z.string().trim().min(6).max(60).optional(),marketingOptIn:z.boolean().optional(),smsOptIn:z.boolean().optional(),whatsappOptIn:z.boolean().optional(),haircutNotes:z.string().max(2000).optional(),allergiesNotes:z.string().max(2000).optional()}).parse(req.body);
    await db.query(`
      UPDATE shop_customers SET name=coalesce($1,name),phone=coalesce($2,phone),
       marketing_opt_in=coalesce($3,marketing_opt_in),sms_opt_in=coalesce($4,sms_opt_in),whatsapp_opt_in=coalesce($5,whatsapp_opt_in)
      WHERE id=$6`,[b.name??null,b.phone??null,b.marketingOptIn??null,b.smsOptIn??null,b.whatsappOptIn??null,c.customer_id]);
    await db.query(`
      INSERT INTO salon_customer_preferences(organisation_id,shop_id,customer_id,haircut_notes,allergies_notes)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(shop_id,customer_id) DO UPDATE SET
       haircut_notes=coalesce(EXCLUDED.haircut_notes,salon_customer_preferences.haircut_notes),
       allergies_notes=coalesce(EXCLUDED.allergies_notes,salon_customer_preferences.allergies_notes),
       updated_at=now()`,[c.organisation_id,c.shop_id,c.customer_id,b.haircutNotes??null,b.allergiesNotes??null]);
    return{updated:true};
  });
}
