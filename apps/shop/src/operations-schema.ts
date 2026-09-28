import type { Db } from './db.js';

export async function ensureShopOperationsSchema(db:Db){
  await db.query(`
    CREATE TABLE IF NOT EXISTS shop_business_days(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid NOT NULL REFERENCES shop_branches(id) ON DELETE CASCADE,
      business_date date NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),
      opening_cash numeric(14,2) NOT NULL DEFAULT 0,
      expected_cash numeric(14,2),
      actual_cash numeric(14,2),
      variance numeric(14,2),
      opened_by uuid,
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_by uuid,
      closed_at timestamptz,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,branch_id,business_date)
    );

    CREATE TABLE IF NOT EXISTS shop_cashier_sessions(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid NOT NULL REFERENCES shop_branches(id) ON DELETE CASCADE,
      business_day_id uuid NOT NULL REFERENCES shop_business_days(id) ON DELETE RESTRICT,
      cashier_user_id uuid NOT NULL,
      session_no text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK(status IN('open','handed_over','closed')),
      opening_cash numeric(14,2) NOT NULL DEFAULT 0,
      expected_cash numeric(14,2),
      actual_cash numeric(14,2),
      variance numeric(14,2),
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      end_reason text CHECK(end_reason IN('handover','shift_end','end_day')),
      handover_to_user_id uuid,
      previous_session_id uuid REFERENCES shop_cashier_sessions(id) ON DELETE SET NULL,
      handover_note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_shop_cashier_one_open_branch
      ON shop_cashier_sessions(shop_id,branch_id)
      WHERE status='open';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_shop_cashier_one_open_user
      ON shop_cashier_sessions(organisation_id,cashier_user_id)
      WHERE status='open';
    CREATE INDEX IF NOT EXISTS idx_shop_cashier_sessions_day
      ON shop_cashier_sessions(business_day_id,started_at);

    CREATE TABLE IF NOT EXISTS shop_staff_leave_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      applicant_user_id uuid,
      salon_staff_id uuid REFERENCES salon_staff(id) ON DELETE SET NULL,
      leave_type text NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      reason text NOT NULL,
      relief_staff_id uuid REFERENCES salon_staff(id) ON DELETE SET NULL,
      relief_notes text,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled')),
      requested_by uuid,
      requested_at timestamptz NOT NULL DEFAULT now(),
      reviewed_by uuid,
      reviewed_at timestamptz,
      review_note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(end_date>=start_date),
      CHECK(applicant_user_id IS NOT NULL OR salon_staff_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_leave_status ON shop_staff_leave_requests(organisation_id,status,start_date);

    CREATE TABLE IF NOT EXISTS shop_notifications(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      entity_type text,
      entity_id uuid,
      target_role text,
      target_user_id uuid,
      priority text NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high','urgent')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS shop_notification_reads(
      notification_id uuid NOT NULL REFERENCES shop_notifications(id) ON DELETE CASCADE,
      os_user_id uuid NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(notification_id,os_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_notifications_org ON shop_notifications(organisation_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS shop_gallery_media(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      title text NOT NULL,
      description text,
      category text,
      media_type text NOT NULL CHECK(media_type IN('image','video')),
      content_type text,
      file_data bytea,
      external_url text,
      service_id uuid REFERENCES shop_services(id) ON DELETE SET NULL,
      staff_id uuid REFERENCES salon_staff(id) ON DELETE SET NULL,
      is_published boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      uploaded_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(file_data IS NOT NULL OR external_url IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_gallery_public ON shop_gallery_media(shop_id,is_published,sort_order,created_at DESC);

    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS inspiration_media_id uuid REFERENCES shop_gallery_media(id) ON DELETE SET NULL;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS request_seen_at timestamptz;
    ALTER TABLE shop_bookings ADD COLUMN IF NOT EXISTS request_seen_by uuid;

    CREATE TABLE IF NOT EXISTS shop_customer_payment_preferences(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
      preferred_method text NOT NULL DEFAULT 'mobile_money' CHECK(preferred_method IN('cash','mobile_money','card','bank_transfer')),
      momo_phone text,
      receipt_email text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_shop_bookings_unseen_requests
      ON shop_bookings(organisation_id,shop_id,request_seen_at,created_at DESC)
      WHERE source IN('public','customer_portal');

    CREATE OR REPLACE FUNCTION shop_notify_external_booking() RETURNS trigger AS $$
    BEGIN
      IF NEW.source IN ('public','customer_portal') THEN
        INSERT INTO shop_notifications(
          organisation_id,shop_id,branch_id,event_type,title,message,entity_type,entity_id,priority
        ) VALUES(
          NEW.organisation_id,NEW.shop_id,NEW.branch_id,'booking.request',
          CASE WHEN NEW.source='customer_portal' THEN 'Customer booked an appointment' ELSE 'New public booking request' END,
          coalesce(NEW.customer_name,'Customer')||' requested an appointment for '||to_char(NEW.booked_for,'DD Mon YYYY HH24:MI'),
          'booking',NEW.id,'high'
        );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_shop_notify_external_booking ON shop_bookings;
    CREATE TRIGGER trg_shop_notify_external_booking
      AFTER INSERT ON shop_bookings
      FOR EACH ROW EXECUTE FUNCTION shop_notify_external_booking();

    INSERT INTO shop_capabilities(key,name,module,description,sort_order) VALUES
      ('cashier.session','Cashier Session','Commerce','Start, hand over and close cashier sessions',73),
      ('leave.manage','Leave Requests','People','Create and view staff leave requests',115),
      ('leave.review','Leave Approval','People','Approve or reject staff leave and relief plans',116),
      ('media.manage','Gallery Media','Marketing','Manage public inspiration photos and videos',117),
      ('notifications.read','Notifications','Operations','View operational alerts and booking notifications',118)
    ON CONFLICT(key) DO UPDATE SET
      name=EXCLUDED.name,module=EXCLUDED.module,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;
  `);
}
