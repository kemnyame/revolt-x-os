-- School hardening: configurable sessions, academic period locks and HR/payroll.

CREATE TABLE IF NOT EXISTS school_security_settings (
  organisation_id uuid PRIMARY KEY,
  idle_timeout_minutes integer NOT NULL DEFAULT 30 CHECK(idle_timeout_minutes BETWEEN 5 AND 240),
  absolute_timeout_minutes integer NOT NULL DEFAULT 480 CHECK(absolute_timeout_minutes BETWEEN 30 AND 1440),
  updated_by_os_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO school_security_settings(organisation_id)
SELECT organisation_id FROM school_profiles
ON CONFLICT(organisation_id) DO NOTHING;

ALTER TABLE academic_years
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by_os_user_id uuid;

ALTER TABLE terms
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by_os_user_id uuid;

CREATE TABLE IF NOT EXISTS payroll_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(40) NOT NULL,
  name varchar(160) NOT NULL,
  component_type varchar(20) NOT NULL CHECK(component_type IN('earning','deduction')),
  calculation_type varchar(30) NOT NULL DEFAULT 'fixed' CHECK(calculation_type IN('fixed','percent_basic')),
  default_value numeric(14,2) NOT NULL DEFAULT 0 CHECK(default_value>=0),
  rate_percent numeric(8,4) NOT NULL DEFAULT 0 CHECK(rate_percent>=0),
  taxable boolean NOT NULL DEFAULT false,
  statutory boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,code)
);

CREATE TABLE IF NOT EXISTS staff_payroll_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  base_salary numeric(14,2) NOT NULL DEFAULT 0 CHECK(base_salary>=0),
  currency varchar(10) NOT NULL DEFAULT 'GHS',
  pay_frequency varchar(20) NOT NULL DEFAULT 'monthly' CHECK(pay_frequency IN('monthly')),
  bank_name varchar(160),
  bank_account_name varchar(180),
  bank_account_number varchar(100),
  mobile_money_number varchar(80),
  mobile_money_network varchar(40),
  is_active boolean NOT NULL DEFAULT true,
  updated_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,os_user_id)
);

CREATE TABLE IF NOT EXISTS staff_payroll_component_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  component_id uuid NOT NULL REFERENCES payroll_components(id) ON DELETE CASCADE,
  value_override numeric(14,2) CHECK(value_override IS NULL OR value_override>=0),
  rate_override numeric(8,4) CHECK(rate_override IS NULL OR rate_override>=0),
  is_active boolean NOT NULL DEFAULT true,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,os_user_id,component_id)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  period_year integer NOT NULL CHECK(period_year BETWEEN 2000 AND 2200),
  period_month integer NOT NULL CHECK(period_month BETWEEN 1 AND 12),
  status varchar(30) NOT NULL DEFAULT 'draft' CHECK(status IN('draft','submitted_to_finance','approved_for_payment','paid','cancelled')),
  currency varchar(10) NOT NULL DEFAULT 'GHS',
  gross_total numeric(16,2) NOT NULL DEFAULT 0,
  deductions_total numeric(16,2) NOT NULL DEFAULT 0,
  net_total numeric(16,2) NOT NULL DEFAULT 0,
  created_by_os_user_id uuid NOT NULL,
  submitted_by_os_user_id uuid,
  submitted_at timestamptz,
  approved_by_os_user_id uuid,
  approved_at timestamptz,
  paid_by_os_user_id uuid,
  paid_at timestamptz,
  finance_journal_entry_id uuid REFERENCES finance_journal_entries(id),
  payment_journal_entry_id uuid REFERENCES finance_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,period_year,period_month)
);

CREATE TABLE IF NOT EXISTS payroll_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  staff_name varchar(220) NOT NULL,
  staff_id varchar(120),
  base_salary numeric(14,2) NOT NULL DEFAULT 0,
  gross_earnings numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions numeric(14,2) NOT NULL DEFAULT 0,
  net_pay numeric(14,2) NOT NULL DEFAULT 0,
  bank_name varchar(160),
  bank_account_name varchar(180),
  bank_account_number varchar(100),
  mobile_money_number varchar(80),
  mobile_money_network varchar(40),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payroll_run_id,os_user_id)
);

CREATE TABLE IF NOT EXISTS payroll_run_item_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_item_id uuid NOT NULL REFERENCES payroll_run_items(id) ON DELETE CASCADE,
  component_id uuid REFERENCES payroll_components(id) ON DELETE SET NULL,
  code varchar(40) NOT NULL,
  name varchar(160) NOT NULL,
  component_type varchar(20) NOT NULL CHECK(component_type IN('earning','deduction')),
  amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(amount>=0),
  taxable boolean NOT NULL DEFAULT false,
  statutory boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payroll_runs_org_period_idx ON payroll_runs(organisation_id,period_year DESC,period_month DESC);
CREATE INDEX IF NOT EXISTS payroll_run_items_user_idx ON payroll_run_items(organisation_id,os_user_id,payroll_run_id);
CREATE INDEX IF NOT EXISTS payroll_assignments_user_idx ON staff_payroll_component_assignments(organisation_id,os_user_id,is_active);

INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
SELECT organisation_id,'2050','Payroll Payable','liability','payroll_payable',false,true FROM school_profiles
ON CONFLICT(organisation_id,code) DO NOTHING;

INSERT INTO payroll_components(organisation_id,code,name,component_type,calculation_type,default_value,rate_percent,taxable,statutory,created_by_os_user_id)
SELECT organisation_id,v.code,v.name,v.component_type,v.calculation_type,v.default_value,v.rate_percent,v.taxable,v.statutory,NULL
FROM school_profiles
CROSS JOIN (VALUES
 ('ALLOW','General Allowance','earning','fixed',0::numeric,0::numeric,true,false),
 ('BONUS','Bonus','earning','fixed',0::numeric,0::numeric,true,false),
 ('PAYE','PAYE','deduction','fixed',0::numeric,0::numeric,false,true),
 ('SSNIT','SSNIT / Pension','deduction','percent_basic',0::numeric,5.5::numeric,false,true),
 ('LOAN','Loan Deduction','deduction','fixed',0::numeric,0::numeric,false,false)
) v(code,name,component_type,calculation_type,default_value,rate_percent,taxable,statutory)
ON CONFLICT(organisation_id,code) DO NOTHING;

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('security.manage','Security','edit','Manage session security','Configure School idle and absolute session timeouts',147),
('payroll.view','HR & Payroll','view','View payroll','View payroll runs and staff payslips',150),
('payroll.manage','HR & Payroll','edit','Manage payroll','Configure emoluments, earnings and deductions and prepare payroll',151),
('payroll.process','HR & Payroll','approve','Process payroll payment','Approve payroll in Finance and post salary payment journals',152)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE
    WHEN sr.key='school_admin' THEN true
    WHEN sr.key IN('headteacher','registrar') AND c.key IN('payroll.view','payroll.manage') THEN true
    WHEN sr.key IN('accountant','bursar') AND c.key IN('payroll.view','payroll.process') THEN true
    ELSE false
  END
FROM school_roles sr
CROSS JOIN school_capabilities c
WHERE c.key IN('security.manage','payroll.view','payroll.manage','payroll.process')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
