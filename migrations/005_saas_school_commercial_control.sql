-- Revolt-X OS SaaS commercial control for School and future products.

CREATE TABLE IF NOT EXISTS saas_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  description text,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_product_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES saas_products(id) ON DELETE CASCADE,
  module_key varchar(120) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  description text,
  base_monthly_price numeric(14,2) NOT NULL DEFAULT 0 CHECK(base_monthly_price>=0),
  dependency_keys text[] NOT NULL DEFAULT '{}',
  is_core boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_pricing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES saas_products(id) ON DELETE CASCADE,
  plan_key varchar(80) NOT NULL,
  name varchar(120) NOT NULL,
  description text,
  monthly_price numeric(14,2) NOT NULL DEFAULT 0 CHECK(monthly_price>=0),
  termly_price numeric(14,2) NOT NULL DEFAULT 0 CHECK(termly_price>=0),
  annual_price numeric(14,2) NOT NULL DEFAULT 0 CHECK(annual_price>=0),
  currency char(3) NOT NULL DEFAULT 'GHS',
  student_limit int,
  staff_limit int,
  campus_limit int,
  storage_gb numeric(10,2),
  is_custom boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id,plan_key)
);

CREATE TABLE IF NOT EXISTS saas_plan_modules (
  plan_id uuid NOT NULL REFERENCES saas_pricing_plans(id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES saas_product_modules(id) ON DELETE CASCADE,
  included boolean NOT NULL DEFAULT true,
  PRIMARY KEY(plan_id,module_id)
);

CREATE TABLE IF NOT EXISTS saas_customers (
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_type varchar(30) NOT NULL DEFAULT 'school' CHECK(customer_type IN('school','school_group','business','other')),
  school_type varchar(80),
  primary_contact_name varchar(180),
  primary_contact_email varchar(320),
  primary_contact_phone varchar(50),
  address text,
  notes text,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN('lead','trial','active','suspended','archived')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_organisation_id,customer_organisation_id),
  CHECK(provider_organisation_id<>customer_organisation_id)
);

CREATE TABLE IF NOT EXISTS saas_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES saas_products(id),
  plan_id uuid REFERENCES saas_pricing_plans(id),
  billing_frequency varchar(20) NOT NULL DEFAULT 'monthly' CHECK(billing_frequency IN('monthly','termly','annual','custom')),
  status varchar(20) NOT NULL DEFAULT 'trial' CHECK(status IN('trial','active','grace','suspended','expired','cancelled')),
  currency char(3) NOT NULL DEFAULT 'GHS',
  recurring_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(recurring_amount>=0),
  starts_at timestamptz NOT NULL DEFAULT now(),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  grace_ends_at timestamptz,
  cancelled_at timestamptz,
  limits jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_subscriptions_customer_idx
  ON saas_subscriptions(provider_organisation_id,customer_organisation_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS saas_subscription_one_current_idx
  ON saas_subscriptions(provider_organisation_id,customer_organisation_id,product_id)
  WHERE status IN('trial','active','grace','suspended');

CREATE TABLE IF NOT EXISTS saas_subscription_modules (
  subscription_id uuid NOT NULL REFERENCES saas_subscriptions(id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES saas_product_modules(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  price_override numeric(14,2),
  limits jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(subscription_id,module_id)
);

CREATE TABLE IF NOT EXISTS saas_usage_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES saas_products(id),
  metric_key varchar(100) NOT NULL,
  metric_value numeric(18,2) NOT NULL DEFAULT 0,
  measured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_usage_customer_metric_idx
  ON saas_usage_snapshots(provider_organisation_id,customer_organisation_id,metric_key,measured_at DESC);

CREATE TABLE IF NOT EXISTS saas_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES saas_subscriptions(id) ON DELETE SET NULL,
  invoice_no varchar(60) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN('draft','issued','part_paid','paid','overdue','void')),
  currency char(3) NOT NULL DEFAULT 'GHS',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_organisation_id,invoice_no)
);

