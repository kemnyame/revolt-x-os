import type { Db } from './db.js';

export async function ensureShopSchema(db:Db){
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS shop_memberships(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      os_user_id uuid NOT NULL,
      role text NOT NULL DEFAULT 'shop_admin',
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,os_user_id)
    );

    CREATE TABLE IF NOT EXISTS shops(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      name text NOT NULL,
      slug text NOT NULL,
      public_slug text,
      business_type text NOT NULL DEFAULT 'general_service',
      currency text NOT NULL DEFAULT 'GHS',
      phone text,
      email text,
      address text,
      status text NOT NULL DEFAULT 'active',
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,slug)
    );

    CREATE TABLE IF NOT EXISTS shop_branches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name text NOT NULL,
      code text,
      phone text,
      email text,
      address text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,name)
    );

    CREATE TABLE IF NOT EXISTS shop_customers(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      customer_no text,
      name text NOT NULL,
      phone text,
      email text,
      address text,
      customer_type text NOT NULL DEFAULT 'retail',
      loyalty_points numeric(14,2) NOT NULL DEFAULT 0,
      credit_limit numeric(14,2) NOT NULL DEFAULT 0,
      notes text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_services(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name text NOT NULL,
      category text,
      description text,
      price numeric(14,2) NOT NULL DEFAULT 0,
      duration_minutes integer NOT NULL DEFAULT 30,
      deposit_percent numeric(6,2) NOT NULL DEFAULT 0,
      workflow_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_products(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      sku text,
      barcode text,
      name text NOT NULL,
      category text,
      cost_price numeric(14,2) NOT NULL DEFAULT 0,
      selling_price numeric(14,2) NOT NULL DEFAULT 0,
      stock_quantity numeric(14,3) NOT NULL DEFAULT 0,
      reorder_level numeric(14,3) NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,sku)
    );

    CREATE TABLE IF NOT EXISTS shop_bookings(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      service_id uuid REFERENCES shop_services(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      customer_name text NOT NULL,
      phone text,
      email text,
      booked_for timestamptz NOT NULL,
      notes text,
      status text NOT NULL DEFAULT 'booked',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_jobs(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      service_id uuid REFERENCES shop_services(id) ON DELETE SET NULL,
      booking_id uuid REFERENCES shop_bookings(id) ON DELETE SET NULL,
      job_no text NOT NULL,
      title text NOT NULL,
      status text NOT NULL DEFAULT 'received',
      assigned_os_user_id uuid,
      expected_completion timestamptz,
      labour_cost numeric(14,2) NOT NULL DEFAULT 0,
      material_cost numeric(14,2) NOT NULL DEFAULT 0,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,job_no)
    );

    CREATE TABLE IF NOT EXISTS shop_orders(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      job_id uuid REFERENCES shop_jobs(id) ON DELETE SET NULL,
      booking_id uuid REFERENCES shop_bookings(id) ON DELETE SET NULL,
      order_no text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      subtotal numeric(14,2) NOT NULL DEFAULT 0,
      discount numeric(14,2) NOT NULL DEFAULT 0,
      tax numeric(14,2) NOT NULL DEFAULT 0,
      total numeric(14,2) NOT NULL DEFAULT 0,
      amount_paid numeric(14,2) NOT NULL DEFAULT 0,
      balance numeric(14,2) NOT NULL DEFAULT 0,
      notes text,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,order_no)
    );

    CREATE TABLE IF NOT EXISTS shop_order_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
      item_type text NOT NULL,
      item_id uuid,
      description text NOT NULL,
      quantity numeric(14,3) NOT NULL DEFAULT 1,
      unit_price numeric(14,2) NOT NULL DEFAULT 0,
      line_total numeric(14,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shop_payments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      order_id uuid REFERENCES shop_orders(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      reference text NOT NULL,
      provider text NOT NULL DEFAULT 'manual',
      provider_reference text,
      method text NOT NULL,
      amount numeric(14,2) NOT NULL,
      fee numeric(14,2) NOT NULL DEFAULT 0,
      settlement_amount numeric(14,2),
      currency text NOT NULL DEFAULT 'GHS',
      status text NOT NULL DEFAULT 'pending',
      payer_phone text,
      payer_email text,
      paid_at timestamptz,
      settled_at timestamptz,
      raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,reference)
    );

    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS reversed_by uuid;
    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS reversal_reason text;

    CREATE TABLE IF NOT EXISTS shop_payment_events(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      event_key text NOT NULL,
      payload jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(provider,event_key)
    );

    CREATE TABLE IF NOT EXISTS shop_expenses(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      category text NOT NULL,
      description text NOT NULL,
      amount numeric(14,2) NOT NULL,
      payment_method text NOT NULL DEFAULT 'cash',
      reference text,
      expense_date date NOT NULL DEFAULT CURRENT_DATE,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_ledger_entries(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      entry_date date NOT NULL DEFAULT CURRENT_DATE,
      account_code text NOT NULL,
      account_name text NOT NULL,
      debit numeric(14,2) NOT NULL DEFAULT 0,
      credit numeric(14,2) NOT NULL DEFAULT 0,
      source_type text NOT NULL,
      source_id uuid,
      reference text,
      description text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_stock_movements(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
      movement_type text NOT NULL,
      quantity numeric(14,3) NOT NULL,
      source_type text,
      source_id uuid,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_audit_logs(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      actor_os_user_id uuid,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id uuid,
      shop_id uuid,
      branch_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE shops ADD COLUMN IF NOT EXISTS public_slug text;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_shops_public_slug ON shops(public_slug) WHERE public_slug IS NOT NULL;


    CREATE TABLE IF NOT EXISTS shop_password_reset_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      completed_by uuid
    );

    CREATE INDEX IF NOT EXISTS idx_shop_password_reset_status ON shop_password_reset_requests(status,requested_at DESC);

    CREATE TABLE IF NOT EXISTS shop_bootstrap_state(
      key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_shop_customers_org_shop ON shop_customers(organisation_id,shop_id);
    ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES shop_bookings(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_shop_orders_booking ON shop_orders(booking_id) WHERE booking_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_shop_orders_org_created ON shop_orders(organisation_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_payments_org_created ON shop_payments(organisation_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_jobs_org_status ON shop_jobs(organisation_id,status);
    CREATE INDEX IF NOT EXISTS idx_shop_bookings_org_date ON shop_bookings(organisation_id,booked_for);
    CREATE INDEX IF NOT EXISTS idx_shop_ledger_org_date ON shop_ledger_entries(organisation_id,entry_date);
  `);
}
