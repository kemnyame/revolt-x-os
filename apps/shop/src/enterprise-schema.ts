import type { Db } from './db.js';

export async function ensureEnterpriseShopSchema(db:Db){
  await db.query(`
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS last_visit_at timestamptz;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS inactive_at timestamptz;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS reactivation_at timestamptz;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS portal_registered_at timestamptz;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT true;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT true;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS sms_opt_in boolean NOT NULL DEFAULT true;
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
    ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS shop_roles(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      key text NOT NULL,
      name text NOT NULL,
      description text,
      portal_mode text NOT NULL DEFAULT 'admin',
      is_system boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,key)
    );

    CREATE TABLE IF NOT EXISTS shop_capabilities(
      key text PRIMARY KEY,
      name text NOT NULL,
      module text NOT NULL,
      description text,
      sort_order integer NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shop_role_capabilities(
      organisation_id uuid NOT NULL,
      role text NOT NULL,
      capability_key text NOT NULL REFERENCES shop_capabilities(key) ON DELETE CASCADE,
      allowed boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(organisation_id,role,capability_key)
    );

    CREATE TABLE IF NOT EXISTS shop_approval_policies(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      action_key text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      minimum_approvals integer NOT NULL DEFAULT 1 CHECK(minimum_approvals>=1),
      approver_roles text[] NOT NULL DEFAULT ARRAY['shop_admin','manager']::text[],
      self_approval_allowed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,shop_id,action_key)
    );

    CREATE TABLE IF NOT EXISTS shop_approval_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      action_key text NOT NULL,
      target_type text NOT NULL,
      target_id uuid,
      request_title text NOT NULL,
      reason text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled','applied','failed')),
      requested_by uuid NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      applied_at timestamptz,
      apply_error text
    );

    CREATE TABLE IF NOT EXISTS shop_approval_actions(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES shop_approval_requests(id) ON DELETE CASCADE,
      action text NOT NULL CHECK(action IN('approve','reject','cancel','comment')),
      actor_os_user_id uuid NOT NULL,
      comment text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_shop_approval_single_vote
      ON shop_approval_actions(request_id,actor_os_user_id)
      WHERE action IN('approve','reject');

    CREATE TABLE IF NOT EXISTS shop_customer_portal_accounts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
      email text,
      phone text,
      password_hash text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      registered_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz,
      UNIQUE(shop_id,customer_id),
      UNIQUE(shop_id,email)
    );

    CREATE TABLE IF NOT EXISTS shop_customer_sessions(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES shop_customer_portal_accounts(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      user_agent text,
      ip_address text,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS shop_customer_discounts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
      code text,
      discount_type text NOT NULL DEFAULT 'percent' CHECK(discount_type IN('percent','fixed')),
      discount_value numeric(14,2) NOT NULL CHECK(discount_value>0),
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK(status IN('active','redeemed','expired','cancelled')),
      valid_from timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      redeemed_order_id uuid REFERENCES shop_orders(id) ON DELETE SET NULL,
      redeemed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_conversations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app' CHECK(channel IN('in_app','whatsapp','sms','email')),
      subject text,
      status text NOT NULL DEFAULT 'open' CHECK(status IN('open','waiting','closed')),
      assigned_os_user_id uuid,
      last_message_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_messages(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL REFERENCES shop_conversations(id) ON DELETE CASCADE,
      sender_type text NOT NULL CHECK(sender_type IN('customer','staff','system')),
      sender_id uuid,
      channel text NOT NULL DEFAULT 'in_app',
      body text NOT NULL,
      delivery_status text NOT NULL DEFAULT 'sent' CHECK(delivery_status IN('queued','sent','delivered','failed','read')),
      external_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_communication_outbox(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      channel text NOT NULL CHECK(channel IN('sms','whatsapp','email')),
      recipient text NOT NULL,
      subject text,
      body text NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','sending','sent','failed','cancelled')),
      provider text,
      provider_message_id text,
      attempt_count integer NOT NULL DEFAULT 0,
      last_error text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      scheduled_for timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_notification_rules(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      event_key text NOT NULL,
      channel text NOT NULL CHECK(channel IN('sms','whatsapp','email','in_app')),
      enabled boolean NOT NULL DEFAULT true,
      template_text text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,shop_id,event_key,channel)
    );

    CREATE TABLE IF NOT EXISTS shop_assets(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      asset_no text NOT NULL,
      name text NOT NULL,
      category text NOT NULL,
      brand text,
      model text,
      serial_number text,
      purchase_date date,
      purchase_cost numeric(14,2) NOT NULL DEFAULT 0,
      current_value numeric(14,2),
      condition text NOT NULL DEFAULT 'good',
      status text NOT NULL DEFAULT 'active' CHECK(status IN('active','maintenance','retired','lost','disposed')),
      assigned_staff_id uuid REFERENCES salon_staff(id) ON DELETE SET NULL,
      next_service_date date,
      warranty_expiry date,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,asset_no)
    );

    CREATE TABLE IF NOT EXISTS shop_asset_maintenance(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      asset_id uuid NOT NULL REFERENCES shop_assets(id) ON DELETE CASCADE,
      maintenance_date date NOT NULL DEFAULT CURRENT_DATE,
      maintenance_type text NOT NULL,
      description text,
      cost numeric(14,2) NOT NULL DEFAULT 0,
      vendor_name text,
      next_service_date date,
      status text NOT NULL DEFAULT 'completed',
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_inventory_alerts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      alert_type text NOT NULL CHECK(alert_type IN('reorder','out_of_stock','asset_service','asset_warranty')),
      product_id uuid REFERENCES shop_products(id) ON DELETE CASCADE,
      asset_id uuid REFERENCES shop_assets(id) ON DELETE CASCADE,
      severity text NOT NULL DEFAULT 'warning',
      message text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK(status IN('open','acknowledged','resolved')),
      created_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_at timestamptz,
      resolved_at timestamptz,
      UNIQUE(alert_type,product_id,asset_id,status)
    );

    CREATE TABLE IF NOT EXISTS shop_finance_accounts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      code text NOT NULL,
      name text NOT NULL,
      account_type text NOT NULL CHECK(account_type IN('asset','liability','equity','income','expense')),
      subtype text,
      currency text NOT NULL DEFAULT 'GHS',
      is_cash_account boolean NOT NULL DEFAULT false,
      is_system boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      opening_balance numeric(14,2) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,shop_id,code)
    );

    CREATE TABLE IF NOT EXISTS shop_finance_vendors(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      name text NOT NULL,
      tax_id text,
      phone text,
      email text,
      address text,
      contact_person text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_finance_journal_entries(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      entry_no text NOT NULL,
      entry_date date NOT NULL DEFAULT CURRENT_DATE,
      description text NOT NULL,
      source_type text,
      source_id uuid,
      status text NOT NULL DEFAULT 'posted' CHECK(status IN('draft','posted','voided')),
      reference text,
      created_by uuid,
      posted_at timestamptz,
      voided_at timestamptz,
      voided_by uuid,
      void_reason text,
      reversal_entry_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,entry_no)
    );

    CREATE TABLE IF NOT EXISTS shop_finance_journal_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      journal_entry_id uuid NOT NULL REFERENCES shop_finance_journal_entries(id) ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES shop_finance_accounts(id),
      description text,
      debit numeric(14,2) NOT NULL DEFAULT 0 CHECK(debit>=0),
      credit numeric(14,2) NOT NULL DEFAULT 0 CHECK(credit>=0),
      CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
    );

    CREATE TABLE IF NOT EXISTS shop_finance_budgets(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES shop_finance_accounts(id),
      period_start date NOT NULL,
      period_end date NOT NULL,
      amount numeric(14,2) NOT NULL CHECK(amount>=0),
      notes text,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_finance_tax_types(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      code text NOT NULL,
      name text NOT NULL,
      rate numeric(8,4) NOT NULL DEFAULT 0,
      authority text,
      payable_account_id uuid REFERENCES shop_finance_accounts(id),
      is_active boolean NOT NULL DEFAULT true,
      UNIQUE(organisation_id,shop_id,code)
    );

    CREATE TABLE IF NOT EXISTS shop_finance_tax_obligations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      tax_type_id uuid NOT NULL REFERENCES shop_finance_tax_types(id),
      period_start date NOT NULL,
      period_end date NOT NULL,
      due_date date,
      amount_due numeric(14,2) NOT NULL CHECK(amount_due>=0),
      amount_paid numeric(14,2) NOT NULL DEFAULT 0,
      filing_reference text,
      status text NOT NULL DEFAULT 'open',
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_finance_tax_payments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      obligation_id uuid NOT NULL REFERENCES shop_finance_tax_obligations(id) ON DELETE CASCADE,
      payment_date date NOT NULL DEFAULT CURRENT_DATE,
      amount numeric(14,2) NOT NULL CHECK(amount>0),
      payment_account_id uuid REFERENCES shop_finance_accounts(id),
      authority_reference text,
      receipt_reference text,
      journal_entry_id uuid REFERENCES shop_finance_journal_entries(id),
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_tickets(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      ticket_no text NOT NULL,
      source text NOT NULL DEFAULT 'admin' CHECK(source IN('admin','customer_portal','whatsapp','pos','public')),
      category text NOT NULL DEFAULT 'general',
      subject text NOT NULL,
      description text NOT NULL,
      priority text NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high','urgent')),
      status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','waiting_customer','resolved','closed','cancelled')),
      assigned_os_user_id uuid,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      UNIQUE(organisation_id,ticket_no)
    );

    CREATE TABLE IF NOT EXISTS shop_ticket_comments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid NOT NULL REFERENCES shop_tickets(id) ON DELETE CASCADE,
      author_type text NOT NULL CHECK(author_type IN('customer','staff','system')),
      author_id uuid,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shop_pos_devices(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      device_name text NOT NULL,
      device_code text NOT NULL,
      provider text,
      terminal_id text,
      status text NOT NULL DEFAULT 'registered' CHECK(status IN('registered','online','offline','disabled')),
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,device_code)
    );

    CREATE TABLE IF NOT EXISTS shop_payment_intents(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      order_id uuid REFERENCES shop_orders(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES shop_customers(id) ON DELETE SET NULL,
      pos_device_id uuid REFERENCES shop_pos_devices(id) ON DELETE SET NULL,
      idempotency_key text NOT NULL,
      method text NOT NULL,
      amount numeric(14,2) NOT NULL CHECK(amount>0),
      currency text NOT NULL DEFAULT 'GHS',
      provider text,
      provider_reference text,
      status text NOT NULL DEFAULT 'created' CHECK(status IN('created','pending','authorized','successful','failed','cancelled','expired','review_required')),
      expires_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS shop_payment_settlements(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
      provider text NOT NULL,
      settlement_reference text NOT NULL,
      settlement_date date,
      gross_amount numeric(14,2) NOT NULL DEFAULT 0,
      fees numeric(14,2) NOT NULL DEFAULT 0,
      net_amount numeric(14,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      reconciled_at timestamptz,
      raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE(organisation_id,provider,settlement_reference)
    );

    CREATE TABLE IF NOT EXISTS shop_purchase_orders(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      vendor_id uuid REFERENCES shop_finance_vendors(id) ON DELETE SET NULL,
      po_no text NOT NULL,
      order_date date NOT NULL DEFAULT CURRENT_DATE,
      expected_date date,
      status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','pending_approval','approved','part_received','received','cancelled')),
      subtotal numeric(14,2) NOT NULL DEFAULT 0,
      tax numeric(14,2) NOT NULL DEFAULT 0,
      total numeric(14,2) NOT NULL DEFAULT 0,
      notes text,
      requested_by uuid,
      approved_by uuid,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,po_no)
    );

    CREATE TABLE IF NOT EXISTS shop_purchase_order_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id uuid NOT NULL REFERENCES shop_purchase_orders(id) ON DELETE CASCADE,
      product_id uuid REFERENCES shop_products(id) ON DELETE SET NULL,
      description text NOT NULL,
      ordered_quantity numeric(14,3) NOT NULL CHECK(ordered_quantity>0),
      received_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK(received_quantity>=0),
      unit_cost numeric(14,2) NOT NULL CHECK(unit_cost>=0),
      line_total numeric(14,2) NOT NULL CHECK(line_total>=0)
    );

    CREATE TABLE IF NOT EXISTS shop_goods_receipts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE SET NULL,
      purchase_order_id uuid NOT NULL REFERENCES shop_purchase_orders(id) ON DELETE RESTRICT,
      grn_no text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      received_by uuid,
      notes text,
      total_cost numeric(14,2) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organisation_id,grn_no)
    );

    CREATE TABLE IF NOT EXISTS shop_goods_receipt_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      goods_receipt_id uuid NOT NULL REFERENCES shop_goods_receipts(id) ON DELETE CASCADE,
      purchase_order_line_id uuid NOT NULL REFERENCES shop_purchase_order_lines(id) ON DELETE RESTRICT,
      product_id uuid REFERENCES shop_products(id) ON DELETE SET NULL,
      quantity numeric(14,3) NOT NULL CHECK(quantity>0),
      unit_cost numeric(14,2) NOT NULL CHECK(unit_cost>=0),
      line_total numeric(14,2) NOT NULL CHECK(line_total>=0)
    );

    CREATE TABLE IF NOT EXISTS shop_automation_settings(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id uuid NOT NULL,
      shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      branch_id uuid REFERENCES shop_branches(id) ON DELETE CASCADE,
      auto_eod_enabled boolean NOT NULL DEFAULT true,
      auto_eod_time time NOT NULL DEFAULT '21:00',
      inactivity_days integer NOT NULL DEFAULT 90 CHECK(inactivity_days>=30),
      welcome_discount_percent numeric(6,2) NOT NULL DEFAULT 10 CHECK(welcome_discount_percent>=0 AND welcome_discount_percent<=100),
      reorder_alerts_enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(shop_id,branch_id)
    );

    ALTER TABLE salon_eod_closures ADD COLUMN IF NOT EXISTS close_mode text NOT NULL DEFAULT 'manual';
    ALTER TABLE salon_eod_closures ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'confirmed';
    ALTER TABLE salon_eod_closures ADD COLUMN IF NOT EXISTS reviewed_by uuid;
    ALTER TABLE salon_eod_closures ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS pos_device_id uuid;
    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS payment_intent_id uuid;
    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'unreconciled';
    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
    ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'admin';

    CREATE INDEX IF NOT EXISTS idx_shop_customer_lifecycle ON shop_customers(organisation_id,shop_id,status,last_visit_at);
    CREATE INDEX IF NOT EXISTS idx_shop_outbox_queue ON shop_communication_outbox(status,scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_shop_messages_conversation ON shop_messages(conversation_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_shop_approvals_status ON shop_approval_requests(organisation_id,status,requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_assets_due ON shop_assets(organisation_id,status,next_service_date);
    CREATE INDEX IF NOT EXISTS idx_shop_tickets_status ON shop_tickets(organisation_id,shop_id,status,priority,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_finance_journal_date ON shop_finance_journal_entries(organisation_id,entry_date,status);
    CREATE INDEX IF NOT EXISTS idx_shop_purchase_orders_status ON shop_purchase_orders(organisation_id,shop_id,status,order_date DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_goods_receipts_po ON shop_goods_receipts(purchase_order_id,received_at DESC);
  `);

  await seedCapabilities(db);
}

