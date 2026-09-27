import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { tx, maybeOne } from './db.js';
import type { ShopConfig } from './config.js';
import { authorize } from './auth.js';

const money=z.coerce.number().finite().min(0);

export async function registerCommercialSalonRoutes(app:FastifyInstance,{db,config}:{db:Db;config:ShopConfig}){
  app.get('/api/onboarding/status',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const r=await db.query("SELECT count(*)::int shops FROM shops WHERE organisation_id=$1 AND status='active'",[a.core.organisation_id]);
    return{configured:Number(r.rows[0]?.shops||0)>0,shopCount:Number(r.rows[0]?.shops||0)};
  });

  app.post('/api/onboarding/setup',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const b=z.object({
      salonName:z.string().trim().min(2).max(160),
      slug:z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      phone:z.string().trim().min(6).max(40),
      email:z.string().email().optional().or(z.literal('')),
      address:z.string().trim().min(2).max(500),
      branchName:z.string().trim().min(2).max(160).default('Main Branch'),
      branchCode:z.string().trim().max(40).optional(),
      chairCount:z.coerce.number().int().min(1).max(30).default(4),
      timezone:z.string().min(2).max(80).default('Africa/Accra'),
      openTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
      closeTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('20:00'),
      workingDays:z.array(z.coerce.number().int().min(0).max(6)).min(1).default([1,2,3,4,5,6]),
      services:z.array(z.object({
        name:z.string().trim().min(2).max(160),
        category:z.string().trim().max(100).optional(),
        price:money,
        durationMinutes:z.coerce.number().int().min(5).max(480).default(30),
        depositPercent:z.coerce.number().min(0).max(100).default(0)
      })).min(1).max(50),
      ownerBarberName:z.string().trim().max(160).optional(),
      ownerCommissionPercent:z.coerce.number().min(0).max(100).default(0)
    }).parse(req.body);

    const already=await maybeOne<any>(db,'SELECT id FROM shops WHERE organisation_id=$1 LIMIT 1',[a.core.organisation_id]);
    if(already)return reply.code(409).send({error:{message:'This organisation is already configured.'}});

    const result=await tx(db,async client=>{
      const shop=await client.query(
        "INSERT INTO shops(organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,status,created_by) VALUES($1,$2,$3,$4,'barbering_salon','GHS',$5,$6,$7,'active',$8) RETURNING *",
        [a.core.organisation_id,b.salonName,b.slug,(a.core.organisation_slug+'-'+b.slug).toLowerCase(),b.phone,b.email||null,b.address,a.core.id]
      );
      const shopId=shop.rows[0].id;
      const branch=await client.query(
        "INSERT INTO shop_branches(organisation_id,shop_id,name,code,phone,email,address,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *",
        [a.core.organisation_id,shopId,b.branchName,b.branchCode||'MAIN',b.phone,b.email||null,b.address]
      );
      const branchId=branch.rows[0].id;
      await client.query(
        "INSERT INTO salon_settings(shop_id,organisation_id,timezone,booking_interval_minutes,allow_online_booking,allow_walkins,tax_percent,receipt_footer) VALUES($1,$2,$3,15,true,true,0,'Thank you for choosing us.')",
        [shopId,a.core.organisation_id,b.timezone]
      );
      for(let day=0;day<=6;day++){
        await client.query(
          "INSERT INTO salon_business_hours(organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed) VALUES($1,$2,$3,$4,$5::time,$6::time,$7)",
          [a.core.organisation_id,shopId,branchId,day,b.openTime,b.closeTime,!b.workingDays.includes(day)]
        );
      }
      for(let i=1;i<=b.chairCount;i++){
        await client.query(
          "INSERT INTO salon_chairs(organisation_id,shop_id,branch_id,name,code,status) VALUES($1,$2,$3,$4,$5,'available')",
          [a.core.organisation_id,shopId,branchId,'Chair '+i,'CH-'+String(i).padStart(2,'0')]
        );
      }
      for(const svc of b.services){
        await client.query(
          "INSERT INTO shop_services(organisation_id,shop_id,name,category,price,duration_minutes,deposit_percent,active) VALUES($1,$2,$3,$4,$5,$6,$7,true)",
          [a.core.organisation_id,shopId,svc.name,svc.category||'Barbering',svc.price,svc.durationMinutes,svc.depositPercent]
        );
      }
      if(b.ownerBarberName){
        await client.query(
          "INSERT INTO salon_staff(organisation_id,shop_id,branch_id,os_user_id,staff_no,full_name,email,role,specialty,commission_percent,hire_date,status) VALUES($1,$2,$3,$4,'BAR-001',$5,$6,'barber','Owner / Lead Barber',$7,CURRENT_DATE,'active')",
          [a.core.organisation_id,shopId,branchId,a.core.id,b.ownerBarberName,a.core.email,b.ownerCommissionPercent]
        );
      }
      return{shop:shop.rows[0],branch:branch.rows[0]};
    });
    return reply.code(201).send(result);
  });

  app.get('/api/salon/settings/:shopId',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const shopId=z.string().uuid().parse((req.params as any).shopId);
    const settings=await maybeOne<any>(db,'SELECT * FROM salon_settings WHERE shop_id=$1 AND organisation_id=$2',[shopId,a.core.organisation_id]);
    const hours=(await db.query('SELECT * FROM salon_business_hours WHERE shop_id=$1 AND organisation_id=$2 ORDER BY day_of_week',[shopId,a.core.organisation_id])).rows;
    return{settings,hours};
  });

  app.patch('/api/salon/settings/:shopId',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const shopId=z.string().uuid().parse((req.params as any).shopId);
    const b=z.object({
      timezone:z.string().min(2).max(80).optional(),
      bookingIntervalMinutes:z.coerce.number().int().min(5).max(120).optional(),
      allowOnlineBooking:z.boolean().optional(),
      allowWalkins:z.boolean().optional(),
      taxPercent:z.coerce.number().min(0).max(100).optional(),
      receiptFooter:z.string().max(1000).optional().nullable(),
      branchId:z.string().uuid().optional(),
      hours:z.array(z.object({
        dayOfWeek:z.coerce.number().int().min(0).max(6),
        openTime:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/),
        closeTime:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/),
        isClosed:z.boolean().default(false)
      })).max(7).optional()
    }).parse(req.body);
    const owns=await maybeOne<any>(db,'SELECT id FROM shops WHERE id=$1 AND organisation_id=$2',[shopId,a.core.organisation_id]);
    if(!owns)return reply.code(404).send({error:{message:'Shop not found'}});
    await tx(db,async client=>{
      await client.query(
        `INSERT INTO salon_settings(shop_id,organisation_id,timezone,booking_interval_minutes,allow_online_booking,allow_walkins,tax_percent,receipt_footer)
         VALUES($1,$2,coalesce($3,'Africa/Accra'),coalesce($4,15),coalesce($5,true),coalesce($6,true),coalesce($7,0),$8)
         ON CONFLICT(shop_id) DO UPDATE SET
           timezone=coalesce($3,salon_settings.timezone),
           booking_interval_minutes=coalesce($4,salon_settings.booking_interval_minutes),
           allow_online_booking=coalesce($5,salon_settings.allow_online_booking),
           allow_walkins=coalesce($6,salon_settings.allow_walkins),
           tax_percent=coalesce($7,salon_settings.tax_percent),
           receipt_footer=CASE WHEN $9 THEN $8 ELSE salon_settings.receipt_footer END,
           updated_at=now()`,
        [shopId,a.core.organisation_id,b.timezone??null,b.bookingIntervalMinutes??null,b.allowOnlineBooking??null,b.allowWalkins??null,b.taxPercent??null,b.receiptFooter??null,Object.prototype.hasOwnProperty.call(b,'receiptFooter')]
      );
      if(b.branchId&&b.hours){
        const branch=await maybeOne<any>(client,'SELECT id FROM shop_branches WHERE id=$1 AND shop_id=$2 AND organisation_id=$3',[b.branchId,shopId,a.core.organisation_id]);
        if(!branch)throw Object.assign(new Error('Branch not found'),{statusCode:404});
        for(const h of b.hours){
          await client.query(
            `INSERT INTO salon_business_hours(organisation_id,shop_id,branch_id,day_of_week,open_time,close_time,is_closed)
             VALUES($1,$2,$3,$4,$5::time,$6::time,$7)
             ON CONFLICT(branch_id,day_of_week) DO UPDATE SET open_time=EXCLUDED.open_time,close_time=EXCLUDED.close_time,is_closed=EXCLUDED.is_closed,updated_at=now()`,
            [a.core.organisation_id,shopId,b.branchId,h.dayOfWeek,h.openTime,h.closeTime,h.isClosed]
          );
        }
      }
    });
    return{updated:true};
  });

  app.patch('/api/shops/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),phone:z.string().max(40).optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().max(500).optional(),status:z.enum(['active','inactive']).optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE shops SET name=coalesce($1,name),phone=coalesce($2,phone),email=coalesce($3,email),address=coalesce($4,address),status=coalesce($5,status),updated_at=now()
       WHERE id=$6 AND organisation_id=$7 RETURNING *`,
      [b.name??null,b.phone??null,b.email===undefined?null:b.email||null,b.address??null,b.status??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Shop not found'}});
    return r.rows[0];
  });

  app.patch('/api/branches/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),code:z.string().max(40).optional(),phone:z.string().max(40).optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().max(500).optional(),status:z.enum(['active','inactive']).optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE shop_branches SET name=coalesce($1,name),code=coalesce($2,code),phone=coalesce($3,phone),email=coalesce($4,email),address=coalesce($5,address),status=coalesce($6,status)
       WHERE id=$7 AND organisation_id=$8 RETURNING *`,
      [b.name??null,b.code??null,b.phone??null,b.email===undefined?null:b.email||null,b.address??null,b.status??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Branch not found'}});
    return r.rows[0];
  });

  app.patch('/api/customers/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'customers.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),phone:z.string().max(40).optional(),email:z.string().email().optional().or(z.literal('')),address:z.string().max(500).optional(),customerType:z.string().max(60).optional(),creditLimit:money.optional(),notes:z.string().max(2000).optional(),status:z.enum(['active','inactive']).optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE shop_customers SET name=coalesce($1,name),phone=coalesce($2,phone),email=coalesce($3,email),address=coalesce($4,address),customer_type=coalesce($5,customer_type),credit_limit=coalesce($6,credit_limit),notes=coalesce($7,notes),status=coalesce($8,status)
       WHERE id=$9 AND organisation_id=$10 RETURNING *`,
      [b.name??null,b.phone??null,b.email===undefined?null:b.email||null,b.address??null,b.customerType??null,b.creditLimit??null,b.notes??null,b.status??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Customer not found'}});
    return r.rows[0];
  });

  app.patch('/api/services/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'services.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),category:z.string().max(100).optional(),description:z.string().max(2000).optional(),price:money.optional(),durationMinutes:z.coerce.number().int().min(5).max(480).optional(),depositPercent:z.coerce.number().min(0).max(100).optional(),active:z.boolean().optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE shop_services SET name=coalesce($1,name),category=coalesce($2,category),description=coalesce($3,description),price=coalesce($4,price),duration_minutes=coalesce($5,duration_minutes),deposit_percent=coalesce($6,deposit_percent),active=coalesce($7,active)
       WHERE id=$8 AND organisation_id=$9 RETURNING *`,
      [b.name??null,b.category??null,b.description??null,b.price??null,b.durationMinutes??null,b.depositPercent??null,b.active??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Service not found'}});
    return r.rows[0];
  });

  app.patch('/api/products/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'inventory.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),sku:z.string().max(100).optional(),category:z.string().max(100).optional(),costPrice:money.optional(),sellingPrice:money.optional(),reorderLevel:z.coerce.number().min(0).optional(),active:z.boolean().optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE shop_products SET name=coalesce($1,name),sku=coalesce($2,sku),category=coalesce($3,category),cost_price=coalesce($4,cost_price),selling_price=coalesce($5,selling_price),reorder_level=coalesce($6,reorder_level),active=coalesce($7,active)
       WHERE id=$8 AND organisation_id=$9 RETURNING *`,
      [b.name??null,b.sku??null,b.category??null,b.costPrice??null,b.sellingPrice??null,b.reorderLevel??null,b.active??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Product not found'}});
    return r.rows[0];
  });

  app.patch('/api/salon/staff/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({fullName:z.string().trim().min(2).max(160).optional(),phone:z.string().max(40).optional(),email:z.string().email().optional().or(z.literal('')),role:z.enum(['barber','receptionist','manager','assistant']).optional(),specialty:z.string().max(300).optional(),commissionPercent:z.coerce.number().min(0).max(100).optional(),status:z.enum(['active','inactive','leave']).optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE salon_staff SET full_name=coalesce($1,full_name),phone=coalesce($2,phone),email=coalesce($3,email),role=coalesce($4,role),specialty=coalesce($5,specialty),commission_percent=coalesce($6,commission_percent),status=coalesce($7,status)
       WHERE id=$8 AND organisation_id=$9 RETURNING *`,
      [b.fullName??null,b.phone??null,b.email===undefined?null:b.email||null,b.role??null,b.specialty??null,b.commissionPercent??null,b.status??null,id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Staff member not found'}});
    return r.rows[0];
  });

  app.patch('/api/salon/chairs/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const id=z.string().uuid().parse((req.params as any).id);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),code:z.string().max(40).optional(),assignedStaffId:z.string().uuid().nullable().optional(),status:z.enum(['available','maintenance','inactive']).optional()}).parse(req.body);
    const r=await db.query(
      `UPDATE salon_chairs SET name=coalesce($1,name),code=coalesce($2,code),assigned_staff_id=CASE WHEN $5 THEN $3 ELSE assigned_staff_id END,status=coalesce($4,status)
       WHERE id=$6 AND organisation_id=$7 RETURNING *`,
      [b.name??null,b.code??null,b.assignedStaffId??null,b.status??null,Object.prototype.hasOwnProperty.call(b,'assignedStaffId'),id,a.core.organisation_id]
    );
    if(!r.rowCount)return reply.code(404).send({error:{message:'Chair not found'}});
    return r.rows[0];
  });


  app.get('/api/access/users',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(a.role!=='shop_admin'&&a.role!=='manager')return reply.code(403).send({error:{message:'Shop administrator access is required'}});
    const r=await db.query(
      `SELECT u.id user_id,u.email,u.first_name,u.last_name,u.status core_status,m.status membership_status,
              COALESCE(sm.role,'') shop_role,COALESCE(sm.status,'') shop_status
       FROM revolt_x_os.organisation_memberships m
       JOIN revolt_x_os.users u ON u.id=m.user_id
       LEFT JOIN shop_memberships sm ON sm.organisation_id=m.organisation_id AND sm.os_user_id=u.id
       WHERE m.organisation_id=$1
       ORDER BY u.first_name,u.last_name,u.email`,
      [a.core.organisation_id]
    );
    return r.rows;
  });

  app.put('/api/access/users/:userId',async(req,reply)=>{
    const a=await authorize(db,config,req,reply);
    if(a.role!=='shop_admin')return reply.code(403).send({error:{message:'Shop administrator access is required'}});
    const userId=z.string().uuid().parse((req.params as any).userId);
    const b=z.object({role:z.enum(['shop_admin','manager','cashier','finance','service','inventory','auditor']),status:z.enum(['active','inactive']).default('active')}).parse(req.body);
    const member=await maybeOne<any>(db,'SELECT user_id FROM revolt_x_os.organisation_memberships WHERE organisation_id=$1 AND user_id=$2',[a.core.organisation_id,userId]);
    if(!member)return reply.code(404).send({error:{message:'User is not a member of this Revolt-X organisation'}});
    const r=await db.query(
      `INSERT INTO shop_memberships(organisation_id,os_user_id,role,status)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status
       RETURNING *`,
      [a.core.organisation_id,userId,b.role,b.status]
    );
    return r.rows[0];
  });

}
