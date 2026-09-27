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
             ($3::timestamptz AT TIME ZONE s.timezone)::time AS local_time,
             ($4::timestamptz AT TIME ZONE s.timezone)::time AS local_end_time
      FROM salon_settings s
      JOIN salon_business_hours h ON h.shop_id=s.shop_id AND h.branch_id=$2
       AND h.day_of_week=EXTRACT(DOW FROM ($3::timestamptz AT TIME ZONE s.timezone))::int
      WHERE s.shop_id=$1
    `,[input.shopId,input.branchId,input.bookedFor.toISOString(),endAt.toISOString()]);
    if(hours&&(hours.is_closed||String(hours.local_time)<String(hours.open_time)||String(hours.local_end_time)>String(hours.close_time))){
      const e:any=new Error('The selected service does not fit within the salon\'s business hours.');e.statusCode=409;throw e;
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
  }else{
    const cap=await maybeOne<any>(db,`
      SELECT
        (SELECT count(*)::int FROM salon_chairs
          WHERE organisation_id=$1 AND shop_id=$2
            AND ($3::uuid IS NULL OR branch_id=$3)
            AND status<>'maintenance') AS chairs,
        (SELECT count(*)::int FROM salon_staff
          WHERE organisation_id=$1 AND shop_id=$2
            AND ($3::uuid IS NULL OR branch_id=$3)
            AND role='barber' AND status='active') AS barbers,
        (SELECT count(*)::int
          FROM shop_bookings b
          LEFT JOIN shop_services s ON s.id=b.service_id
          WHERE b.organisation_id=$1 AND b.shop_id=$2
            AND ($3::uuid IS NULL OR b.branch_id=$3)
            AND b.status NOT IN ('cancelled','no_show','completed')
            AND ($6::uuid IS NULL OR b.id<>$6)
            AND b.booked_for < $5::timestamptz
            AND (b.booked_for + make_interval(mins=>COALESCE(s.duration_minutes,30))) > $4::timestamptz
        ) AS busy
    `,[
      input.organisationId,input.shopId,input.branchId||null,input.bookedFor.toISOString(),endAt.toISOString(),
      input.ignoreBookingId||null
    ]);
    const chairs=Math.max(0,Number(cap?.chairs||0));
    const barbers=Math.max(0,Number(cap?.barbers||0));
    const capacity=chairs>0&&barbers>0?Math.min(chairs,barbers):Math.max(chairs,barbers,1);
    if(Number(cap?.busy||0)>=capacity){
      const e:any=new Error('The salon is fully booked for the selected time. Please choose another time.');e.statusCode=409;throw e;
    }
  }
  return{durationMinutes:duration,endAt};
}

function nextQueue(rows:any[]){
  return rows.reduce((m,r)=>Math.max(m,Number(r.queue_number||0)),0)+1;
}

async function salonDashboard(db:Db,orgId:string,shopId?:string,branchId?:string){
  const params=[orgId,shopId||null,branchId||null];
  const q=await db.query(`
    SELECT
      (SELECT count(*)::int FROM shop_bookings x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.booked_for::date=CURRENT_DATE) appointments_today,
      (SELECT count(*)::int FROM shop_bookings x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.booked_for::date=CURRENT_DATE AND x.appointment_type='walk_in') walkins_today,
      (SELECT count(*)::int FROM shop_bookings x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.booked_for::date=CURRENT_DATE AND x.status IN ('queued','checked_in')) waiting_now,
      (SELECT count(*)::int FROM salon_chairs x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.status='available') available_chairs,
      (SELECT count(*)::int FROM salon_staff x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3 OR x.branch_id IS NULL)
         AND x.role='barber' AND x.status='active') active_barbers,
      (SELECT coalesce(sum(x.amount),0) FROM shop_payments x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.status='successful' AND x.created_at::date=CURRENT_DATE) revenue_today,
      (SELECT coalesce(sum(x.commission_amount),0) FROM salon_commission_entries x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.earned_at::date=CURRENT_DATE) commissions_today,
      (SELECT coalesce(avg(extract(epoch from (x.service_started_at-x.check_in_at))/60),0) FROM shop_bookings x
       WHERE x.organisation_id=$1 AND ($2::uuid IS NULL OR x.shop_id=$2) AND ($3::uuid IS NULL OR x.branch_id=$3)
         AND x.check_in_at IS NOT NULL AND x.service_started_at IS NOT NULL AND x.booked_for::date=CURRENT_DATE) avg_wait_minutes
  `,params);
  return q.rows[0];
}

export async function registerSalonRoutes(app:FastifyInstance,{db,config}:{db:Db;config:ShopConfig}){
  app.get('/api/salon/bootstrap',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'dashboard.read');
    const query=z.object({shopId:uuid.optional(),branchId:uuid.optional()}).parse(req.query);
    const params=[a.core.organisation_id,query.shopId||null,query.branchId||null];
    if(query.branchId&&query.shopId){
      const branch=await maybeOne<any>(db,
        'SELECT id FROM shop_branches WHERE id=$1 AND shop_id=$2 AND organisation_id=$3',
        [query.branchId,query.shopId,a.core.organisation_id]
      );
      if(!branch)return reply.code(400).send({error:{message:'Selected branch does not belong to this shop.'}});
    }

    const empty=()=>Promise.resolve({rows:[]} as any);
    const canAppointments=['shop_admin','manager','cashier','service'].includes(a.role);
    const canFinance=['shop_admin','finance','auditor'].includes(a.role);
    const canFinancialStats=['shop_admin','manager','cashier','finance','auditor'].includes(a.role);

    const [staff,chairs,appointments,commissions,eod,rawStats]=await Promise.all([
      db.query(
        `SELECT * FROM salon_staff x
         WHERE x.organisation_id=$1
           AND ($2::uuid IS NULL OR x.shop_id=$2)
           AND ($3::uuid IS NULL OR x.branch_id=$3 OR x.branch_id IS NULL)
         ORDER BY x.role,x.full_name`,params),
      db.query(
        `SELECT * FROM salon_chairs x
         WHERE x.organisation_id=$1
           AND ($2::uuid IS NULL OR x.shop_id=$2)
           AND ($3::uuid IS NULL OR x.branch_id=$3)
         ORDER BY x.name`,params),
      canAppointments?db.query(
        `SELECT b.*,s.name service_name,st.full_name barber_name,ch.name chair_name
         FROM shop_bookings b
         LEFT JOIN shop_services s ON s.id=b.service_id
         LEFT JOIN salon_staff st ON st.id=b.salon_staff_id
         LEFT JOIN salon_chairs ch ON ch.id=b.salon_chair_id
         WHERE b.organisation_id=$1
           AND ($2::uuid IS NULL OR b.shop_id=$2)
           AND ($3::uuid IS NULL OR b.branch_id=$3)
           AND b.booked_for::date BETWEEN CURRENT_DATE-7 AND CURRENT_DATE+30
         ORDER BY b.booked_for`,params):empty(),
      canFinance?db.query(
        `SELECT ce.*,st.full_name barber_name
         FROM salon_commission_entries ce
         JOIN salon_staff st ON st.id=ce.staff_id
         WHERE ce.organisation_id=$1
           AND ($2::uuid IS NULL OR ce.shop_id=$2)
           AND ($3::uuid IS NULL OR ce.branch_id=$3)
         ORDER BY ce.earned_at DESC LIMIT 250`,params):empty(),
      canFinance?db.query(
        `SELECT * FROM salon_eod_closures x
         WHERE x.organisation_id=$1
           AND ($2::uuid IS NULL OR x.shop_id=$2)
           AND ($3::uuid IS NULL OR x.branch_id=$3)
         ORDER BY x.business_date DESC LIMIT 45`,params):empty(),
      salonDashboard(db,a.core.organisation_id,query.shopId,query.branchId)
    ]);

    const stats={...rawStats};
    if(!canFinancialStats){
      stats.revenue_today=null;
      stats.commissions_today=null;
    }
    if(!canFinance)stats.commissions_today=null;

    const canSeeCommission=['shop_admin','manager','finance','auditor'].includes(a.role);
    const staffRows=canSeeCommission
      ? staff.rows
      : staff.rows.map((row:any)=>({...row,commission_percent:null}));

    return{
      staff:staffRows,
      chairs:chairs.rows,
      appointments:appointments.rows,
      commissions:commissions.rows,
      eod:eod.rows,
      stats
    };
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
      customerName:z.string().trim().min(2),phone:z.string().trim().optional(),email:z.string().email().optional().or(z.literal('')),
      bookedFor:z.coerce.date(),staffId:uuid.optional(),chairId:uuid.optional(),
      appointmentType:z.enum(['appointment','walk_in']).default('appointment'),notes:z.string().max(2000).optional()
    }).parse(req.body);

    let branchId=b.branchId||null;
    if(!branchId){
      const primary=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE organisation_id=$1 AND shop_id=$2 AND status='active' ORDER BY created_at LIMIT 1",[a.core.organisation_id,b.shopId]);
      branchId=primary?.id||null;
    }
    if(!branchId)return reply.code(409).send({error:{message:'Create an active salon branch before adding appointments.'}});

    const branch=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND status='active'",[branchId,b.shopId,a.core.organisation_id]);
    if(!branch)return reply.code(400).send({error:{message:'Selected branch is not available.'}});
    if(b.serviceId){
      const service=await maybeOne<any>(db,"SELECT id FROM shop_services WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND active=true",[b.serviceId,b.shopId,a.core.organisation_id]);
      if(!service)return reply.code(400).send({error:{message:'Selected service is not available.'}});
    }
    if(b.staffId){
      const staff=await maybeOne<any>(db,"SELECT id FROM salon_staff WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND status='active' AND (branch_id=$4 OR branch_id IS NULL)",[b.staffId,b.shopId,a.core.organisation_id,branchId]);
      if(!staff)return reply.code(400).send({error:{message:'Selected staff member is not available at this branch.'}});
    }
    if(b.chairId){
      const chair=await maybeOne<any>(db,"SELECT id FROM salon_chairs WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND branch_id=$4 AND status<>'maintenance'",[b.chairId,b.shopId,a.core.organisation_id,branchId]);
      if(!chair)return reply.code(400).send({error:{message:'Selected chair is not available at this branch.'}});
    }

    await assertSalonBookingAvailability(db,{
      organisationId:a.core.organisation_id,
      shopId:b.shopId,
      branchId,
      bookedFor:b.bookedFor,
      serviceId:b.serviceId||null,
      staffId:b.staffId||null,
      chairId:b.chairId||null
    });

    const appointment=await tx(db,async client=>{
      let customerId=b.customerId||null;
      if(customerId){
        const owns=await maybeOne<any>(client,'SELECT id FROM shop_customers WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND status=\'active\'',[customerId,b.shopId,a.core.organisation_id]);
        if(!owns)throw Object.assign(new Error('Selected customer is not active for this shop.'),{statusCode:400});
      }else if((b.phone&&b.phone.length>=6)||b.email){
        const existing=await maybeOne<any>(client,`
          SELECT id FROM shop_customers
          WHERE shop_id=$1 AND organisation_id=$2 AND status='active'
            AND (($3<>'' AND phone=$3) OR ($4<>'' AND lower(email)=lower($4)))
          ORDER BY created_at LIMIT 1`,
          [b.shopId,a.core.organisation_id,b.phone||'',b.email||'']
        );
        if(existing)customerId=existing.id;
        else{
          const created=await client.query(`
            INSERT INTO shop_customers(organisation_id,shop_id,branch_id,customer_no,name,phone,email,customer_type,status)
            VALUES($1,$2,$3,'CUS-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),$4,$5,$6,'retail','active')
            RETURNING id`,
            [a.core.organisation_id,b.shopId,branchId,b.customerName,b.phone||null,b.email||null]
          );
          customerId=created.rows[0].id;
        }
      }

      let queueNo:null|number=null;
      let status='booked';
      if(b.appointmentType==='walk_in'){
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",['salon-queue:'+b.shopId+':'+branchId]);
        const q=await client.query(`
          SELECT coalesce(max(queue_number),0)::int+1 next_no
          FROM shop_bookings
          WHERE organisation_id=$1 AND shop_id=$2 AND branch_id=$3
            AND booked_for::date=CURRENT_DATE AND appointment_type='walk_in'`,
          [a.core.organisation_id,b.shopId,branchId]
        );
        queueNo=Number(q.rows[0]?.next_no||1);
        status='queued';
      }

      const r=await client.query(`
        INSERT INTO shop_bookings(
          organisation_id,shop_id,branch_id,service_id,customer_id,customer_name,phone,email,
          booked_for,notes,status,salon_staff_id,salon_chair_id,appointment_type,queue_number,
          check_in_at,estimated_wait_minutes,source
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          CASE WHEN $14='walk_in' THEN now() ELSE NULL END,
          CASE WHEN $14='walk_in' THEN 15 ELSE 0 END,'staff')
        RETURNING *`,
        [a.core.organisation_id,b.shopId,branchId,b.serviceId||null,customerId,b.customerName,b.phone||null,b.email||null,b.bookedFor,b.notes||null,status,b.staffId||null,b.chairId||null,b.appointmentType,queueNo]
      );
      return r.rows[0];
    });

    return reply.code(201).send(appointment);
  });

  app.patch('/api/salon/appointments/:id',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({
      branchId:uuid.optional(),
      serviceId:uuid.optional().nullable(),
      staffId:uuid.optional().nullable(),
      chairId:uuid.optional().nullable(),
      bookedFor:z.coerce.date().optional(),
      customerName:z.string().trim().min(2).optional(),
      phone:z.string().trim().optional().nullable(),
      email:z.string().email().optional().or(z.literal('')).nullable(),
      notes:z.string().max(2000).optional().nullable()
    }).parse(req.body);

    const current=await maybeOne<any>(db,'SELECT * FROM shop_bookings WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(!current)return reply.code(404).send({error:{message:'Appointment not found'}});
    if(['in_chair','completed','cancelled','no_show'].includes(current.status)){
      return reply.code(409).send({error:{message:'This appointment can no longer be rescheduled or edited.'}});
    }

    const branchId=b.branchId??current.branch_id;
    const serviceId=Object.prototype.hasOwnProperty.call(b,'serviceId')?b.serviceId:current.service_id;
    const staffId=Object.prototype.hasOwnProperty.call(b,'staffId')?b.staffId:current.salon_staff_id;
    const chairId=Object.prototype.hasOwnProperty.call(b,'chairId')?b.chairId:current.salon_chair_id;
    const bookedFor=b.bookedFor??new Date(current.booked_for);

    if(branchId){
      const branch=await maybeOne<any>(db,"SELECT id FROM shop_branches WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND status='active'",[branchId,current.shop_id,a.core.organisation_id]);
      if(!branch)return reply.code(400).send({error:{message:'Selected branch is not available.'}});
    }
    if(serviceId){
      const service=await maybeOne<any>(db,"SELECT id FROM shop_services WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND active=true",[serviceId,current.shop_id,a.core.organisation_id]);
      if(!service)return reply.code(400).send({error:{message:'Selected service is not available.'}});
    }
    if(staffId){
      const staff=await maybeOne<any>(db,"SELECT id FROM salon_staff WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND status='active' AND ($4::uuid IS NULL OR branch_id=$4 OR branch_id IS NULL)",[staffId,current.shop_id,a.core.organisation_id,branchId]);
      if(!staff)return reply.code(400).send({error:{message:'Selected staff member is not available at this branch.'}});
    }
    if(chairId){
      const chair=await maybeOne<any>(db,"SELECT id FROM salon_chairs WHERE id=$1 AND shop_id=$2 AND organisation_id=$3 AND ($4::uuid IS NULL OR branch_id=$4) AND status<>'maintenance'",[chairId,current.shop_id,a.core.organisation_id,branchId]);
      if(!chair)return reply.code(400).send({error:{message:'Selected chair is not available at this branch.'}});
    }

    await assertSalonBookingAvailability(db,{
      organisationId:a.core.organisation_id,
      shopId:current.shop_id,
      branchId:branchId||null,
      bookedFor,
      serviceId:serviceId||null,
      staffId:staffId||null,
      chairId:chairId||null,
      ignoreBookingId:id
    });

    const r=await db.query(`
      UPDATE shop_bookings SET
        branch_id=$1,
        service_id=$2,
        salon_staff_id=$3,
        salon_chair_id=$4,
        booked_for=$5,
        customer_name=coalesce($6,customer_name),
        phone=CASE WHEN $7 THEN $8 ELSE phone END,
        email=CASE WHEN $9 THEN $10 ELSE email END,
        notes=CASE WHEN $11 THEN $12 ELSE notes END
      WHERE id=$13 AND organisation_id=$14
      RETURNING *`,
      [
        branchId||null,serviceId||null,staffId||null,chairId||null,bookedFor,
        b.customerName??null,Object.prototype.hasOwnProperty.call(b,'phone'),b.phone??null,
        Object.prototype.hasOwnProperty.call(b,'email'),b.email||null,
        Object.prototype.hasOwnProperty.call(b,'notes'),b.notes??null,
        id,a.core.organisation_id
      ]
    );
    return r.rows[0];
  });

  app.patch('/api/salon/appointments/:id/status',async(req,reply)=>{
    const a=await authorize(db,config,req,reply,'bookings.manage');
    const id=uuid.parse((req.params as any).id);
    const b=z.object({
      status:z.enum(['booked','queued','checked_in','in_chair','completed','cancelled','no_show']),
      staffId:uuid.optional(),
      chairId:uuid.optional()
    }).parse(req.body);

    const result=await tx(db,async client=>{
      const old=await client.query(
        'SELECT * FROM shop_bookings WHERE id=$1 AND organisation_id=$2 FOR UPDATE',
        [id,a.core.organisation_id]
      );
      if(!old.rowCount)return null;
      const row=old.rows[0];
      if(row.status===b.status)return row;

      const transitions:Record<string,string[]>={
        booked:['checked_in','in_chair','cancelled','no_show'],
        queued:['checked_in','in_chair','cancelled','no_show'],
        checked_in:['in_chair','cancelled','no_show'],
        in_chair:['completed','cancelled'],
        completed:[],
        cancelled:[],
        no_show:[]
      };
      if(!(transitions[row.status]||[]).includes(b.status)){
        throw Object.assign(new Error('Invalid appointment status transition from '+row.status+' to '+b.status+'.'),{statusCode:409});
      }

      let staffId=b.staffId||row.salon_staff_id||null;
      let chairId=b.chairId||row.salon_chair_id||null;

      if(b.status==='in_chair'){
        if(staffId){
          const staff=await client.query(
            `SELECT * FROM salon_staff
             WHERE id=$1 AND organisation_id=$2 AND shop_id=$3
               AND status='active' AND role='barber'
               AND (branch_id=$4 OR branch_id IS NULL)
             FOR UPDATE`,
            [staffId,a.core.organisation_id,row.shop_id,row.branch_id]
          );
          if(!staff.rowCount)throw Object.assign(new Error('Selected barber is not available for this branch.'),{statusCode:409});
          const busy=await client.query(
            "SELECT 1 FROM shop_bookings WHERE organisation_id=$1 AND shop_id=$2 AND id<>$3 AND salon_staff_id=$4 AND status='in_chair' LIMIT 1",
            [a.core.organisation_id,row.shop_id,id,staffId]
          );
          if(busy.rowCount)throw Object.assign(new Error('Selected barber is currently serving another customer.'),{statusCode:409});
        }else{
          const staff=await client.query(
            `SELECT st.id
             FROM salon_staff st
             WHERE st.organisation_id=$1 AND st.shop_id=$2
               AND st.status='active' AND st.role='barber'
               AND (st.branch_id=$3 OR st.branch_id IS NULL)
               AND NOT EXISTS(
                 SELECT 1 FROM shop_bookings b
                 WHERE b.organisation_id=$1 AND b.shop_id=$2
                   AND b.salon_staff_id=st.id AND b.status='in_chair'
               )
             ORDER BY st.full_name
             FOR UPDATE OF st SKIP LOCKED
             LIMIT 1`,
            [a.core.organisation_id,row.shop_id,row.branch_id]
          );
          if(!staff.rowCount)throw Object.assign(new Error('No barber is currently available to start this service.'),{statusCode:409});
          staffId=staff.rows[0].id;
        }

        if(chairId){
          const chair=await client.query(
            `SELECT * FROM salon_chairs
             WHERE id=$1 AND organisation_id=$2 AND shop_id=$3 AND branch_id=$4
             FOR UPDATE`,
            [chairId,a.core.organisation_id,row.shop_id,row.branch_id]
          );
          if(!chair.rowCount||!['available','occupied'].includes(chair.rows[0].status)){
            throw Object.assign(new Error('Selected chair is not available.'),{statusCode:409});
          }
          if(chair.rows[0].status==='occupied'){
            const occupiedByOther=await client.query(
              "SELECT 1 FROM shop_bookings WHERE organisation_id=$1 AND shop_id=$2 AND id<>$3 AND salon_chair_id=$4 AND status='in_chair' LIMIT 1",
              [a.core.organisation_id,row.shop_id,id,chairId]
            );
            if(occupiedByOther.rowCount)throw Object.assign(new Error('Selected chair is currently occupied.'),{statusCode:409});
          }
        }else{
          const chair=await client.query(
            `SELECT ch.id
             FROM salon_chairs ch
             WHERE ch.organisation_id=$1 AND ch.shop_id=$2 AND ch.branch_id=$3
               AND ch.status='available'
             ORDER BY ch.name
             FOR UPDATE OF ch SKIP LOCKED
             LIMIT 1`,
            [a.core.organisation_id,row.shop_id,row.branch_id]
          );
          if(!chair.rowCount)throw Object.assign(new Error('No barber chair is currently available.'),{statusCode:409});
          chairId=chair.rows[0].id;
        }
      }

      const upd=await client.query(`
        UPDATE shop_bookings SET
          status=$1,
          salon_staff_id=coalesce($2,salon_staff_id),
          salon_chair_id=coalesce($3,salon_chair_id),
          check_in_at=CASE WHEN $1='checked_in' AND check_in_at IS NULL THEN now() ELSE check_in_at END,
          service_started_at=CASE WHEN $1='in_chair' AND service_started_at IS NULL THEN now() ELSE service_started_at END,
          service_completed_at=CASE WHEN $1='completed' AND service_completed_at IS NULL THEN now() ELSE service_completed_at END
        WHERE id=$4
        RETURNING *`,
        [b.status,staffId,chairId,id]
      );
      const current=upd.rows[0];

      if(b.status==='in_chair'&&current.salon_chair_id){
        await client.query("UPDATE salon_chairs SET status='occupied' WHERE id=$1",[current.salon_chair_id]);
      }
      if(['completed','cancelled','no_show'].includes(b.status)&&current.salon_chair_id){
        await client.query(
          `UPDATE salon_chairs SET status='available'
           WHERE id=$1 AND status='occupied'`,
          [current.salon_chair_id]
        );
      }

      if(b.status==='completed'&&current.salon_staff_id){
        const service=await maybeOne<any>(client,'SELECT price FROM shop_services WHERE id=$1',[current.service_id]);
        const staff=await maybeOne<any>(client,'SELECT commission_percent FROM salon_staff WHERE id=$1',[current.salon_staff_id]);
        const gross=Number(service?.price||0);
        const pct=Number(staff?.commission_percent||0);
        await client.query(`
          INSERT INTO salon_commission_entries(
            organisation_id,shop_id,branch_id,staff_id,booking_id,gross_amount,
            commission_percent,commission_amount,status,note
          )
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,'earned','Service completion'
          WHERE NOT EXISTS(SELECT 1 FROM salon_commission_entries WHERE booking_id=$5)`,
          [a.core.organisation_id,current.shop_id,current.branch_id,current.salon_staff_id,id,gross,pct,gross*pct/100]
        );
        if(current.customer_id){
          await client.query(`
            INSERT INTO salon_customer_preferences(
              organisation_id,shop_id,customer_id,preferred_staff_id,preferred_service_id,last_visit_at,visit_count
            )
            VALUES($1,$2,$3,$4,$5,now(),1)
            ON CONFLICT(shop_id,customer_id) DO UPDATE SET
              preferred_staff_id=EXCLUDED.preferred_staff_id,
              preferred_service_id=EXCLUDED.preferred_service_id,
              last_visit_at=now(),
              visit_count=salon_customer_preferences.visit_count+1,
              updated_at=now()`,
            [a.core.organisation_id,current.shop_id,current.customer_id,current.salon_staff_id,current.service_id]
          );
        }
      }

      await client.query(
        `INSERT INTO shop_audit_logs(
          organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,branch_id,metadata
        )
        VALUES($1,$2,'appointment.status_changed','booking',$3,$4,$5,$6)`,
        [a.core.organisation_id,a.core.id,id,current.shop_id,current.branch_id,JSON.stringify({from:row.status,to:b.status,staffId:current.salon_staff_id,chairId:current.salon_chair_id})]
      );
      return current;
    });

    if(!result)return reply.code(404).send({error:{message:'Appointment not found'}});
    return result;
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
