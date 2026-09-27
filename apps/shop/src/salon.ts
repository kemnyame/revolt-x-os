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

    CREATE TABLE IF NOT EXISTS salon_settings(
      shop_id uuid PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
      organisation_id uuid NOT NULL,
      timezone text NOT NULL DEFAULT 'Africa/Accra',
      booking_interval_minutes integer NOT NULL DEFAULT 15,
      allow_online_booking boolean NOT NULL DEFAULT true,
      allow_walkins boolean NOT NULL DEFAULT true,
      tax_percent numeric(6,2) NOT NULL DEFAULT 0,
      receipt_footer text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS salon_business_hours(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid NOT NULL REFERENCES shop_branches(id) ON DELETE CASCADE,
      day_of_week integer NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      open_time time NOT NULL,
      close_time time NOT NULL,
      is_closed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(branch_id,day_of_week)
    );

    CREATE INDEX IF NOT EXISTS idx_salon_staff_shop ON salon_staff(organisation_id,shop_id,status);
    CREATE INDEX IF NOT EXISTS idx_salon_chairs_shop ON salon_chairs(organisation_id,shop_id,status);
    CREATE INDEX IF NOT EXISTS idx_salon_commissions_staff ON salon_commission_entries(organisation_id,staff_id,earned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_salon_bookings_queue ON shop_bookings(organisation_id,shop_id,appointment_type,status,booked_for);
  `);
}

export async function assertSalonBookingAvailability(
  db:Db,
  input:{organisationId:string;shopId:string;branchId?:string|null;bookedFor:Date;serviceId?:string|null;staffId?:string|null;chairId?:string|null;ignoreBookingId?:string|null}
){
  if(input.bookedFor.getTime()<Date.now()-5*60*1000){
    const e:any=new Error('The appointment time cannot be in the past.');e.statusCode=409;throw e;
  }
  const settings=await maybeOne<any>(db,'SELECT * FROM salon_settings WHERE shop_id=$1 AND organisation_id=$2',[input.shopId,input.organisationId]);
  const durationRow=input.serviceId?await maybeOne<any>(db,'SELECT duration_minutes FROM shop_services WHERE id=$1 AND shop_id=$2',[input.serviceId,input.shopId]):null;
  const duration=Math.max(5,Number(durationRow?.duration_minutes||30));
  const endAt=new Date(input.bookedFor.getTime()+duration*60000);

  if(input.branchId&&settings){
    const hours=await maybeOne<any>(db,`
      SELECT h.open_time,h.close_time,h.is_closed,
             ($3::timestamptz AT TIME ZONE s.timezone)::time AS local_time
      FROM salon_settings s
      JOIN salon_business_hours h ON h.shop_id=s.shop_id AND h.branch_id=$2
       AND h.day_of_week=EXTRACT(DOW FROM ($3::timestamptz AT TIME ZONE s.timezone))::int
      WHERE s.shop_id=$1
    `,[input.shopId,input.branchId,input.bookedFor.toISOString()]);
    if(hours&&(hours.is_closed||String(hours.local_time)<String(hours.open_time)||String(hours.local_time)>=String(hours.close_time))){
      const e:any=new Error('The salon is closed at the selected time.');e.statusCode=409;throw e;
    }
  }

  if(input.staffId||input.chairId){
    const conflict=await maybeOne<any>(db,`
      SELECT b.id
      FROM shop_bookings b
      LEFT JOIN shop_services s ON s.id=b.service_id
      WHERE b.organisation_id=$1 AND b.shop_id=$2
        AND ($3::uuid IS NULL OR b.branch_id=$3)
        AND b.status NOT IN ('cancelled','no_show','completed')
        AND ($8::uuid IS NULL OR b.id<>$8)
        AND (($6::uuid IS NOT NULL AND b.salon_staff_id=$6) OR ($7::uuid IS NOT NULL AND b.salon_chair_id=$7))
        AND b.booked_for < $5::timestamptz
        AND (b.booked_for + make_interval(mins=>COALESCE(s.duration_minutes,30))) > $4::timestamptz
      ORDER BY b.booked_for LIMIT 1
    `,[
      input.organisationId,input.shopId,input.branchId||null,input.bookedFor.toISOString(),endAt.toISOString(),
      input.staffId||null,input.chairId||null,input.ignoreBookingId||null
    ]);
    if(conflict){
      const e:any=new Error('The selected barber or chair is already booked for that time.');e.statusCode=409;throw e;
    }
  }
  return{durationMinutes:duration,endAt};
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
    await assertSalonBookingAvailability(db,{
      organisationId:a.core.organisation_id,
      shopId:b.shopId,
      branchId:b.branchId||null,
      bookedFor:b.bookedFor,
      serviceId:b.serviceId||null,
      staffId:b.staffId||null,
      chairId:b.chairId||null
    });
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
