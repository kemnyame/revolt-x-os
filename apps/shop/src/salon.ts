import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { tx, maybeOne } from './db.js';
import type { ShopConfig } from './config.js';
import { authorize } from './auth.js';

const uuid=z.string().uuid();
const money=z.coerce.number().finite().min(0);

export async function ensureSalonSchema(db:Db){
  await db.query(`
    CREATE TABLE IF NOT EXISTS salon_staff(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      os_user_id uuid,
      staff_no text,
      full_name text NOT NULL,
      phone text,
      email text,
      role text NOT NULL DEFAULT 'barber',
      specialty text,
      commission_percent numeric(6,2) NOT NULL DEFAULT 0,
      hire_date date,
      status text NOT NULL DEFAULT 'active',
      avatar_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,staff_no)
    );

    CREATE TABLE IF NOT EXISTS salon_chairs(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      name text NOT NULL,
      code text,
      status text NOT NULL DEFAULT 'available',
      assigned_staff_id uuid REFERENCES salon_staff(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,name)
    );

    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS salon_staff_id uuid;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS salon_chair_id uuid;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS appointment_type text NOT NULL DEFAULT 'appointment';
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS queue_number integer;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS check_in_at timestamptz;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS service_started_at timestamptz;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS service_completed_at timestamptz;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS estimated_wait_minutes integer NOT NULL DEFAULT 0;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff';

    CREATE TABLE IF NOT EXISTS salon_commission_entries(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      staff_id uuid NOT NULL REFERENCES salon_staff(id) ON DELETE CASCADE,
      order_id uuid REFERENCES shop_orders(id) ON DELETE SET NULL,
      booking_id uuid REFERENCES shop_bookings(id) ON DELETE SET NULL,
      gross_amount numeric(14,2) NOT NULL DEFAULT 0,
      commission_percent numeric(6,2) NOT NULL DEFAULT 0,
      commission_amount numeric(14,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'earned',
      earned_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz,
      note text
    );

    CREATE TABLE IF NOT EXISTS salon_eod_closures(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      business_date date NOT NULL DEFAULT CURRENT_DATE,
      opening_cash numeric(14,2) NOT NULL DEFAULT 0,
      expected_cash numeric(14,2) NOT NULL DEFAULT 0,
      actual_cash numeric(14,2) NOT NULL DEFAULT 0,
      variance numeric(14,2) NOT NULL DEFAULT 0,
      momo_total numeric(14,2) NOT NULL DEFAULT 0,
      card_total numeric(14,2) NOT NULL DEFAULT 0,
      bank_total numeric(14,2) NOT NULL DEFAULT 0,
      total_sales numeric(14,2) NOT NULL DEFAULT 0,
      total_expenses numeric(14,2) NOT NULL DEFAULT 0,
      notes text,
      closed_by uuid,
      closed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,branch_id,business_date)
    );

    CREATE TABLE IF NOT EXISTS salon_customer_preferences(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
      preferred_staff_id uuid REFERENCES salon_staff(id) ON DELETE SET NULL,
      preferred_service_id uuid REFERENCES shop_services(id) ON DELETE SET NULL,
      haircut_notes text,
      allergies_notes text,
      last_visit_at timestamptz,
      visit_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_salon_staff_shop ON salon_staff(organisation_id,shop_id,status);
    CREATE INDEX IF NOT EXISTS idx_salon_chairs_shop ON salon_chairs(organisation_id,shop_id,status);
    CREATE INDEX IF NOT EXISTS idx_salon_commissions_staff ON salon_commission_entries(organisation_id,staff_id,earned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_salon_bookings_queue ON shop_bookings(organisation_id,shop_id,appointment_type,status,booked_for);
  `);
}

