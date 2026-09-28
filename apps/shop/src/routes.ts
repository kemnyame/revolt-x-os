import type { FastifyInstance } from 'fastify';
import { randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import { maybeOne, tx } from './db.js';
import type { ShopConfig } from './config.js';
import { assertSalonBookingAvailability } from './salon.js';
import { authorize, hasShopCapability, listShopCapabilities, resetCorePasswordAsSystem } from './auth.js';

const money=z.coerce.number().finite().min(0);
const positive=z.coerce.number().finite().positive();
const uuid=z.string().uuid();

function code(prefix:string){
  return prefix+'-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+Math.random().toString(36).slice(2,8).toUpperCase();
}
function portalPasswordHash(password:string){
  const salt=randomBytes(16).toString('hex');
  return 'scrypt$'+salt+'$'+scryptSync(password,salt,64).toString('hex');
}
function csvCell(value:unknown){
  const s=value==null?'':String(value);
  return '"'+s.replace(/"/g,'""')+'"';
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
    const role=a.role;
    const shopCapabilities=await listShopCapabilities(db,org,role);
    const empty=()=>Promise.resolve({rows:[]} as any);
    const [canCustomers,canProducts,canJobs,canBookings,canSales,canPayments,canFinance,canReports]=await Promise.all([
      hasShopCapability(db,org,role,'customers.read'),
      hasShopCapability(db,org,role,'inventory.read'),
      hasShopCapability(db,org,role,'jobs.read').then(v=>v||hasShopCapability(db,org,role,'jobs.manage')),
      hasShopCapability(db,org,role,'appointments.manage').then(v=>v||hasShopCapability(db,org,role,'bookings.manage')),
      hasShopCapability(db,org,role,'sales.manage'),
      hasShopCapability(db,org,role,'payments.read'),
      hasShopCapability(db,org,role,'finance.read').then(v=>v||hasShopCapability(db,org,role,'finance.manage')),
      hasShopCapability(db,org,role,'reports.read')
    ]);
    const canExpenses=canFinance;
    const canFinancialDashboard=canPayments||canFinance||canReports;

    const [shops,branches,customers,services,products,jobs,bookings,orders,payments,expenses,rawStats]=await Promise.all([
      db.query('SELECT * FROM shops WHERE organisation_id=$1 ORDER BY created_at DESC',[org]),
      db.query('SELECT * FROM shop_branches WHERE organisation_id=$1 ORDER BY name',[org]),
      canCustomers?db.query('SELECT * FROM shop_customers WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 300',[org]):empty(),
      db.query('SELECT * FROM shop_services WHERE organisation_id=$1 ORDER BY name',[org]),
      canProducts?db.query('SELECT * FROM shop_products WHERE organisation_id=$1 ORDER BY name',[org]):empty(),
      canJobs?db.query('SELECT * FROM shop_jobs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 200',[org]):empty(),
      canBookings?db.query('SELECT * FROM shop_bookings WHERE organisation_id=$1 ORDER BY booked_for DESC LIMIT 200',[org]):empty(),
      canSales?db.query('SELECT * FROM shop_orders WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 200',[org]):empty(),
      canPayments?db.query('SELECT * FROM shop_payments WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 250',[org]):empty(),
      canExpenses?db.query('SELECT * FROM shop_expenses WHERE organisation_id=$1 ORDER BY expense_date DESC,created_at DESC LIMIT 200',[org]):empty(),
      dashboard(db,org)
    ]);

    const stats={...rawStats};
    if(!canFinancialDashboard){
      stats.sales_today=null;
      stats.payments_today=null;
      stats.expenses_today=null;
      stats.pending_payments=null;
    }

    return{
      me:a.core,role,shopCapabilities,stats,
      shops:shops.rows,branches:branches.rows,customers:customers.rows,services:services.rows,
      products:products.rows,jobs:jobs.rows,bookings:bookings.rows,orders:orders.rows,
      payments:payments.rows,expenses:expenses.rows
    };
  });

  app.post('/api/shops',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const b=z.object({name:z.string().trim().min(2),slug:z.string().trim().min(2).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),businessType:z.string().default('general_service'),currency:z.string().length(3).default('GHS'),phone:z.string().optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().optional()}).parse(req.body);
    const r=await db.query(
      `INSERT INTO shops(organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.core.organisation_id,b.name,b.slug,(a.core.organisation_slug+'-'+b.slug).toLowerCase(),b.businessType,b.currency.toUpperCase(),b.phone||null,b.email||null,b.address||null,a.core.id]
    );
    if(b.businessType==='barbering_salon'){
      await db.query(
        `INSERT INTO salon_settings(shop_id,organisation_id,timezone,booking_interval_minutes,allow_online_booking,allow_walkins,tax_percent,receipt_footer)
         VALUES($1,$2,'Africa/Accra',15,true,true,0,'Thank you for choosing us.')
         ON CONFLICT(shop_id) DO NOTHING`,
        [r.rows[0].id,a.core.organisation_id]
      );
    }
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
    const shop=await maybeOne<any>(db,'SELECT business_type FROM shops WHERE id=$1 AND organisation_id=$2',[b.shopId,a.core.organisation_id]);
    if(shop?.business_type==='barbering_salon'){
      const template=(await db.query(
        'SELECT day_of_week,open_time,close_time,is_closed FROM salon_business_hours WHERE shop_id=$1 ORDER BY branch_id,day_of_week LIMIT 7',
        [b.shopId]
      )).rows;
      if(template.length){
        for(const h of template){
          await db.query(
            `INSERT INTO salon_business_hours(organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(branch_id,day_of_week) DO NOTHING`,
            [a.core.organisation_id,b.shopId,r.rows[0].id,h.day_of_week,h.open_time,h.close_time,h.is_closed]
          );
        }
      }else{
        for(let day=0;day<=6;day++){
          await db.query(
            `INSERT INTO salon_business_hours(organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed)
             VALUES($1,$2,$3,$4,'08:00','20:00',$5)
             ON CONFLICT(branch_id,day_of_week) DO NOTHING`,
            [a.core.organisation_id,b.shopId,r.rows[0].id,day,day===0]
          );
        }
      }
    }
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
      shopId:uuid,branchId:uuid.optional(),customerId:uuid.optional(),jobId:uuid.optional(),bookingId:uuid.optional(),
      discount:money.default(0),notes:z.string().optional(),
      lines:z.array(z.object({itemType:z.enum(['service','product','other']),itemId:uuid.optional(),description:z.string().min(1),quantity:positive,unitPrice:money})).min(1)
    }).parse(req.body);
    const subtotal=b.lines.reduce((s,l)=>s+(l.quantity*l.unitPrice),0);
    let appliedDiscount=b.discount;
    let automaticDiscount:any=null;
    if(b.customerId&&appliedDiscount<=0){
      automaticDiscount=await maybeOne<any>(db,`
        SELECT * FROM shop_customer_discounts
        WHERE organisation_id=$1 AND shop_id=$2 AND customer_id=$3
          AND status='active' AND (expires_at IS NULL OR expires_at>now())
        ORDER BY CASE WHEN reason='Customer portal registration' THEN 0 ELSE 1 END,created_at
        LIMIT 1`,
        [a.core.organisation_id,b.shopId,b.customerId]
      );
      if(automaticDiscount){
        appliedDiscount=automaticDiscount.discount_type==='percent'
          ? Math.round((subtotal*Number(automaticDiscount.discount_value)/100)*100)/100
          : Math.min(subtotal,Number(automaticDiscount.discount_value));
      }
    }
    const taxable=Math.max(0,subtotal-appliedDiscount);
    const salonSettings=await maybeOne<any>(db,'SELECT tax_percent FROM salon_settings WHERE shop_id=$1 AND organisation_id=$2',[b.shopId,a.core.organisation_id]);
    const taxRate=Math.max(0,Number(salonSettings?.tax_percent||0));
    const tax=Math.round((taxable*taxRate/100)*100)/100;
    const total=Math.max(0,taxable+tax);
    if(b.bookingId){
      const already=await maybeOne<any>(db,'SELECT id,order_no FROM shop_orders WHERE booking_id=$1 AND organisation_id=$2',[b.bookingId,a.core.organisation_id]);
      if(already)return reply.code(409).send({error:{message:'This appointment has already been billed as '+already.order_no}});
    }
    const orderNo=code('INV');
    const order=await tx(db,async c=>{
      const r=await c.query(
        `INSERT INTO shop_orders(organisation_id,shop_id,branch_id,customer_id,job_id,booking_id,order_no,subtotal,discount,tax,total,balance,notes,cashier_session_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,
                (SELECT id FROM shop_cashier_sessions WHERE organisation_id=$1 AND cashier_user_id=$13 AND status='open' ORDER BY started_at DESC LIMIT 1),
                $13) RETURNING *`,
        [a.core.organisation_id,b.shopId,b.branchId||null,b.customerId||null,b.jobId||null,b.bookingId||null,orderNo,subtotal,appliedDiscount,tax,total,b.notes||null,a.core.id]
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
      if(automaticDiscount){
        await c.query(
          `UPDATE shop_customer_discounts SET status='redeemed',redeemed_order_id=$1,redeemed_at=now()
           WHERE id=$2 AND status='active'`,
          [r.rows[0].id,automaticDiscount.id]
        );
      }
      return r.rows[0];
    });
    await audit(db,a.core.organisation_id,a.core.id,'order.created','order',order.id,b.shopId,{orderNo,total,discount:appliedDiscount,automaticDiscountId:automaticDiscount?.id||null});
    return reply.code(201).send(order);
  });

  app.post('/api/orders/:id/payments/manual',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'payments.create');
    const orderId=uuid.parse((req.params as any).id);
    const b=z.object({method:z.enum(['cash','bank_transfer','other']),amount:positive,reference:z.string().optional()}).parse(req.body);
    const payment=await tx(db,async c=>{
      const o=await c.query('SELECT * FROM shop_orders WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[orderId,a.core.organisation_id]);
      if(!o.rowCount)return null;
      const outstanding=Number(o.rows[0].balance||0);
      if(outstanding<=0)throw Object.assign(new Error('Invoice is already fully paid'),{statusCode:409});
      if(b.amount>outstanding+0.001)throw Object.assign(new Error('Payment cannot exceed the outstanding balance'),{statusCode:400});
      const ref=b.reference?.trim()||code('PAY');
      const p=await c.query(
        `INSERT INTO shop_payments(organisation_id,shop_id,branch_id,order_id,customer_id,reference,provider,method,amount,currency,status,paid_at,cashier_session_id)
         VALUES($1,$2,$3,$4,$5,$6,'manual',$7,$8,'GHS','successful',now(),
                (SELECT id FROM shop_cashier_sessions WHERE organisation_id=$1 AND cashier_user_id=$9 AND status='open' ORDER BY started_at DESC LIMIT 1)) RETURNING *`,
        [a.core.organisation_id,o.rows[0].shop_id,o.rows[0].branch_id,orderId,o.rows[0].customer_id,ref,b.method,b.amount,a.core.id]
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

  app.post('/api/payments/:id/reverse',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const paymentId=uuid.parse((req.params as any).id);
    const b=z.object({reason:z.string().trim().min(3).max(1000)}).parse(req.body);

    const reversed=await tx(db,async client=>{
      const p=await client.query('SELECT * FROM shop_payments WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[paymentId,a.core.organisation_id]);
      if(!p.rowCount)return null;
      const payment=p.rows[0];
      if(payment.provider!=='manual')throw Object.assign(new Error('Provider-verified card and Mobile Money payments must be refunded through the payment provider.'),{statusCode:409});
      if(payment.status==='reversed')throw Object.assign(new Error('This payment has already been reversed.'),{statusCode:409});
      if(payment.status!=='successful')throw Object.assign(new Error('Only successful manual payments can be reversed.'),{statusCode:409});

      await client.query(
        `UPDATE shop_payments
         SET status='reversed',reversed_at=now(),reversed_by=$1,reversal_reason=$2
         WHERE id=$3`,
        [a.core.id,b.reason,paymentId]
      );
      const posted=await client.query("SELECT 1 FROM shop_ledger_entries WHERE source_type='payment_reversal' AND source_id=$1 LIMIT 1",[paymentId]);
      if(!posted.rowCount){
        await client.query(
          `INSERT INTO shop_ledger_entries(
             organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,
             source_type,source_id,reference,description
           )
           VALUES
             ($1,$2,$3,'4000','Sales Revenue',$4,0,'payment_reversal',$5,$6,$7),
             ($1,$2,$3,'1000','Cash / Settlement',0,$4,'payment_reversal',$5,$6,$7)`,
          [payment.organisation_id,payment.shop_id,payment.branch_id,payment.amount,payment.id,payment.reference,'Payment reversal: '+b.reason]
        );
      }
      if(payment.order_id)await updateOrderPaid(client,payment.order_id);
      await client.query(
        `INSERT INTO shop_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,branch_id,metadata)
         VALUES($1,$2,'payment.reversed','payment',$3,$4,$5,$6)`,
        [payment.organisation_id,a.core.id,payment.id,payment.shop_id,payment.branch_id,JSON.stringify({reason:b.reason,amount:payment.amount,reference:payment.reference})]
      );
      return{...payment,status:'reversed',reversal_reason:b.reason};
    });

    if(!reversed)return reply.code(404).send({error:{message:'Payment not found'}});
    return reversed;
  });

  app.post('/api/payments/initialize',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'payments.create');
    if(!config.PAYSTACK_SECRET_KEY)return reply.code(503).send({error:{message:'Online payment provider is not configured'}});
    const b=z.object({orderId:uuid,method:z.enum(['mobile_money','card']),email:z.string().email(),phone:z.string().optional(),amount:positive.optional()}).parse(req.body);
    const o=await maybeOne<any>(db,'SELECT * FROM shop_orders WHERE id=$1 AND organisation_id=$2',[b.orderId,a.core.organisation_id]);
    if(!o)return reply.code(404).send({error:{message:'Order not found'}});
    const outstanding=Math.max(0,Number(o.total)-Number(o.amount_paid));
    if(outstanding<=0)return reply.code(400).send({error:{message:'Order is already fully paid'}});
    const amount=b.amount??outstanding;
    if(amount>outstanding+0.001)return reply.code(400).send({error:{message:'Payment cannot exceed the outstanding balance'}});
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
      `INSERT INTO shop_payments(organisation_id,shop_id,branch_id,order_id,customer_id,reference,provider,provider_reference,method,amount,currency,status,payer_phone,payer_email,raw_json,cashier_session_id)
       VALUES($1,$2,$3,$4,$5,$6,'paystack',$7,$8,$9,$10,'pending',$11,$12,$13,
              (SELECT id FROM shop_cashier_sessions WHERE organisation_id=$1 AND cashier_user_id=$14 AND status='open' ORDER BY started_at DESC LIMIT 1)) RETURNING *`,
      [a.core.organisation_id,o.shop_id,o.branch_id,o.id,o.customer_id,reference,data.data?.reference||reference,b.method,amount,config.PAYSTACK_CURRENCY,b.phone||null,b.email,data,a.core.id]
    );
    await audit(db,a.core.organisation_id,a.core.id,'payment.initialized','payment',p.rows[0].id,o.shop_id,{method:b.method,amount});
    return{payment:p.rows[0],authorization_url:data.data.authorization_url,access_code:data.data.access_code};
  });

  app.get('/api/payments/:reference/verify',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'payments.create');
    if(!config.PAYSTACK_SECRET_KEY)return reply.code(503).send({error:{message:'Online payment provider is not configured'}});
    const reference=z.string().min(3).parse((req.params as any).reference);
    const p=await maybeOne<any>(db,'SELECT * FROM shop_payments WHERE reference=$1 AND organisation_id=$2',[reference,a.core.organisation_id]);
    if(!p)return reply.code(404).send({error:{message:'Payment not found'}});
    if(p.provider!=='paystack')return p;

    const ps=await fetch('https://api.paystack.co/transaction/verify/'+encodeURIComponent(reference),{
      headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY},
      signal:AbortSignal.timeout(15000)
    });
    const data=await ps.json() as any;
    if(!ps.ok||!data?.status)return reply.code(502).send({error:{message:data?.message||'Payment verification failed'}});

    const providerStatus=String(data.data?.status||'pending');
    const successful=providerStatus==='success';
    const receivedAmount=Math.round(Number(data.data?.amount||0));
    const expectedAmount=Math.round(Number(p.amount||0)*100);
    const receivedCurrency=String(data.data?.currency||'').toUpperCase();
    const expectedCurrency=String(p.currency||config.PAYSTACK_CURRENCY).toUpperCase();
    const providerFee=Math.max(0,Number(data.data?.fees||0)/100);

    if(successful&&(receivedAmount!==expectedAmount||receivedCurrency!==expectedCurrency)){
      await db.query(
        `UPDATE shop_payments
         SET status='review_required',provider_reference=$1,raw_json=$2
         WHERE id=$3 AND organisation_id=$4`,
        [String(data.data?.id||p.provider_reference||reference),data,p.id,a.core.organisation_id]
      );
      await audit(db,a.core.organisation_id,a.core.id,'payment.amount_mismatch','payment',p.id,p.shop_id,{
        reference,expectedAmount,receivedAmount,expectedCurrency,receivedCurrency
      });
      return reply.code(409).send({error:{message:'Payment provider amount or currency does not match the invoice. The transaction has been flagged for review.'}});
    }

    await tx(db,async client=>{
      const locked=await client.query(
        'SELECT * FROM shop_payments WHERE id=$1 AND organisation_id=$2 FOR UPDATE',
        [p.id,a.core.organisation_id]
      );
      if(!locked.rowCount)return;
      const current=locked.rows[0];

      await client.query(
        `UPDATE shop_payments SET
           status=$1,
           provider_reference=$2,
           fee=$3,
           settlement_amount=$4,
           paid_at=CASE WHEN $1='successful' THEN coalesce(paid_at,now()) ELSE paid_at END,
           raw_json=$5
         WHERE id=$6`,
        [
          successful?'successful':providerStatus,
          String(data.data?.id||current.provider_reference||reference),
          providerFee,
          successful?Math.max(0,Number(current.amount)-providerFee):null,
          data,
          current.id
        ]
      );

      if(successful&&current.order_id){
        const posted=await client.query(
          "SELECT 1 FROM shop_ledger_entries WHERE source_type='payment' AND source_id=$1 LIMIT 1",
          [current.id]
        );
        if(!posted.rowCount){
          await client.query(
            `INSERT INTO shop_ledger_entries(
              organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,
              source_type,source_id,reference,description
            )
            VALUES
              ($1,$2,$3,'1010','Payment Gateway Settlement',$4,0,'payment',$5,$6,'Online customer payment'),
              ($1,$2,$3,'4000','Sales Revenue',0,$4,'payment',$5,$6,'Online customer payment')`,
            [current.organisation_id,current.shop_id,current.branch_id,current.amount,current.id,current.reference]
          );
        }

        if(providerFee>0){
          const feePosted=await client.query(
            "SELECT 1 FROM shop_ledger_entries WHERE source_type='payment_fee' AND source_id=$1 LIMIT 1",
            [current.id]
          );
          if(!feePosted.rowCount){
            await client.query(
              `INSERT INTO shop_ledger_entries(
                organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,
                source_type,source_id,reference,description
              )
              VALUES
                ($1,$2,$3,'5100','Payment Processing Fees',$4,0,'payment_fee',$5,$6,'Payment gateway fee'),
                ($1,$2,$3,'1010','Payment Gateway Settlement',0,$4,'payment_fee',$5,$6,'Payment gateway fee')`,
              [current.organisation_id,current.shop_id,current.branch_id,providerFee,current.id,current.reference]
            );
          }
        }
        await updateOrderPaid(client,current.order_id);
      }
    });

    await audit(db,a.core.organisation_id,a.core.id,'payment.verified','payment',p.id,p.shop_id,{reference,status:providerStatus});
    return maybeOne<any>(db,'SELECT * FROM shop_payments WHERE id=$1 AND organisation_id=$2',[p.id,a.core.organisation_id]);
  });

  app.post('/api/expenses',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),category:z.string().min(2),description:z.string().min(2),amount:positive,paymentMethod:z.string().default('cash'),reference:z.string().optional(),expenseDate:z.string().optional()}).parse(req.body);
    const expense=await tx(db,async c=>{
      const r=await c.query(
        `INSERT INTO shop_expenses(organisation_id,shop_id,branch_id,category,description,amount,payment_method,reference,expense_date,cashier_session_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date,CURRENT_DATE),
                (SELECT id FROM shop_cashier_sessions WHERE organisation_id=$1 AND cashier_user_id=$10 AND status='open' ORDER BY started_at DESC LIMIT 1),
                $10) RETURNING *`,
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

  app.get('/api/orders/:id/full',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(!['shop_admin','manager','cashier','finance','auditor'].includes(a.role)){
      return reply.code(403).send({error:{message:'Invoice access is not available for this Shop role'}});
    }
    const id=uuid.parse((req.params as any).id);
    const order=await maybeOne<any>(db,'SELECT * FROM shop_orders WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!order)return reply.code(404).send({error:{message:'Invoice not found'}});
    const [lines,payments,customer,shop,branch,settings]=await Promise.all([
      db.query('SELECT * FROM shop_order_lines WHERE order_id=$1 ORDER BY id',[id]),
      db.query('SELECT * FROM shop_payments WHERE order_id=$1 AND organisation_id=$2 ORDER BY created_at',[id,a.core.organisation_id]),
      order.customer_id?maybeOne<any>(db,'SELECT * FROM shop_customers WHERE id=$1 AND organisation_id=$2',[order.customer_id,a.core.organisation_id]):Promise.resolve(null),
      maybeOne<any>(db,'SELECT * FROM shops WHERE id=$1 AND organisation_id=$2',[order.shop_id,a.core.organisation_id]),
      order.branch_id?maybeOne<any>(db,'SELECT * FROM shop_branches WHERE id=$1 AND organisation_id=$2',[order.branch_id,a.core.organisation_id]):Promise.resolve(null),
      maybeOne<any>(db,'SELECT * FROM salon_settings WHERE shop_id=$1 AND organisation_id=$2',[order.shop_id,a.core.organisation_id])
    ]);
    return{order,lines:lines.rows,payments:payments.rows,customer,shop,branch,settings};
  });

  app.get('/api/reports/finance',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'reports.read');
    const q=z.object({
      shopId:uuid.optional(),
      branchId:uuid.optional(),
      from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    }).parse(req.query);
    const params=[a.core.organisation_id,q.shopId||null,q.branchId||null,q.from||null,q.to||null];

    const [sales,payments,expenses,ledger]=await Promise.all([
      db.query(`
        SELECT date_trunc('day',x.created_at)::date day,sum(x.total) total
        FROM shop_orders x
        WHERE x.organisation_id=$1
          AND ($2::uuid IS NULL OR x.shop_id=$2)
          AND ($3::uuid IS NULL OR x.branch_id=$3)
          AND ($4::date IS NULL OR x.created_at::date>=$4::date)
          AND ($5::date IS NULL OR x.created_at::date<=$5::date)
        GROUP BY 1 ORDER BY 1 DESC LIMIT 366`,params),
      db.query(`
        SELECT x.method,x.status,count(*)::int transactions,sum(x.amount) amount
        FROM shop_payments x
        WHERE x.organisation_id=$1
          AND ($2::uuid IS NULL OR x.shop_id=$2)
          AND ($3::uuid IS NULL OR x.branch_id=$3)
          AND ($4::date IS NULL OR x.created_at::date>=$4::date)
          AND ($5::date IS NULL OR x.created_at::date<=$5::date)
        GROUP BY x.method,x.status ORDER BY x.method,x.status`,params),
      db.query(`
        SELECT x.category,sum(x.amount) amount
        FROM shop_expenses x
        WHERE x.organisation_id=$1
          AND ($2::uuid IS NULL OR x.shop_id=$2)
          AND ($3::uuid IS NULL OR x.branch_id=$3)
          AND ($4::date IS NULL OR x.expense_date>=$4::date)
          AND ($5::date IS NULL OR x.expense_date<=$5::date)
        GROUP BY x.category ORDER BY amount DESC`,params),
      db.query(`
        SELECT x.account_code,x.account_name,sum(x.debit) debit,sum(x.credit) credit
        FROM shop_ledger_entries x
        WHERE x.organisation_id=$1
          AND ($2::uuid IS NULL OR x.shop_id=$2)
          AND ($3::uuid IS NULL OR x.branch_id=$3)
          AND ($4::date IS NULL OR x.entry_date>=$4::date)
          AND ($5::date IS NULL OR x.entry_date<=$5::date)
        GROUP BY x.account_code,x.account_name ORDER BY x.account_code`,params)
    ]);
    return{sales:sales.rows,payments:payments.rows,expenses:expenses.rows,ledger:ledger.rows};
  });

  app.get('/api/reports/transactions.csv',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'reports.read');
    const q=z.object({
      shopId:uuid.optional(),
      branchId:uuid.optional(),
      from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    }).parse(req.query);

    const params=[
      a.core.organisation_id,
      q.shopId||null,
      q.branchId||null,
      q.from||null,
      q.to||null
    ];

    const [payments,expenses,orders]=await Promise.all([
      db.query(
        "SELECT x.created_at event_date,'Payment' type,x.reference,coalesce(c.name,'') description,x.method,x.status,x.amount,s.name shop_name,coalesce(b.name,'') branch_name "+
        "FROM shop_payments x "+
        "JOIN shops s ON s.id=x.shop_id "+
        "LEFT JOIN shop_branches b ON b.id=x.branch_id "+
        "LEFT JOIN shop_customers c ON c.id=x.customer_id "+
        "WHERE x.organisation_id=$1 "+
        "AND ($2::uuid IS NULL OR x.shop_id=$2) "+
        "AND ($3::uuid IS NULL OR x.branch_id=$3) "+
        "AND ($4::date IS NULL OR x.created_at::date>=$4::date) "+
        "AND ($5::date IS NULL OR x.created_at::date<=$5::date)",
        params
      ),
      db.query(
        "SELECT x.created_at event_date,'Expense' type,coalesce(x.reference,x.id::text) reference,(x.category||': '||x.description) description,x.payment_method method,'posted' status,x.amount,s.name shop_name,coalesce(b.name,'') branch_name "+
        "FROM shop_expenses x "+
        "JOIN shops s ON s.id=x.shop_id "+
        "LEFT JOIN shop_branches b ON b.id=x.branch_id "+
        "WHERE x.organisation_id=$1 "+
        "AND ($2::uuid IS NULL OR x.shop_id=$2) "+
        "AND ($3::uuid IS NULL OR x.branch_id=$3) "+
        "AND ($4::date IS NULL OR x.expense_date>=$4::date) "+
        "AND ($5::date IS NULL OR x.expense_date<=$5::date)",
        params
      ),
      db.query(
        "SELECT x.created_at event_date,'Invoice' type,x.order_no reference,coalesce(c.name,'Walk-in customer') description,'' method,x.status,x.total amount,s.name shop_name,coalesce(b.name,'') branch_name "+
        "FROM shop_orders x "+
        "JOIN shops s ON s.id=x.shop_id "+
        "LEFT JOIN shop_branches b ON b.id=x.branch_id "+
        "LEFT JOIN shop_customers c ON c.id=x.customer_id "+
        "WHERE x.organisation_id=$1 "+
        "AND ($2::uuid IS NULL OR x.shop_id=$2) "+
        "AND ($3::uuid IS NULL OR x.branch_id=$3) "+
        "AND ($4::date IS NULL OR x.created_at::date>=$4::date) "+
        "AND ($5::date IS NULL OR x.created_at::date<=$5::date)",
        params
      )
    ]);

    const rows=[...payments.rows,...expenses.rows,...orders.rows]
      .sort((x:any,y:any)=>new Date(y.event_date).getTime()-new Date(x.event_date).getTime());
    const header=['Date','Type','Reference','Description','Method','Status','Amount','Shop','Branch'];
    const body=rows.map((x:any)=>[
      x.event_date,x.type,x.reference,x.description,x.method,x.status,x.amount,x.shop_name,x.branch_name
    ].map(csvCell).join(','));
    const csv='\uFEFF'+header.map(csvCell).join(',')+'\n'+body.join('\n');
    const stamp=new Date().toISOString().slice(0,10);
    reply.header('content-disposition','attachment; filename="revolt-shop-transactions-'+stamp+'.csv"');
    return reply.type('text/csv; charset=utf-8').send(csv);
  });

  app.get('/api/audit',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'audit.read');
    return (await db.query('SELECT * FROM shop_audit_logs WHERE organisation_id=$1 ORDER BY created_at DESC LIMIT 500',[a.core.organisation_id])).rows;
  });

  app.get('/api/public/store/:slug',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const shop=await maybeOne<any>(db,`
      SELECT s.id,s.name,s.slug,s.public_slug,s.business_type,s.currency,s.phone,s.email,s.address,
             coalesce(ss.allow_online_booking,true) allow_online_booking,
             coalesce(ss.timezone,'Africa/Accra') timezone
      FROM shops s
      LEFT JOIN salon_settings ss ON ss.shop_id=s.id
      WHERE s.public_slug=$1 AND s.status='active'
      LIMIT 1`,[slug]);
    if(!shop)return reply.code(404).send({error:{message:'Shop not found'}});
    const [services,products,branches,barbers]=await Promise.all([
      db.query('SELECT id,name,category,description,price,duration_minutes,deposit_percent FROM shop_services WHERE shop_id=$1 AND active=true ORDER BY name',[shop.id]),
      db.query('SELECT id,name,category,selling_price,stock_quantity FROM shop_products WHERE shop_id=$1 AND active=true AND stock_quantity>0 ORDER BY name LIMIT 100',[shop.id]),
      db.query("SELECT id,name,address,phone FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY name",[shop.id]),
      db.query("SELECT id,branch_id,full_name,specialty FROM salon_staff WHERE shop_id=$1 AND role='barber' AND status='active' ORDER BY full_name",[shop.id])
    ]);
    return{shop,services:services.rows,products:products.rows,branches:branches.rows,barbers:barbers.rows};
  });

  app.get('/api/public/store/:slug/availability',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const q=z.object({
      date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      branchId:uuid.optional(),
      serviceId:uuid,
      staffId:uuid.optional()
    }).parse(req.query);

    const shop=await maybeOne<any>(db,`
      SELECT s.id,s.organisation_id,
             coalesce(ss.allow_online_booking,true) allow_online_booking,
             coalesce(ss.timezone,'Africa/Accra') timezone,
             greatest(5,coalesce(ss.booking_interval_minutes,15)) booking_interval_minutes
      FROM shops s
      LEFT JOIN salon_settings ss ON ss.shop_id=s.id
      WHERE s.public_slug=$1 AND s.status='active' LIMIT 1`,[slug]);
    if(!shop)return reply.code(404).send({error:{message:'Shop not found'}});
    if(shop.allow_online_booking===false)return reply.code(403).send({error:{message:'Online booking is currently disabled for this salon.'}});

    let branchId=q.branchId||null;
    if(!branchId){
      const primary=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY created_at LIMIT 1",[shop.id]);
      branchId=primary?.id||null;
    }
    if(!branchId)return{date:q.date,branchId:null,slots:[]};

    const service=await maybeOne<any>(db,"SELECT id,duration_minutes FROM shop_services WHERE id=$1 AND shop_id=$2 AND active=true",[q.serviceId,shop.id]);
    if(!service)return reply.code(400).send({error:{message:'Selected service is not available.'}});
    if(q.staffId){
      const staff=await maybeOne<any>(db,"SELECT id FROM salon_staff WHERE id=$1 AND shop_id=$2 AND role='barber' AND status='active' AND (branch_id=$3 OR branch_id IS NULL)",[q.staffId,shop.id,branchId]);
      if(!staff)return reply.code(400).send({error:{code:'BARBER_NOT_AVAILABLE',message:'The selected barber is not active at this branch. Please choose another barber.'}});
      const leave=await maybeOne<any>(db,`
        SELECT id FROM shop_staff_leave_requests
        WHERE shop_id=$1 AND salon_staff_id=$2 AND status='approved'
          AND $3::date BETWEEN start_date AND end_date LIMIT 1`,
        [shop.id,q.staffId,q.date]);
      if(leave)return{date:q.date,branchId,timezone:shop.timezone,capacity:0,slots:[],reason:'barber_on_leave'};
    }

    const configuredHours=await maybeOne<any>(db,`
      SELECT h.open_time,h.close_time,h.is_closed
      FROM salon_business_hours h
      WHERE h.shop_id=$1 AND h.branch_id=$2
        AND h.day_of_week=EXTRACT(DOW FROM $3::date)::int
      LIMIT 1`,[shop.id,branchId,q.date]);
    const hours=configuredHours||{open_time:'08:00:00',close_time:'20:00:00',is_closed:false};
    if(hours.is_closed){
      return{date:q.date,branchId,timezone:shop.timezone,capacity:0,slots:[],reason:'closed'};
    }

    const capacityRow=await maybeOne<any>(db,`
      SELECT
        (SELECT count(*)::int FROM salon_chairs
         WHERE shop_id=$1 AND branch_id=$2 AND status NOT IN('maintenance','inactive')) chairs,
        (SELECT count(*)::int FROM salon_staff st
         WHERE st.shop_id=$1 AND (st.branch_id=$2 OR st.branch_id IS NULL)
           AND st.role='barber' AND st.status='active'
           AND NOT EXISTS(
             SELECT 1 FROM shop_staff_leave_requests lr
             WHERE lr.shop_id=$1 AND lr.salon_staff_id=st.id AND lr.status='approved'
               AND $3::date BETWEEN lr.start_date AND lr.end_date
           )) barbers`,
      [shop.id,branchId,q.date]
    );
    const chairs=Math.max(0,Number(capacityRow?.chairs||0));
    const barbers=Math.max(0,Number(capacityRow?.barbers||0));
    const capacity=barbers<=0?0:(chairs>0?Math.min(chairs,barbers):barbers);
    const duration=Math.max(5,Number(service.duration_minutes||30));
    const interval=Math.max(5,Number(shop.booking_interval_minutes||15));

    const slots=await db.query(`
      WITH slots AS (
        SELECT (g AT TIME ZONE $6) AS starts_at
        FROM generate_series(
          ($1::date + $2::time)::timestamp,
          (($1::date + $3::time)::timestamp - make_interval(mins=>$4::int)),
          make_interval(mins=>$5::int)
        ) g
      )
      SELECT s.starts_at,
        (
          SELECT count(*)::int
          FROM shop_bookings b
          LEFT JOIN shop_services existing_service ON existing_service.id=b.service_id
          WHERE b.organisation_id=$7 AND b.shop_id=$8 AND b.branch_id=$9
            AND b.status NOT IN ('cancelled','no_show','completed')
            AND b.booked_for < (s.starts_at + make_interval(mins=>$4::int))
            AND (b.booked_for + make_interval(mins=>coalesce(existing_service.duration_minutes,30))) > s.starts_at
        ) busy,
        (
          SELECT count(*)::int
          FROM shop_bookings b
          LEFT JOIN shop_services existing_service ON existing_service.id=b.service_id
          WHERE $10::uuid IS NOT NULL
            AND b.organisation_id=$7 AND b.shop_id=$8 AND b.branch_id=$9
            AND b.salon_staff_id=$10
            AND b.status NOT IN ('cancelled','no_show','completed')
            AND b.booked_for < (s.starts_at + make_interval(mins=>$4::int))
            AND (b.booked_for + make_interval(mins=>coalesce(existing_service.duration_minutes,30))) > s.starts_at
        ) staff_busy
      FROM slots s
      ORDER BY s.starts_at`,
      [
        q.date,String(hours.open_time),String(hours.close_time),duration,interval,shop.timezone,
        shop.organisation_id,shop.id,branchId,q.staffId||null
      ]
    );

    const now=Date.now()+5*60*1000;
    const available=slots.rows
      .filter((row:any)=>new Date(row.starts_at).getTime()>=now)
      .filter((row:any)=>q.staffId?Number(row.staff_busy||0)===0:Number(row.busy||0)<capacity)
      .map((row:any)=>({startsAt:row.starts_at}));

    return{
      date:q.date,branchId,timezone:shop.timezone,durationMinutes:duration,
      bookingIntervalMinutes:interval,capacity,barbers,chairs,slots:available,
      reason:capacity<=0?'no_active_barber':available.length?'available':'fully_booked'
    };
  });

  app.post('/api/public/store/:slug/bookings',async(req,reply)=>{
    const slug=z.string().min(2).parse((req.params as any).slug);
    const shop=await maybeOne<any>(db,`
      SELECT s.id,s.organisation_id,coalesce(ss.allow_online_booking,true) allow_online_booking
      FROM shops s LEFT JOIN salon_settings ss ON ss.shop_id=s.id
      WHERE s.public_slug=$1 AND s.status='active' LIMIT 1`,[slug]);
    if(!shop)return reply.code(404).send({error:{message:'Shop not found'}});
    if(shop.allow_online_booking===false)return reply.code(403).send({error:{message:'Online booking is currently disabled for this salon.'}});
    const b=z.object({
      branchId:uuid.optional(),serviceId:uuid,staffId:uuid.optional(),
      customerName:z.string().trim().min(2),phone:z.string().trim().min(6),
      email:z.string().email().optional().or(z.literal('')),
      bookedFor:z.coerce.date(),notes:z.string().max(2000).optional(),
      inspirationMediaId:uuid.optional(),
      createAccount:z.boolean().optional().default(false),
      password:z.string().min(8).max(128).optional()
    }).superRefine((v,ctx)=>{
      if(v.createAccount&&!v.email)ctx.addIssue({code:'custom',path:['email'],message:'Email is required when creating a customer account.'});
      if(v.createAccount&&!v.password)ctx.addIssue({code:'custom',path:['password'],message:'Create a password with at least 8 characters.'});
    }).parse(req.body);

    let branchId=b.branchId||null;
    if(!branchId){
      const primary=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE shop_id=$1 AND status='active' ORDER BY created_at LIMIT 1",[shop.id]);
      branchId=primary?.id||null;
    }
    if(!branchId)return reply.code(409).send({error:{message:'This salon has no active branch available for booking.'}});

    const validBranch=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE id=$1 AND shop_id=$2 AND status='active'",[branchId,shop.id]);
    if(!validBranch)return reply.code(400).send({error:{message:'Selected branch is not available.'}});
    const validService=await maybeOne<any>(db,"SELECT id FROM shop_services WHERE id=$1 AND shop_id=$2 AND active=true",[b.serviceId,shop.id]);
    if(!validService)return reply.code(400).send({error:{message:'Selected service is not available.'}});
    if(b.staffId){
      const validStaff=await maybeOne<any>(db,"SELECT id FROM salon_staff WHERE id=$1 AND shop_id=$2 AND role='barber' AND status='active' AND (branch_id=$3 OR branch_id IS NULL)",[b.staffId,shop.id,branchId]);
      if(!validStaff)return reply.code(400).send({error:{message:'Selected barber is not available at this branch.'}});
    }
    if(b.inspirationMediaId){
      const media=await maybeOne<any>(db,"SELECT id FROM shop_gallery_media WHERE id=$1 AND shop_id=$2 AND is_published=true",[b.inspirationMediaId,shop.id]);
      if(!media)return reply.code(400).send({error:{code:'INSPIRATION_MEDIA_NOT_FOUND',message:'The selected style photo or video is no longer available. Please choose another one.'}});
    }

    await assertSalonBookingAvailability(db,{
      organisationId:shop.organisation_id,shopId:shop.id,branchId,bookedFor:b.bookedFor,
      serviceId:b.serviceId,staffId:b.staffId||null
    });

    const booking=await tx(db,async client=>{
      let customer=await maybeOne<any>(client,`
        SELECT * FROM shop_customers
        WHERE shop_id=$1
          AND ((phone IS NOT NULL AND phone=$2) OR ($3<>'' AND lower(email)=lower($3)))
        ORDER BY created_at LIMIT 1`,
        [shop.id,b.phone,b.email||'']
      );
      if(!customer){
        const created=await client.query(
          `INSERT INTO shop_customers(organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,'retail','active') RETURNING *`,
          [shop.organisation_id,shop.id,branchId,code('CUS'),b.customerName,b.phone,b.email||null]
        );
        customer=created.rows[0];
      }else{
        customer=(await client.query(
          `UPDATE shop_customers
           SET name=$1,branch_id=coalesce(branch_id,$2),email=coalesce(nullif(email,''),$3),
               status='active',reactivation_at=CASE WHEN status='inactive' THEN now() ELSE reactivation_at END,
               inactive_at=CASE WHEN status='inactive' THEN NULL ELSE inactive_at END
           WHERE id=$4 RETURNING *`,
          [b.customerName,branchId,b.email||null,customer.id]
        )).rows[0];
      }

      let accountCreated=false;
      let welcomeDiscountPercent=0;
      if(b.createAccount&&b.email&&b.password){
        const existingAccount=await maybeOne<any>(client,
          'SELECT id FROM shop_customer_portal_accounts WHERE shop_id=$1 AND customer_id=$2',
          [shop.id,customer.id]
        );
        if(!existingAccount){
          await client.query(
            `INSERT INTO shop_customer_portal_accounts(organisation_id,shop_id,customer_id,email,phone,password_hash,status)
             VALUES($1,$2,$3,$4,$5,$6,'active')`,
            [shop.organisation_id,shop.id,customer.id,b.email,b.phone,portalPasswordHash(b.password)]
          );
          const setting=await maybeOne<any>(client,
            'SELECT welcome_discount_percent FROM shop_automation_settings WHERE shop_id=$1 AND branch_id IS NULL ORDER BY created_at LIMIT 1',
            [shop.id]
          );
          welcomeDiscountPercent=Number(setting?.welcome_discount_percent??10);
          if(welcomeDiscountPercent>0){
            await client.query(
              `INSERT INTO shop_customer_discounts(organisation_id,shop_id,customer_id,code,discount_type,discount_value,reason,expires_at)
               VALUES($1,$2,$3,$4,'percent',$5,'Customer portal registration',now()+interval '90 days')`,
              [shop.organisation_id,shop.id,customer.id,code('WELCOME'),welcomeDiscountPercent]
            );
          }
          await client.query('UPDATE shop_customers SET portal_registered_at=coalesce(portal_registered_at,now()) WHERE id=$1',[customer.id]);
          accountCreated=true;
        }
      }

      const r=await client.query(
        `INSERT INTO shop_bookings(
           organisation_id,shop_id,branch_id,service_id,customer_id,customer_name,phone,email,
           booked_for,notes,source,status,salon_staff_id,appointment_type,inspiration_media_id
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'public','booked',$11,'appointment',$12)
         RETURNING id,status,booked_for,customer_id,inspiration_media_id`,
        [shop.organisation_id,shop.id,branchId,b.serviceId,customer.id,b.customerName,b.phone,b.email||null,b.bookedFor,b.notes||null,b.staffId||null,b.inspirationMediaId||null]
      );
      return {...r.rows[0],accountCreated,welcomeDiscountPercent};
    });
    return reply.code(201).send({...booking,customerPortalPath:'/customer/'+slug});
  });
}
