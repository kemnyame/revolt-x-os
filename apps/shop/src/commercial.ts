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
}