export async function seedSalonDemo(db:Db,config:ShopConfig){
  if(!config.SALON_DEMO_SEED)return;
  const key='salon-demo:'+config.SALON_DEMO_VERSION;
  const done=await db.query('SELECT 1 FROM shop_bootstrap_state WHERE key=$1',[key]);
  if(done.rowCount)return;

  const org=await maybeOne<any>(db,"SELECT id,slug FROM revolt_x_os.organisations WHERE slug='kem-company' LIMIT 1");
  if(!org)return;

  await tx(db,async c=>{
    const existing=await c.query("SELECT id FROM shops WHERE organisation_id=$1 AND slug='revolt-cuts' LIMIT 1",[org.id]);
    let shopId:string;
    if(existing.rowCount) shopId=existing.rows[0].id;
    else{
      const s=await c.query(
        `INSERT INTO shops(organisation_id,name,slug,public_slug,business_type,currency,phone,email,address,status)
         VALUES($1,'Revolt Cuts Barbering Salon','revolt-cuts',$2,'barbering_salon','GHS','0557485233','hello@revoltcuts.com','East Legon, Accra','active')
         RETURNING id`,
        [org.id,(org.slug+'-revolt-cuts').toLowerCase()]
      );
      shopId=s.rows[0].id;
    }

    let branch=await c.query("SELECT id FROM shop_branches WHERE shop_id=$1 AND name='East Legon Main Salon' LIMIT 1",[shopId]);
    if(!branch.rowCount){
      branch=await c.query(
        `INSERT INTO shop_branches(organisation_id,shop_id,name,code,phone,email,address,status)
         VALUES($1,$2,'East Legon Main Salon','EL-01','0557485233','eastlegon@revoltcuts.com','Boundary Road, East Legon, Accra','active')
         RETURNING id`,
        [org.id,shopId]
      );
    }
    const branchId=branch.rows[0].id;

    const services=[
      ['Classic Haircut','Haircut',70,35,0],
      ['Skin Fade','Haircut',100,50,10],
      ['Beard Trim & Line-up','Beard',50,25,0],
      ['Haircut + Beard Combo','Combo',130,65,15],
      ['Kids Haircut','Haircut',60,30,0],
      ['Hair Wash & Scalp Care','Treatment',40,20,0],
      ['Hair Dye / Colour','Treatment',120,60,20],
      ['VIP Grooming Experience','Premium',180,90,25]
    ];
    for(const [name,category,price,duration,deposit] of services){
      await c.query(
        `INSERT INTO shop_services(organisation_id,shop_id,name,category,description,price,duration_minutes,deposit_percent,active)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,true
         WHERE NOT EXISTS(SELECT 1 FROM shop_services WHERE shop_id=$2 AND name=$3)`,
        [org.id,shopId,name,category,name+' service tailored for a modern barbering salon.',price,duration,deposit]
      );
    }

    const staff=[
      ['BAR-001','Kwame Mensah','0244000101','kwame@revoltcuts.com','barber','Fades, line-ups & precision cuts',40],
      ['BAR-002','Kojo Asare','0244000102','kojo@revoltcuts.com','barber','Classic cuts & beard grooming',35],
      ['BAR-003','Daniel Tetteh','0244000103','daniel@revoltcuts.com','barber','Colour, texture & premium grooming',35],
      ['REC-001','Ama Boateng','0244000104','ama@revoltcuts.com','receptionist','Front desk & customer care',0]
    ];
    for(const s of staff){
      await c.query(
        `INSERT INTO salon_staff(organisation_id,shop_id,branch_id,staff_no,full_name,phone,email,role,specialty,commission_percent,status,hire_date)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',CURRENT_DATE-90
         WHERE NOT EXISTS(SELECT 1 FROM salon_staff WHERE shop_id=$2 AND staff_no=$4)`,
        [org.id,shopId,branchId,...s]
      );
    }

    const barbers=await c.query("SELECT id,staff_no FROM salon_staff WHERE shop_id=$1 AND role='barber' ORDER BY staff_no",[shopId]);
    for(let i=0;i<4;i++){
      const staffId=barbers.rows[i%Math.max(1,barbers.rowCount)]?.id??null;
      await c.query(
        `INSERT INTO salon_chairs(organisation_id,shop_id,branch_id,name,code,status,assigned_staff_id)
         SELECT $1,$2,$3,$4,$5,'available',$6
         WHERE NOT EXISTS(SELECT 1 FROM salon_chairs WHERE shop_id=$2 AND name=$4)`,
        [org.id,shopId,branchId,'Chair '+(i+1),'CH-'+String(i+1).padStart(2,'0'),staffId]
      );
    }

    const products=[
      ['RC-POM-01','Revolt Hold Pomade','Styling',25,45,20,5],
      ['RC-BRD-01','Premium Beard Oil','Beard Care',35,65,16,4],
      ['RC-AFT-01','Cooling Aftershave','Grooming',22,40,18,5],
      ['RC-SHM-01','Scalp Care Shampoo','Hair Care',28,50,14,4],
      ['RC-SPG-01','Wave Sponge','Accessories',12,25,24,6]
    ];
    for(const p of products){
      await c.query(
        `INSERT INTO shop_products(organisation_id,shop_id,sku,name,category,cost_price,selling_price,stock_quantity,reorder_level,active)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,true
         WHERE NOT EXISTS(SELECT 1 FROM shop_products WHERE shop_id=$2 AND sku=$3)`,
        [org.id,shopId,...p]
      );
    }

    const customers=[
      ['CUS-RC-001','Michael Ofori','0241112233','michael.ofori@example.com'],
      ['CUS-RC-002','Nana K. Mensah','0552223344','nana.mensah@example.com'],
      ['CUS-RC-003','Yaw Boateng','0203334455','yaw.boateng@example.com'],
      ['CUS-RC-004','Jeffery Addo','0544445566','jeffery.addo@example.com'],
      ['CUS-RC-005','Samuel Owusu','0245556677','samuel.owusu@example.com'],
      ['CUS-RC-006','Prince Arthur','0596667788','prince.arthur@example.com']
    ];
    for(const x of customers){
      await c.query(
        `INSERT INTO shop_customers(organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status)
         SELECT $1,$2,$3,$4,$5,$6,$7,'retail','active'
         WHERE NOT EXISTS(SELECT 1 FROM shop_customers WHERE shop_id=$2 AND phone=$6)`,
        [org.id,shopId,branchId,...x]
      );
    }

    const svc=await c.query("SELECT id,name FROM shop_services WHERE shop_id=$1 ORDER BY name",[shopId]);
    const cust=await c.query("SELECT id,name,phone,email FROM shop_customers WHERE shop_id=$1 ORDER BY created_at LIMIT 6",[shopId]);
    const chairs=await c.query("SELECT id FROM salon_chairs WHERE shop_id=$1 ORDER BY name",[shopId]);
    const statuses=['booked','checked_in','in_chair','completed','booked','queued'];
    for(let i=0;i<Math.min(6,cust.rowCount);i++){
      const customer=cust.rows[i], service=svc.rows[i%svc.rowCount], barber=barbers.rows[i%barbers.rowCount], chair=chairs.rows[i%chairs.rowCount];
      await c.query(
        `INSERT INTO shop_bookings(organisation_id,shop_id,branch_id,service_id,customer_id,customer_name,phone,email,booked_for,status,salon_staff_id,salon_chair_id,appointment_type,queue_number,check_in_at,service_started_at,service_completed_at,estimated_wait_minutes,source,notes)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE + time '09:00' + ($9::int * interval '75 minutes'),$10,$11,$12,$13,$14,
                CASE WHEN $10 IN ('checked_in','queued','in_chair','completed') THEN now()-interval '10 minutes' ELSE NULL END,
                CASE WHEN $10 IN ('in_chair','completed') THEN now()-interval '5 minutes' ELSE NULL END,
                CASE WHEN $10='completed' THEN now() ELSE NULL END,
                CASE WHEN $10 IN ('checked_in','queued') THEN 15 ELSE 0 END,'seed','Demo salon schedule'
         WHERE NOT EXISTS(
           SELECT 1 FROM shop_bookings WHERE shop_id=$2 AND customer_id=$5 AND booked_for::date=CURRENT_DATE
         )`,
        [org.id,shopId,branchId,service.id,customer.id,customer.name,customer.phone,customer.email,i,statuses[i],barber.id,chair.id,i===5?'walk_in':'appointment',i===5?6:null]
      );
    }

    await c.query('INSERT INTO shop_bootstrap_state(key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
  });
}

function nextQueue(rows:any[]){
  return rows.reduce((m,r)=>Math.max(m,Number(r.queue_number||0)),0)+1;
}

async function salonDashboard(db:Db,orgId:string,shopId?:string){
  const params:any[]=[orgId];
  let shopFilter='';
  if(shopId){params.push(shopId);shopFilter=' AND shop_id=$2';}
  const q=await db.query(`
    SELECT
      (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 ${shopFilter} AND booked_for::date=CURRENT_DATE) appointments_today,
      (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 ${shopFilter} AND booked_for::date=CURRENT_DATE AND appointment_type='walk_in') walkins_today,
      (SELECT count(*)::int FROM shop_bookings WHERE organisation_id=$1 ${shopFilter} AND booked_for::date=CURRENT_DATE AND status IN ('queued','checked_in')) waiting_now,
      (SELECT count(*)::int FROM salon_chairs WHERE organisation_id=$1 ${shopFilter} AND status='available') available_chairs,
      (SELECT count(*)::int FROM salon_staff WHERE organisation_id=$1 ${shopFilter} AND role='barber' AND status='active') active_barbers,
      (SELECT coalesce(sum(amount),0) FROM shop_payments WHERE organisation_id=$1 ${shopFilter} AND status='successful' AND created_at::date=CURRENT_DATE) revenue_today,
      (SELECT coalesce(sum(commission_amount),0) FROM salon_commission_entries WHERE organisation_id=$1 ${shopFilter} AND earned_at::date=CURRENT_DATE) commissions_today,
      (SELECT coalesce(avg(extract(epoch from (service_started_at-check_in_at))/60),0) FROM shop_bookings WHERE organisation_id=$1 ${shopFilter} AND check_in_at IS NOT NULL AND service_started_at IS NOT NULL AND booked_for::date=CURRENT_DATE) avg_wait_minutes
  `,params);
  return q.rows[0];
}

export async function registerSalonRoutes(app:FastifyInstance,{db,config}:{db:Db;config:ShopConfig}){
  app.get('/api/salon/bootstrap',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const shopId=(req.query as any)?.shopId;
    const params:any[]=[a.core.organisation_id];
    let f='';
    if(shopId){params.push(shopId);f=' AND shop_id=$2';}
    const [staff,chairs,appointments,commissions,eod,stats]=await Promise.all([
      db.query('SELECT * FROM salon_staff WHERE organisation_id=$1'+f+' ORDER BY role,full_name',params),
      db.query('SELECT * FROM salon_chairs WHERE organisation_id=$1'+f+' ORDER BY name',params),
      db.query(`SELECT b.*,s.name service_name,st.full_name barber_name,c.name chair_name
                FROM shop_bookings b
                LEFT JOIN shop_services s ON s.id=b.service_id
                LEFT JOIN salon_staff st ON st.id=b.salon_staff_id
                LEFT JOIN salon_chairs c ON c.id=b.salon_chair_id
                WHERE b.organisation_id=$1${f} AND b.booked_for::date BETWEEN CURRENT_DATE-7 AND CURRENT_DATE+30
                ORDER BY b.booked_for`,params),
      db.query(`SELECT ce.*,st.full_name barber_name FROM salon_commission_entries ce
                JOIN salon_staff st ON st.id=ce.staff_id
                WHERE ce.organisation_id=$1${f} ORDER BY ce.earned_at DESC LIMIT 250`,params),
      db.query('SELECT * FROM salon_eod_closures WHERE organisation_id=$1'+f+' ORDER BY business_date DESC LIMIT 45',params),
      salonDashboard(db,a.core.organisation_id,shopId)
    ]);
    return{staff:staff.rows,chairs:chairs.rows,appointments:appointments.rows,commissions:commissions.rows,eod:eod.rows,stats};
  });

  app.post('/api/salon/staff',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),fullName:z.string().min(2),phone:z.string().optional(),email:z.string().email().optional().or(z.literal('')),role:z.enum(['barber','receptionist','manager','assistant']).default('barber'),specialty:z.string().optional(),commissionPercent:z.coerce.number().min(0).max(100).default(0)}).parse(req.body);
    const no='SAL-'+Date.now().toString().slice(-6);
    const r=await db.query(`INSERT INTO salon_staff(organisation_id,shop_id,branch_id,staff_no,full_name,phone,email,role,specialty,commission_percent,status,hire_date)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',CURRENT_DATE) RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,no,b.fullName,b.phone||null,b.email||null,b.role,b.specialty||null,b.commissionPercent]);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/salon/chairs',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'shops.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),name:z.string().min(2),code:z.string().optional(),assignedStaffId:uuid.optional()}).parse(req.body);
    const r=await db.query(`INSERT INTO salon_chairs(organisation_id,shop_id,branch_id,name,code,assigned_staff_id,status)
      VALUES($1,$2,$3,$4,$5,$6,'available') RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.name,b.code||null,b.assignedStaffId||null]);
    return reply.code(201).send(r.rows[0]);
  });

  app.post('/api/salon/appointments',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const b=z.object({
      shopId:uuid,branchId:uuid.optional(),serviceId:uuid.optional(),customerId:uuid.optional(),
      customerName:z.string().min(2),phone:z.string().optional(),email:z.string().email().optional().or(z.literal('')),
      bookedFor:z.coerce.date(),staffId:uuid.optional(),chairId:uuid.optional(),
      appointmentType:z.enum(['appointment','walk_in']).default('appointment'),notes:z.string().optional()
    }).parse(req.body);
    let queueNo:null|number=null;
    let status='booked';
    if(b.appointmentType==='walk_in'){
      const q=await db.query("SELECT queue_number FROM shop_bookings WHERE organisation_id=$1 AND shop_id=$2 AND booked_for::date=CURRENT_DATE AND appointment_type='walk_in'",[a.core.organisation_id,b.shopId]);
      queueNo=nextQueue(q.rows);status='queued';
    }
    const r=await db.query(`INSERT INTO shop_bookings(organisation_id,shop_id,branch_id,service_id,customer_id,customer_name,phone,email,booked_for,notes,status,salon_staff_id,salon_chair_id,appointment_type,queue_number,check_in_at,estimated_wait_minutes,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $14='walk_in' THEN now() ELSE NULL END,CASE WHEN $14='walk_in' THEN 15 ELSE 0 END,'staff') RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.serviceId||null,b.customerId||null,b.customerName,b.phone||null,b.email||null,b.bookedFor,b.notes||null,status,b.staffId||null,b.chairId||null,b.appointmentType,queueNo]);
    return reply.code(201).send(r.rows[0]);
  });

  app.patch('/api/salon/appointments/:id/status',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({status:z.enum(['booked','queued','checked_in','in_chair','completed','cancelled','no_show']),staffId:uuid.optional(),chairId:uuid.optional()}).parse(req.body);
    const r=await tx(db,async c=>{
      const old=await c.query('SELECT * FROM shop_bookings WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
      if(!old.rowCount)return null;
      const row=old.rows[0];
      const upd=await c.query(`UPDATE shop_bookings SET status=$1,
        salon_staff_id=coalesce($2,salon_staff_id),salon_chair_id=coalesce($3,salon_chair_id),
        check_in_at=CASE WHEN $1='checked_in' AND check_in_at IS NULL THEN now() ELSE check_in_at END,
        service_started_at=CASE WHEN $1='in_chair' AND service_started_at IS NULL THEN now() ELSE service_started_at END,
        service_completed_at=CASE WHEN $1='completed' AND service_completed_at IS NULL THEN now() ELSE service_completed_at END
        WHERE id=$4 RETURNING *`,[b.status,b.staffId||null,b.chairId||null,id]);
      if(b.status==='in_chair'&&upd.rows[0].salon_chair_id){
        await c.query("UPDATE salon_chairs SET status='occupied',assigned_staff_id=coalesce($1,assigned_staff_id) WHERE id=$2",[upd.rows[0].salon_staff_id,upd.rows[0].salon_chair_id]);
      }
      if(['completed','cancelled','no_show'].includes(b.status)&&upd.rows[0].salon_chair_id){
        await c.query("UPDATE salon_chairs SET status='available' WHERE id=$1",[upd.rows[0].salon_chair_id]);
      }
      if(b.status==='completed'&&upd.rows[0].salon_staff_id){
        const service=await maybeOne<any>(c,'SELECT price FROM shop_services WHERE id=$1',[upd.rows[0].service_id]);
        const staff=await maybeOne<any>(c,'SELECT commission_percent FROM salon_staff WHERE id=$1',[upd.rows[0].salon_staff_id]);
        const gross=Number(service?.price||0), pct=Number(staff?.commission_percent||0);
        await c.query(`INSERT INTO salon_commission_entries(organisation_id,shop_id,branch_id,staff_id,booking_id,gross_amount,commission_percent,commission_amount,status,note)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,'earned','Service completion'
          WHERE NOT EXISTS(SELECT 1 FROM salon_commission_entries WHERE booking_id=$5)`,
          [a.core.organisation_id,upd.rows[0].shop_id,upd.rows[0].branch_id,upd.rows[0].salon_staff_id,id,gross,pct,gross*pct/100]);
        if(upd.rows[0].customer_id){
          await c.query(`INSERT INTO salon_customer_preferences(organisation_id,shop_id,customer_id,preferred_staff_id,preferred_service_id,last_visit_at,visit_count)
            VALUES($1,$2,$3,$4,$5,now(),1)
            ON CONFLICT(shop_id,customer_id) DO UPDATE SET preferred_staff_id=EXCLUDED.preferred_staff_id,preferred_service_id=EXCLUDED.preferred_service_id,last_visit_at=now(),visit_count=salon_customer_preferences.visit_count+1,updated_at=now()`,
            [a.core.organisation_id,upd.rows[0].shop_id,upd.rows[0].customer_id,upd.rows[0].salon_staff_id,upd.rows[0].service_id]);
        }
      }
      return upd.rows[0];
    });
    if(!r)return reply.code(404).send({error:{message:'Appointment not found'}});
    return r;
  });

  app.post('/api/salon/eod',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'finance.manage');
    const b=z.object({shopId:uuid,branchId:uuid.optional(),openingCash:money.default(0),actualCash:money,notes:z.string().optional()}).parse(req.body);
    const params=[a.core.organisation_id,b.shopId,b.branchId||null];
    const p=await db.query(`SELECT
      coalesce(sum(CASE WHEN method='cash' AND status='successful' THEN amount ELSE 0 END),0) cash,
      coalesce(sum(CASE WHEN method='mobile_money' AND status='successful' THEN amount ELSE 0 END),0) momo,
      coalesce(sum(CASE WHEN method='card' AND status='successful' THEN amount ELSE 0 END),0) card,
      coalesce(sum(CASE WHEN method='bank_transfer' AND status='successful' THEN amount ELSE 0 END),0) bank,
      coalesce(sum(CASE WHEN status='successful' THEN amount ELSE 0 END),0) total
      FROM shop_payments WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND created_at::date=CURRENT_DATE`,params);
    const e=await db.query(`SELECT coalesce(sum(amount),0) total FROM shop_expenses WHERE organisation_id=$1 AND shop_id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND expense_date=CURRENT_DATE`,params);
    const pay=p.rows[0], expenses=Number(e.rows[0].total||0);
    const expected=Number(b.openingCash)+Number(pay.cash||0)-expenses;
    const variance=Number(b.actualCash)-expected;
    const r=await db.query(`INSERT INTO salon_eod_closures(organisation_id,shop_id,branch_id,business_date,opening_cash,expected_cash,actual_cash,variance,momo_total,card_total,bank_total,total_sales,total_expenses,notes,closed_by)
      VALUES($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(shop_id,branch_id,business_date) DO UPDATE SET opening_cash=EXCLUDED.opening_cash,expected_cash=EXCLUDED.expected_cash,actual_cash=EXCLUDED.actual_cash,variance=EXCLUDED.variance,momo_total=EXCLUDED.momo_total,card_total=EXCLUDED.card_total,bank_total=EXCLUDED.bank_total,total_sales=EXCLUDED.total_sales,total_expenses=EXCLUDED.total_expenses,notes=EXCLUDED.notes,closed_by=EXCLUDED.closed_by,closed_at=now()
      RETURNING *`,
      [a.core.organisation_id,b.shopId,b.branchId||null,b.openingCash,expected,b.actualCash,variance,pay.momo,pay.card,pay.bank,pay.total,expenses,b.notes||null,a.core.id]);
    return reply.code(201).send(r.rows[0]);
  });

  app.get('/api/salon/commission-summary',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'reports.read');
    const shopId=(req.query as any)?.shopId;
    const params:any[]=[a.core.organisation_id];let f='';
    if(shopId){params.push(shopId);f=' AND ce.shop_id=$2';}
    const r=await db.query(`SELECT st.id,st.full_name,st.staff_no,st.commission_percent,
      count(ce.id)::int services,
      coalesce(sum(ce.gross_amount),0) gross_service_value,
      coalesce(sum(ce.commission_amount),0) commission_earned
      FROM salon_staff st
      LEFT JOIN salon_commission_entries ce ON ce.staff_id=st.id AND ce.earned_at::date>=date_trunc('month',CURRENT_DATE)
      WHERE st.organisation_id=$1 ${shopId?' AND st.shop_id=$2':''} AND st.role='barber'
      GROUP BY st.id ORDER BY commission_earned DESC`,params);
    return r.rows;
  });
}