async function seedCapabilities(db:Db){
  const capabilities=[
    ['dashboard.read','Dashboard','Dashboard','View business dashboard',10],
    ['appointments.manage','Appointments','Operations','Create and manage bookings, queue and service workflow',20],
    ['customers.read','View Customers','Customers','View customer records and 360 profiles',30],
    ['customers.manage','Manage Customers','Customers','Create and edit customers',31],
    ['communications.manage','Communications','Customers','Send messages and manage customer chat',32],
    ['retention.manage','Retention','Customers','Manage inactive customers and retention campaigns',33],
    ['services.read','View Services','Services','View services and current prices',40],
    ['services.manage','Manage Services','Services','Create services and submit changes for approval',41],
    ['approvals.review','Review Approvals','Controls','Approve or reject controlled changes',50],
    ['inventory.read','View Inventory','Inventory','View products, equipment and stock alerts',60],
    ['inventory.manage','Manage Inventory','Inventory','Manage products, stock and equipment',61],
    ['procurement.manage','Procurement','Inventory','Manage suppliers, purchase orders and goods receiving',62],
    ['sales.manage','Sales / POS','Commerce','Create invoices and manage POS checkout',70],
    ['payments.read','View Payments','Commerce','View payment transactions',71],
    ['payments.create','Take Payments','Commerce','Initiate and record payments',72],
    ['finance.read','View Finance','Finance','View finance and accounting records',80],
    ['finance.manage','Manage Finance','Finance','Post journals, expenses, budgets and statutory records',81],
    ['reports.read','Reports','Reporting','View and export reports',90],
    ['tickets.manage','Ticketing','Support','Manage service and customer support tickets',100],
    ['assets.manage','Assets & Equipment','Inventory','Manage salon equipment and maintenance',110],
    ['access.manage','Access Management','Administration','Assign Shop roles and privileges',120],
    ['roles.manage','Roles & Privileges','Administration','Manage role capabilities',121],
    ['audit.read','Audit','Administration','View audit and system change logs',130],
    ['system.read','System Diagnostics','Administration','View system integrations and diagnostics',131],
    ['settings.manage','Settings','Administration','Manage Shop configuration and automation',140]
  ] as const;
  for(const c of capabilities){
    await db.query(
      `INSERT INTO shop_capabilities(key,name,module,description,sort_order)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,module=EXCLUDED.module,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order`,
      [...c]
    );
  }
}
