import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import { maybeOne, tx } from './db.js';
import type { ShopConfig } from './config.js';
import { authorize, resetCorePasswordAsSystem } from './auth.js';

const money=z.coerce.number().finite().min(0);
const positive=z.coerce.number().finite().positive();
const uuid=z.string().uuid();

function code(prefix:string){
  return prefix+'-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+Math.random().toString(36).slice(2,8).toUpperCase();
}
async function audit(db:Db,orgId:string,userId:string|undefined,action:string,type:string,id:string|undefined,shopId?:string,metadata:any={}){
  await db.query(
    'INSERT INTO shop_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [orgId,userId||null,action,type,id||null,shopId||null,metadata]
  );
}
async function dashboard(db:Db,orgId:string){
  const q=await db.query(`
    SELECT
      (SELECT count(*)::int FROM shops WHERE organisation_id=$1 AND status='active') shops,
      (SELECT count(*)::int FROM shop_customers WHERE organisation_id=$1 AND status='active') customers,
      (SELECT count(*)::int FROM shop_jobs WHERE organisation_id=$1 AND status NOT IN ('completed','cancelled')) open_jobs,
      (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 AND booked_for::date=CURRENT_DATE) bookings_today,
      (SELECT coalesce(sum(total),0) FROM shop_orders WHERE organisation_id=$1 AND created_at::date=CURRENT_DATE) sales_today,
      (SELECT coalesce(sum(amount),0) FROM shop_payments WHERE organisation_id=$1 AND status='successful' AND created_at::date=CURRENT_DATE) payments_today,
      (SELECT coalesce(sum(amount),0) FROM shop_expenses WHERE organisation_id=$1 AND expense_date=CURRENT_DATE) expenses_today,
      (SELECT count(*)::int FROM shop_payments WHERE organisation_id=$1 AND status='pending') pending_payments
  `,[orgId]);
  return q.rows[0];
}
async function updateOrderPaid(client:any,orderId:string){
  const p=await client.query("SELECT coalesce(sum(amount),0) paid FROM shop_payments WHERE order_id=$1 AND status='successful'",[orderId]);
  const o=await client.query("SELECT total FROM shop_orders WHERE id=$1 FOR UPDATE",[orderId]);
  if(!o.rowCount)return;
  const paid=Number(p.rows[0].paid||0),total=Number(o.rows[0].total||0),balance=Math.max(0,total-paid);
  const status=balance<=0?'paid':paid>0?'part_paid':'open';
  await client.query('UPDATE shop_orders SET amount_paid=$1,balance=$2,status=$3,updated_at=now() WHERE id=$4',[paid,balance,status,orderId]);
}