CREATE TABLE IF NOT EXISTS saas_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
  description varchar(300) NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS saas_subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES saas_invoices(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES saas_subscriptions(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  currency char(3) NOT NULL DEFAULT 'GHS',
  payment_method varchar(40) NOT NULL DEFAULT 'manual',
  provider varchar(60),
  provider_reference varchar(160),
  paid_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_customer_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  domain varchar(255) NOT NULL UNIQUE,
  domain_type varchar(20) NOT NULL DEFAULT 'subdomain' CHECK(domain_type IN('subdomain','custom')),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK(status IN('pending','active','failed','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES saas_products(id),
  action varchar(50) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed')),
  details jsonb NOT NULL DEFAULT '{}',
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO saas_products(product_key,name,description,status)
VALUES('school','Revolt-X School','Multi-tenant school management, finance, parent engagement and academic operations','active')
ON CONFLICT(product_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,status='active';

WITH p AS (SELECT id FROM saas_products WHERE product_key='school')
INSERT INTO saas_product_modules(product_id,module_key,name,description,base_monthly_price,dependency_keys,is_core,sort_order)
SELECT p.id,v.module_key,v.name,v.description,v.price,v.dependencies,v.is_core,v.sort_order
FROM p CROSS JOIN (VALUES
 ('school.core','Core School Administration','School profile, academic structure, students and staff',0::numeric,ARRAY[]::text[],true,10),
 ('school.admissions','Admissions','Public and internal admissions workflow',40,ARRAY['school.core'],false,20),
 ('school.students','Student 360','Student profile, lifecycle, guardians and records',40,ARRAY['school.core'],false,30),
 ('school.academics','Academic Management','Classes, subjects, terms, assessments and promotion',60,ARRAY['school.core'],false,40),
 ('school.attendance','Attendance','Daily student attendance and reporting',30,ARRAY['school.core'],false,50),
 ('school.teaching','Teaching Workspace','Homework, lesson notes, teacher workflows and report pool',50,ARRAY['school.academics'],false,60),
 ('school.timetable','Timetable & Scheduling','Timetable setup, auto-schedule and availability',40,ARRAY['school.academics'],false,70),
 ('school.fees','Fees & Student Accounts','Fee setup, assignments, balances, statements and receipts',60,ARRAY['school.core'],false,80),
 ('school.payments','Online Payments','Parent payment requests and Paystack MoMo/Card/Bank payments',50,ARRAY['school.fees'],false,90),
 ('school.finance','Finance & Accounting','GL, journals, expenses, tax, budgets, reversals and EOD',120,ARRAY['school.fees'],false,100),
 ('school.parent_portal','Parent Portal','Multi-child parent access, fees, reports, timetable and alerts',40,ARRAY['school.core'],false,110),
 ('school.student_portal','Student Portal','Student access to learning, timetable and reports',30,ARRAY['school.core'],false,120),
 ('school.communications','Communications','In-app, email, SMS/WhatsApp-ready notifications',40,ARRAY['school.core'],false,130),
 ('school.staff','Staff, Leave & Relief','Staff management, leave approval and relief schedules',40,ARRAY['school.core'],false,140),
 ('school.controls','Approvals & Controls','Approvals, roles, privileges, audit and control workflows',60,ARRAY['school.core'],false,150),
 ('school.analytics','Advanced Reporting','Operational, academic and financial reporting',60,ARRAY['school.core'],false,160)
) v(module_key,name,description,price,dependencies,is_core,sort_order)
ON CONFLICT(module_key) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,base_monthly_price=EXCLUDED.base_monthly_price,
  dependency_keys=EXCLUDED.dependency_keys,is_core=EXCLUDED.is_core,sort_order=EXCLUDED.sort_order,is_active=true;

WITH p AS (SELECT id FROM saas_products WHERE product_key='school')
INSERT INTO saas_pricing_plans(product_id,plan_key,name,description,monthly_price,termly_price,annual_price,currency,student_limit,staff_limit,campus_limit,storage_gb,is_custom,sort_order)
SELECT p.id,v.plan_key,v.name,v.description,v.monthly,v.termly,v.annual,'GHS',v.students,v.staff,v.campuses,v.storage,false,v.sort_order
FROM p CROSS JOIN (VALUES
 ('starter','Starter','Core digital administration for smaller schools',199::numeric,550::numeric,1990::numeric,300,30,1,5::numeric,10),
 ('growth','Growth','Adds fees, payments, communications and teaching workflows',399,1100,3990,750,75,2,15,20),
 ('professional','Professional','Full school operations with finance, controls and deeper reporting',699,1950,6990,1500,150,3,40,30),
 ('enterprise','Enterprise','Large and multi-campus schools with the full module set',1199,3300,11990,5000,500,10,150,40)
) v(plan_key,name,description,monthly,termly,annual,students,staff,campuses,storage,sort_order)
ON CONFLICT(product_id,plan_key) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,monthly_price=EXCLUDED.monthly_price,
  termly_price=EXCLUDED.termly_price,annual_price=EXCLUDED.annual_price,
  student_limit=EXCLUDED.student_limit,staff_limit=EXCLUDED.staff_limit,campus_limit=EXCLUDED.campus_limit,
  storage_gb=EXCLUDED.storage_gb,sort_order=EXCLUDED.sort_order,is_active=true;

-- Starter modules.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id
WHERE pl.plan_key='starter' AND m.module_key IN(
 'school.core','school.admissions','school.students','school.academics','school.attendance',
 'school.parent_portal','school.student_portal'
) ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;

-- Growth modules.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id
WHERE pl.plan_key='growth' AND m.module_key IN(
 'school.core','school.admissions','school.students','school.academics','school.attendance',
 'school.teaching','school.timetable','school.fees','school.payments','school.parent_portal',
 'school.student_portal','school.communications','school.staff'
) ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;

-- Professional and Enterprise include all current School modules.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id
WHERE pl.plan_key IN('professional','enterprise')
ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;

INSERT INTO permissions(key,description) VALUES
 ('commercial.read','View customers, subscriptions, licences, pricing and billing'),
 ('commercial.manage','Create and manage customers, pricing, subscriptions and licences'),
 ('commercial.billing','Issue subscription invoices and record payments')
ON CONFLICT(key) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.key='owner' AND r.organisation_id IS NULL AND p.key IN('commercial.read','commercial.manage','commercial.billing')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.key IN('commercial.read','commercial.manage','commercial.billing')
WHERE r.key='admin' AND r.organisation_id IS NULL
ON CONFLICT DO NOTHING;