export async function registerShopApi(app:FastifyInstance,opts:{db:Db;config:ShopConfig}){
  const {db,config}=opts;


  app.post('/auth/password-reset/request',async(req,reply)=>{
    const b=z.object({email:z.string().trim().toLowerCase().email()}).parse(req.body);
    const existing=await maybeOne<{id:string}>(db,"SELECT id FROM revolt_x_os.users WHERE email=$1 AND status='active'",[b.email]).catch(()=>null);
    if(existing){
      await db.query("INSERT INTO shop_password_reset_requests(email,status) VALUES($1,'pending')",[b.email]);
    }
    return reply.send({accepted:true,message:'If the account is active, the reset request has been sent to a Revolt-X administrator.'});
  });

  app.get('/api/admin/password-reset-requests',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(a.role!=='shop_admin')return reply.code(403).send({error:{message:'Shop administrator access is required'}});
    const rows=await db.query("SELECT id,email,status,requested_at,completed_at FROM shop_password_reset_requests ORDER BY requested_at DESC LIMIT 200");
    return rows.rows;
  });

  app.post('/api/admin/password-reset-requests/:id/complete',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(a.role!=='shop_admin')return reply.code(403).send({error:{message:'Shop administrator access is required'}});
    const id=uuid.parse((req.params as any).id);
    const b=z.object({password:z.string().min(8).max(128).optional()}).parse(req.body);
    const rr=await maybeOne<any>(db,"SELECT * FROM shop_password_reset_requests WHERE id=$1 AND status='pending'",[id]);
    if(!rr)return reply.code(404).send({error:{message:'Pending reset request not found'}});
    const generated=b.password||('Rx!'+randomBytes(9).toString('base64url')+'9a');
    await resetCorePasswordAsSystem(config,rr.email,generated);
    await db.query("UPDATE shop_password_reset_requests SET status='completed',completed_at=now(),completed_by=$2 WHERE id=$1",[id,a.core.id]);
    await audit(db,a.core.organisation_id,a.core.id,'password_reset.completed','user',undefined,undefined,{email:rr.email});
    return{reset:true,email:rr.email,temporaryPassword:generated};
  });

  app.get('/api/me',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    return{user:a.core,role:a.role};
  });

  app.get('/api/dashboard',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    return dashboard(db,a.core.organisation_id);
  });

  app.get('/api/bootstrap',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const org=a.core.organisation_id;
    const [shops,branches,customers,services,products,jobs,bookings,orders,payments,expenses,stats]=await Promise.all([
      db.query('SELECT * FROM shops WHERE organisation_id=$1 ORDER BY created_at DESC',[org]),
      db.query('SELECT * FROM shop_branches WHERE organisation_id=$1 ORDER BY name',[org]),
      db.query('SELECT * FROM shop_customers WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 300',[org]),
      db.query('SELECT * FROM shop_services WHERE organisation_id=$1 ORDER BY name',[org]),
      db.query('SELECT * FROM shop_products WHERE organisation_id=$1 ORDER BY name',[org]),
      db.query('SELECT * FROM shop_jobs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 200',[org]),
      db.query('SELECT * FROM shop_bookings WHERE organisation_id=$1 ORDER BY booked_for DESC LIMIT 200',[org]),
      db.query('SELECT * FROM shop_orders WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 200',[org]),
      db.query('SELECT * FROM shop_payments WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 250',[org]),
      db.query('SELECT * FROM shop_expenses WHERE organisation_id=$1 ORDER BY expense_date DESC,created_at DESC LIMIT 200',[org]),
      dashboard(db,org)
    ]);
    return{me:a.core,role:a.role,stats,shops:shops.rows,branches:branches.rows,customers:customers.rows,services:services.rows,products:products.rows,jobs:jobs.rows,bookings:bookings.rows,orders:orders.rows,payments:payments.rows,expenses:expenses.rows};
  });

  app.post('/api/shops',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const b=z.object({name:z.string().trim().min(2),slug:z.string().trim().min(2).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),businessType:z.string().default('general_service'),currency:z.string().length(3).default('GHS'),phone:z.string().optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shops(organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.core.organisation_id,b.name,b.slug,(a.core.organisation_slug+'-'+b.slug).toLowerCase(),b.businessType,b.currency.toUpperCase(),b.phone||null,b.email||null,b.address||null,a.core.id]
    );
    await audit(db,a.core.organisation_id,a.core.id,'shop.created','shop',r.rows[0].id,r.rows[0].id,{name:b.name});
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/branches',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const b=z.object({shopId:uuid,name:z.string().trim().min(2),code:z.string().optional(),phone:z.string().optional(),email:z.string().optional(),address:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_branches(organisation_id,shop_id,name,code,phone,email,address)
       SELECT $1,id,$3,$4,$5,$6,$7 FROM shops WHERE id=$2 AND organisation_id=$1 RETURNING *`,
      [a.core.organisation_id,b.shopId,b.name,b.code||null,b.phone||null,b.email||null,b.address||null]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Shop not found'}});
    await audit(db,a.core.organisation_id,a.core.id,'branch.created','branch',r.rows[0].id,b.shopId);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/customers',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'customers.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),name:z.string().trim().min(2),phone:z.string().optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().optional(),customerType:z.string().default('retail'),creditLimit:money.default(0),notes:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_customers(organisation_id,shop_id,branch_id,customer_no,name,phone,email,address,customer_type,credit_limit,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,code('CUS'),b.name,b.phone||null,b.email||null,b.address||null,b.customerType,b.creditLimit,b.notes||null]
    );
    await audit(db,a.core.organisation_id,a.core.id,'customer.created','customer',r.rows[0].id,b.shopId);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/services',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'services.manage');
    const b=z.object({shopId:uuid,name:z.string().trim().min(2),category:z.string().optional(),description:z.string().optional(),price:money,durationMinutes:z.coerce.number().int().min(1).default(30),depositPercent:z.coerce.number().min(0).max(100).default(0)}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_services(organisation_id,shop_id,name,category,description,price,duration_minutes,deposit_percent)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.name,b.category||null,b.description||null,b.price,b.durationMinutes,b.depositPercent]
    );
    await audit(db,a.core.organisation_id,a.core.id,'service.created','service',r.rows[0].id,b.shopId);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/products',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'inventory.manage');
    const b=z.object({shopId:uuid,sku:z.string().optional(),barcode:z.string().optional(),name:z.string().trim().min(2),category:z.string().optional(),costPrice:money.default(0),sellingPrice:money,stockQuantity:z.coerce.number().min(0).default(0),reorderLevel:z.coerce.number().min(0).default(0)}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_products(organisation_id,shop_id,sku,barcode,name,category,cost_price,selling_price,stock_quantity,reorder_level)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.sku||null,b.barcode||null,b.name,b.category||null,b.costPrice,b.sellingPrice,b.stockQuantity,b.reorderLevel]
    );
    if(b.stockQuantity>0)await db.query(
      `INSERT INTO shop_stock_movements(organisation_id,shop_id,product_id,movement_type,quantity,source_type,note)
       VALUES($1,$2,$3,'opening',$4,'setup','Opening stock')`,
      [a.core.organisation_id,b.shopId,r.rows[0].id,b.stockQuantity]
    );
    await audit(db,a.core.organisation_id,a.core.id,'product.created','product',r.rows[0].id,b.shopId);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/products/:id/adjust',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'inventory.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({quantity:z.coerce.number().refine(v=>v!==0),note:z.string().optional()}).parse(req.body);
    const out=await tx(db,async c=>{
      const p=await c.query('SELECT * FROM shop_products WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
      if(!p.rowCount)return null;
      const next=Number(p.rows[0].stock_quantity)+b.quantity;
      if(next<0)throw Object.assign(new Error('Stock cannot be negative'),{statusCode:400});
      await c.query('UPDATE shop_products SET stock_quantity=$1 WHERE id=$2',[next,id]);
      await c.query(`INSERT INTO shop_stock_movements(organisation_id,shop_id,product_id,movement_type,quantity,source_type,note)
        VALUES($1,$2,$3,'adjustment',$4,'manual',$5)`,[a.core.organisation_id,p.rows[0].shop_id,id,b.quantity,b.note||null]);
      return{...p.rows[0],stock_quantity:next};
    });
    if(!out)return reply.code(404).send({error:{message:'Product not found'}});
    await audit(db,a.core.organisation_id,a.core.id,'inventory.adjusted','product',id,out.shop_id,{quantity:b.quantity});
    return out;
  });

  app.post('/api/bookings',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),serviceId:uuid.optional(),customerId:uuid.optional(),customerName:z.string().trim().min(2),phone:z.string().optional(),email:z.string().optional(),bookedFor:z.coerce.date(),notes:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_bookings(organisation_id,shop_id,branch_id,service_id,customer_id,customer_name,phone,email,booked_for,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.serviceId||null,b.customerId||null,b.customerName,b.phone||null,b.email||null,b.bookedFor,b.notes||null]
    );
    await audit(db,a.core.organisation_id,a.core.id,'booking.created','booking',r.rows[0].id,b.shopId);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/jobs',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'jobs.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),customerId:uuid.optional(),serviceId:uuid.optional(),bookingId:uuid.optional(),title:z.string().trim().min(2),status:z.string().default('received'),expectedCompletion:z.coerce.date().optional(),labourCost:money.default(0),materialCost:money.default(0),notes:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_jobs(organisation_id,shop_id,branch_id,customer_id,service_id,booking_id,job_no,title,status,expected_completion,labour_cost,material_cost,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.customerId||null,b.serviceId||null,b.bookingId||null,code('JOB'),b.title,b.status,b.expectedCompletion||null,b.labourCost,b.materialCost,b.notes||null]
    );
    await audit(db,a.core.organisation_id,a.core.id,'job.created','job',r.rows[0].id,b.shopId);
    return reply.code(201).send(r.rows[0]);
  });

  app.patch('/api/jobs/:id/status',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'jobs.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({status:z.enum(['received','inspection','quoted','approved','in_progress','quality_check','completed','delivered','cancelled'])}).parse(req.body);
    const r=await db.query('UPDATE shop_jobs SET status=$1,updated_at=now() WHERE id=$2 AND organisation_id=$3 RETURNING *',[b.status,id,a.core.organisation_id]);
    if(!r.rowCount)return reply.code(404).send({error:{message:'Job not found'}});
    await audit(db,a.core.organisation_id,a.core.id,'job.status_changed','job',id,r.rows[0].shop_id,{status:b.status});
    return r.rows[0];
  });

  app.post('/api/orders',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'sales.manage');
    const b=z.object({
      shopId:uuid,branchId:uuid.optional(),customerId:uuid.optional(),jobId:uuid.optional(),
      discount:money.default(0),tax:money.default(0),notes:z.string().optional(),
      lines:z.array(z.object({itemType:z.enum(['service','product','other']),itemId:uuid.optional(),description:z.string().min(1),quantity:positive,unitPrice:money})).min(1)
    }).parse(req.body);
    const subtotal=b.lines.reduce((s,l)=>s+(l.quantity*l.unitPrice),0);
    const total=Math.max(0,subtotal-b.discount+b.tax);
    const orderNo=code('INV');
    const order=await tx(db,async c=>{
      const r=await c.query(
        `INSERT INTO shop_orders(organisation_id,shop_id,branch_id,customer_id,job_id,order_no,subtotal,discount,tax,total,balance,notes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12) RETURNING *`,
        [a.core.organisation_id,b.shopId,b.branchId||null,b.customerId||null,b.jobId||null,orderNo,subtotal,b.discount,b.tax,total,b.notes||null,a.core.id]
      );
      for(const l of b.lines){
        await c.query(
          'INSERT INTO shop_order_lines(order_id,item_type,item_id,description,quantity,unit_price,line_total) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [r.rows[0].id,l.itemType,l.itemId||null,l.description,l.quantity,l.unitPrice,l.quantity*l.unitPrice]
        );
        if(l.itemType==='product'&&l.itemId){
          const p=await c.query('SELECT stock_quantity FROM shop_products WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[l.itemId,a.core.organisation_id]);
          if(!p.rowCount)throw Object.assign(new Error('Product not found'),{statusCode:400});
          const next=Number(p.rows[0].stock_quantity)-l.quantity;
          if(next<0)throw Object.assign(new Error('Insufficient stock for '+l.description),{statusCode:400});
          await c.query('UPDATE shop_products SET stock_quantity=$1 WHERE id=$2',[next,l.itemId]);
          await c.query(`INSERT INTO shop_stock_movements(organisation_id,shop_id,branch_id,product_id,movement_type,quantity,source_type,source_id,note)
            VALUES($1,$2,$3,$4,'sale',$5,'order',$6,$7)`,[a.core.organisation_id,b.shopId,b.branchId||null,l.itemId,-l.quantity,r.rows[0].id,orderNo]);
        }
      }
      return r.rows[0];
    });
    await audit(db,a.core.organisation_id,a.core.id,'order.created','order',order.id,b.shopId,{orderNo,total});
    return reply.code(201).send(order);
  });

  app.post('/api/orders/:id/payments/manual',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'payments.create');
    const orderId=uuid.parse((req.params as any).id);
    const b=z.object({method:z.enum(['cash','bank_transfer','credit','other']),amount:positive,reference:z.string().optional()}).parse(req.body);
    const payment=await tx(db,async c=>{
      const o=await c.query('SELECT * FROM shop_orders WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[orderId,a.core.organisation_id]);
      if(!o.rowCount)return null;
      const ref=b.reference?.trim()||code('PAY');
      const p=await c.query(
        `INSERT INTO shop_payments(organisation_id,shop_id,branch_id,order_id,customer_id,reference,provider,method,amount,currency,status,paid_at)
         VALUES($1,$2,$3,$4,$5,$6,'manual',$7,$8,'GHS','successful',now()) RETURNING *`,
        [a.core.organisation_id,o.rows[0].shop_id,o.rows[0].branch_id,orderId,o.rows[0].customer_id,ref,b.method,b.amount]
      );
      await c.query(
        `INSERT INTO shop_ledger_entries(organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,source_type,source_id,reference,description)
         VALUES($1,$2,$3,'1000','Cash / Settlement', $4,0,'payment',$5,$6,'Customer receipt'),
               ($1,$2,$3,'4000','Sales Revenue',0,$4,'payment',$5,$6,'Customer receipt')`,
        [a.core.organisation_id,o.rows[0].shop_id,o.rows[0].branch_id,b.amount,p.rows[0].id,ref]
      );
      await updateOrderPaid(c,orderId);
      return p.rows[0];
    });
    if(!payment)return reply.code(404).send({error:{message:'Order not found'}});
    await audit(db,a.core.organisation_id,a.core.id,'payment.recorded','payment',payment.id,payment.shop_id,{method:b.method,amount:b.amount});
    return reply.code(201).send(payment);
  });

  app.post('/api/payments/initialize',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'payments.create');
    if(!config.PAYSTACK_SECRET_KEY)return reply.code(503).send({error:{message:'Online payment provider is not configured'}});
    const b=z.object({orderId:uuid,method:z.enum(['mobile_money','card']),email:z.string().email(),phone:z.string().optional()}).parse(req.body);
    const o=await maybeOne<any>(db,'SELECT * FROM shop_orders WHERE id=$1 AND organisation_id=$2',[b.orderId,a.core.organisation_id]);
    if(!o)return reply.code(404).send({error:{message:'Order not found'}});
    const amount=Math.max(0,Number(o.total)-Number(o.amount_paid));
    if(amount<=0)return reply.code(400).send({error:{message:'Order is already fully paid'}});
    const reference=code('RXS');
    const callback=(config.PUBLIC_BASE_URL||'').replace(/\/$/,'')+'/payments/callback?reference='+encodeURIComponent(reference);
    const ps=await fetch('https://api.paystack.co/transaction/initialize',{
      method:'POST',
      headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY,'content-type':'application/json'},
      body:JSON.stringify({
        email:b.email,amount:Math.round(amount*100),currency:config.PAYSTACK_CURRENCY,reference,
        channels:[b.method],
        callback_url:callback||undefined,
        metadata:{order_id:o.id,shop_id:o.shop_id,organisation_id:a.core.organisation_id,payer_phone:b.phone||null}
      }),
      signal:AbortSignal.timeout(15000)
    });
    const data=await ps.json() as any;
    if(!ps.ok||!data?.status)return reply.code(502).send({error:{message:data?.message||'Payment provider initialization failed'}});
    const p=await db.query(
      `INSERT INTO shop_payments(organisation_id,shop_id,branch_id,order_id,customer_id,reference,provider,provider_reference,method,amount,currency,status,payer_phone,payer_email,raw_json)
       VALUES($1,$2,$3,$4,$5,$6,'paystack',$7,$8,$9,$10,'pending',$11,$12,$13) RETURNING *`,
      [a.core.organisation_id,o.shop_id,o.branch_id,o.id,o.customer_id,reference,data.data?.reference||reference,b.method,amount,config.PAYSTACK_CURRENCY,b.phone||null,b.email,data]
    );
    await audit(db,a.core.organisation_id,a.core.id,'payment.initialized','payment',p.rows[0].id,o.shop_id,{method:b.method,amount});
    return{payment:p.rows[0],authorization_url:data.data.authorization_url,access_code:data.data.access_code};
  });

  app.get('/api/payments/:reference/verify',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'payments.read');
    if(!config.PAYSTACK_SECRET_KEY)return reply.code(503).send({error:{message:'Online payment provider is not configured'}});
    const reference=z.string().min(3).parse((req.params as any).reference);
    const p=await maybeOne<any>(db,'SELECT * FROM shop_payments WHERE reference=$1 AND organisation_id=$2',[reference,a.core.organisation_id]);
    if(!p)return reply.code(404).send({error:{message:'Payment not found'}});
    if(p.provider!=='paystack')return p;
    const ps=await fetch('https://api.paystack.co/transaction/verify/'+encodeURIComponent(reference),{
      headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY},signal:AbortSignal.timeout(15000)
    });
    const data=await ps.json() as any;
    if(!ps.ok||!data?.status)return reply.code(502).send({error:{message:data?.message||'Payment verification failed'}});
    const successful=data.data?.status==='success';
    await tx(db,async c=>{
      await c.query(
        `UPDATE shop_payments SET status=$1,provider_reference=$2,fee=$3,settlement_amount=$4,paid_at=CASE WHEN $1='successful' THEN coalesce(paid_at,now()) ELSE paid_at END,raw_json=$5
         WHERE id=$6`,
        [successful?'successful':data.data?.status||'pending',String(data.data?.id||p.provider_reference||reference),Number(data.data?.fees||0)/100,successful?Math.max(0,Number(p.amount)-Number(data.data?.fees||0)/100):null,data,p.id]
      );
      if(successful&&p.order_id){
        const posted=await c.query("SELECT 1 FROM shop_ledger_entries WHERE source_type='payment' AND source_id=$1 LIMIT 1",[p.id]);
        if(!posted.rowCount){
          await c.query(
            `INSERT INTO shop_ledger_entries(organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,source_type,source_id,reference,description)
             VALUES($1,$2,$3,'1010','Payment Gateway Settlement',$4,0,'payment',$5,$6,'Online customer payment'),
                   ($1,$2,$3,'4000','Sales Revenue',0,$4,'payment',$5,$6,'Online customer payment')`,
            [p.organisation_id,p.shop_id,p.branch_id,p.amount,p.id,p.reference]
          );
        }
        await updateOrderPaid(c,p.order_id);
      }
    });
    return maybeOne<any>(db,'SELECT * FROM shop_payments WHERE id=$1',[p.id]);
  });

  app.post('/api/expenses',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),category:z.string().min(2),description:z.string().min(2),amount:positive,paymentMethod:z.string().default('cash'),reference:z.string().optional(),expenseDate:z.string().optional()}).parse(req.body);
    const expense=await tx(db,async c=>{
      const r=await c.query(
        `INSERT INTO shop_expenses(organisation_id,shop_id,branch_id,category,description,amount,payment_method,reference,expense_date,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date,CURRENT_DATE),$10) RETURNING *`,
        [a.core.organisation_id,b.shopId,b.branchId||null,b.category,b.description,b.amount,b.paymentMethod,b.reference||null,b.expenseDate||null,a.core.id]
      );
      await c.query(
        `INSERT INTO shop_ledger_entries(organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,source_type,source_id,reference,description)
         VALUES($1,$2,$3,'5000','Operating Expense',$4,0,'expense',$5,$6,$7),
               ($1,$2,$3,'1000','Cash / Settlement',0,$4,'expense',$5,$6,$7)`,
        [a.core.organisation_id,b.shopId,b.branchId||null,b.amount,r.rows[0].id,b.reference||r.rows[0].id,b.description]
      );
      return r.rows[0];
    });
    await audit(db,a.core.organisation_id,a.core.id,'expense.recorded','expense',expense.id,b.shopId,{amount:b.amount});
    return reply.code(201).send(expense);
  });

  app.get('/api/reports/finance',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'reports.read');
    const shopId=(req.query as any)?.shopId;
    const params:any[]=[a.core.organisation_id];
    let filter='';
    if(shopId){params.push(shopId);filter=' AND shop_id=$2';}
    const [sales,payments,expenses,ledger]=await Promise.all([
      db.query('SELECT date_trunc(\'day\',created_at)::date day,sum(total) total FROM shop_orders WHERE organisation_id=$1'+filter+' GROUP BY 1 ORDER BY 1 DESC LIMIT 90',params),
      db.query('SELECT method,status,count(*)::int transactions,sum(amount) amount FROM shop_payments WHERE organisation_id=$1'+filter+' GROUP BY method,status ORDER BY method,status',params),
      db.query('SELECT category,sum(amount) amount FROM shop_expenses WHERE organisation_id=$1'+filter+' GROUP BY category ORDER BY amount DESC',params),
      db.query('SELECT account_code,account_name,sum(debit) debit,sum(credit) credit FROM shop_ledger_entries WHERE organisation_id=$1'+filter+' GROUP BY account_code,account_name ORDER BY account_code',params)
    ]);
    return{sales:sales.rows,payments:payments.rows,expenses:expenses.rows,ledger:ledger.rows};
  });

  app.get('/api/audit',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'audit.read');
    return (await db.query('SELECT * FROM shop_audit_logs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 500',[a.core.organisation_id])).rows;
  });

  app.get('/api/public/store/:slug',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const shop=await maybeOne<any>(db,"SELECT id,name,slug,public_slug,business_type,currency,phone,email,address FROM shops WHERE public_slug=$1 AND status='active' LIMIT 1",[slug]);
    if(!shop)return reply.code(404).send({error:{message:'Shop not found'}});
    const [services,products,branches]=await Promise.all([
      db.query('SELECT id,name,category,description,price,duration_minutes,deposit_percent FROM shop_services WHERE shop_id=$1 AND active=true ORDER BY name',[shop.id]),
      db.query('SELECT id,name,category,selling_price,stock_quantity FROM shop_products WHERE shop_id=$1 AND active=true AND stock_quantity>0 ORDER BY name LIMIT 100',[shop.id]),
      db.query("SELECT id,name,address,phone FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY name",[shop.id])
    ]);
    return{shop,services:services.rows,products:products.rows,branches:branches.rows};
  });

  app.post('/api/public/store/:slug/bookings',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const shop=await maybeOne<any>(db,"SELECT id,organisation_id FROM shops WHERE public_slug=$1 AND status='active' LIMIT 1",[slug]);
    if(!shop)return reply.code(404).send({error:{message:'Shop not found'}});
    const b=z.object({branchId:uuid.optional(),serviceId:uuid.optional(),customerName:z.string().trim().min(2),phone:z.string().min(6),email:z.string().email().optional().or(z.literal('')),bookedFor:z.coerce.date(),notes:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shop_bookings(organisation_id,shop_id,branch_id,service_id,customer_name,phone,email,booked_for,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status,booked_for`,
      [shop.organisation_id,shop.id,b.branchId||null,b.serviceId||null,b.customerName,b.phone,b.email||null,b.bookedFor,b.notes||null]
    );
    return reply.code(201).send(r.rows[0]);
  });
}
