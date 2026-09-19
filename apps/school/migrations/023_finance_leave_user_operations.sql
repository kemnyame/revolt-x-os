-- Finance & Accounts, staff leave and role integration.

CREATE TABLE IF NOT EXISTS finance_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(30) NOT NULL,
  name varchar(180) NOT NULL,
  account_type varchar(20) NOT NULL CHECK(account_type IN('asset','liability','equity','income','expense')),
  subtype varchar(60),
  currency varchar(10) NOT NULL DEFAULT 'GHS',
  is_cash_account boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,code)
);

CREATE TABLE IF NOT EXISTS finance_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  name varchar(220) NOT NULL,
  tax_id varchar(100),
  phone varchar(80),
  email varchar(240),
  address text,
  contact_person varchar(180),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  entry_no varchar(60) NOT NULL,
  entry_date date NOT NULL DEFAULT current_date,
  description varchar(1000) NOT NULL,
  source_type varchar(60),
  source_id uuid,
  status varchar(20) NOT NULL DEFAULT 'posted' CHECK(status IN('draft','posted','voided')),
  reference varchar(160),
  created_by_os_user_id uuid,
  posted_at timestamptz,
  voided_at timestamptz,
  voided_by_os_user_id uuid,
  void_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,entry_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_journal_source_unique
  ON finance_journal_entries(organisation_id,source_type,source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL AND status<>'voided';

CREATE TABLE IF NOT EXISTS finance_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES finance_journal_entries(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES finance_accounts(id),
  description varchar(500),
  debit numeric(14,2) NOT NULL DEFAULT 0 CHECK(debit>=0),
  credit numeric(14,2) NOT NULL DEFAULT 0 CHECK(credit>=0),
  CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
);

CREATE INDEX IF NOT EXISTS finance_journal_lines_account_idx
  ON finance_journal_lines(account_id,journal_entry_id);

CREATE TABLE IF NOT EXISTS finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  expense_no varchar(60) NOT NULL,
  expense_date date NOT NULL DEFAULT current_date,
  vendor_id uuid REFERENCES finance_vendors(id) ON DELETE SET NULL,
  expense_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  payment_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(tax_amount>=0),
  description varchar(1200) NOT NULL,
  reference varchar(160),
  status varchar(20) NOT NULL DEFAULT 'posted' CHECK(status IN('draft','posted','voided')),
  journal_entry_id uuid REFERENCES finance_journal_entries(id),
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,expense_no)
);

CREATE TABLE IF NOT EXISTS finance_tax_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(40) NOT NULL,
  name varchar(180) NOT NULL,
  authority varchar(220),
  rate numeric(9,4),
  payable_account_id uuid REFERENCES finance_accounts(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,code)
);

CREATE TABLE IF NOT EXISTS finance_tax_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  tax_type_id uuid NOT NULL REFERENCES finance_tax_types(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_date date NOT NULL,
  amount_due numeric(14,2) NOT NULL CHECK(amount_due>=0),
  amount_paid numeric(14,2) NOT NULL DEFAULT 0 CHECK(amount_paid>=0),
  filing_reference varchar(180),
  notes text,
  status varchar(20) NOT NULL DEFAULT 'open' CHECK(status IN('open','part_paid','paid','overdue','cancelled')),
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_end>=period_start)
);

CREATE INDEX IF NOT EXISTS finance_tax_obligations_due_idx
  ON finance_tax_obligations(organisation_id,status,due_date);

CREATE TABLE IF NOT EXISTS finance_tax_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  obligation_id uuid NOT NULL REFERENCES finance_tax_obligations(id) ON DELETE CASCADE,
  payment_date date NOT NULL DEFAULT current_date,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  payment_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  authority_reference varchar(180),
  receipt_reference varchar(180),
  journal_entry_id uuid REFERENCES finance_journal_entries(id),
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  account_id uuid NOT NULL REFERENCES finance_accounts(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount>=0),
  notes text,
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_end>=period_start)
);

CREATE INDEX IF NOT EXISTS finance_budgets_period_idx
  ON finance_budgets(organisation_id,period_start,period_end);

CREATE TABLE IF NOT EXISTS staff_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  applicant_os_user_id uuid NOT NULL,
  leave_type varchar(40) NOT NULL CHECK(leave_type IN('annual','sick','maternity','paternity','study','compassionate','official','other')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'submitted' CHECK(status IN('draft','submitted','approved','declined','cancelled','completed')),
  submitted_on_behalf_by_os_user_id uuid,
  reviewed_by_os_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(end_date>=start_date)
);

CREATE INDEX IF NOT EXISTS staff_leave_requests_org_idx
  ON staff_leave_requests(organisation_id,status,start_date,end_date);

CREATE TABLE IF NOT EXISTS staff_leave_relievers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id uuid NOT NULL REFERENCES staff_leave_requests(id) ON DELETE CASCADE,
  reliever_os_user_id uuid NOT NULL,
  priority int NOT NULL DEFAULT 1 CHECK(priority BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(leave_request_id,reliever_os_user_id)
);

CREATE TABLE IF NOT EXISTS staff_leave_relief_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id uuid NOT NULL REFERENCES staff_leave_requests(id) ON DELETE CASCADE,
  coverage_date date NOT NULL,
  timetable_entry_id uuid REFERENCES timetable_entries(id) ON DELETE SET NULL,
  classroom_id uuid REFERENCES classrooms(id) ON DELETE SET NULL,
  subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL,
  original_teacher_os_user_id uuid NOT NULL,
  reliever_os_user_id uuid NOT NULL,
  start_time time,
  end_time time,
  status varchar(20) NOT NULL DEFAULT 'planned' CHECK(status IN('planned','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(leave_request_id,coverage_date,timetable_entry_id)
);

CREATE INDEX IF NOT EXISTS staff_leave_relief_teacher_idx
  ON staff_leave_relief_schedule(reliever_os_user_id,coverage_date,start_time,end_time);

-- Default chart of accounts for every current school.
INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
SELECT sp.organisation_id,v.code,v.name,v.account_type,v.subtype,v.is_cash,v.is_system
FROM school_profiles sp
CROSS JOIN (VALUES
 ('1000','Cash on Hand','asset','cash',true,true),
 ('1010','Bank Account','asset','bank',true,true),
 ('1020','Mobile Money Clearing','asset','mobile_money',true,true),
 ('1030','Card Clearing','asset','card',true,true),
 ('1100','Accounts Receivable','asset','receivable',false,true),
 ('2000','Accounts Payable','liability','payable',false,true),
 ('2100','Tax Payable','liability','tax',false,true),
 ('3000','Accumulated Fund','equity','equity',false,true),
 ('4000','Tuition & School Fees Income','income','school_fees',false,true),
 ('4100','Other Income','income','other_income',false,true),
 ('5000','Salaries & Wages','expense','payroll',false,true),
 ('5100','Utilities','expense','utilities',false,true),
 ('5200','Teaching & Learning Materials','expense','learning_materials',false,true),
 ('5300','Maintenance & Repairs','expense','maintenance',false,true),
 ('5400','Transport & Travel','expense','transport',false,true),
 ('5500','Administrative Expenses','expense','administration',false,true),
 ('5600','Taxes, Levies & Statutory Charges','expense','tax_expense',false,true),
 ('5900','Other Expenses','expense','other_expense',false,true)
) v(code,name,account_type,subtype,is_cash,is_system)
ON CONFLICT(organisation_id,code) DO NOTHING;

INSERT INTO finance_tax_types(organisation_id,code,name,authority,payable_account_id)
SELECT sp.organisation_id,v.code,v.name,'Ghana Revenue Authority',fa.id
FROM school_profiles sp
CROSS JOIN (VALUES
 ('PAYE','PAYE'),
 ('VAT','VAT'),
 ('WHT','Withholding Tax'),
 ('CIT','Corporate Income Tax'),
 ('LEVY','Statutory Levy')
) v(code,name)
JOIN finance_accounts fa ON fa.organisation_id=sp.organisation_id AND fa.code='2100'
ON CONFLICT(organisation_id,code) DO NOTHING;

-- Default Accountant role.
INSERT INTO school_roles(organisation_id,key,name,description,portal_mode,can_teach,is_system,is_active)
SELECT sp.organisation_id,'accountant','Accountant','Finance, accounting, tax and financial reporting','admin',false,true,true
FROM school_profiles sp
ON CONFLICT(organisation_id,key) DO NOTHING;

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('finance.view','Finance','view','View finance','View accounts, journals and financial reports',130),
('finance.manage','Finance','edit','Manage finance','Manage accounts, vendors, budgets and accounting setup',131),
('finance.post','Finance','create','Post transactions','Post expenses and journal transactions',132),
('finance.report','Finance','report','Financial reporting','Run income statement, trial balance, cashflow and account reports',133),
('tax.view','Finance','view','View taxes','View tax obligations and payment history',134),
('tax.manage','Finance','edit','Manage taxes','Create tax obligations and record tax payments',135),
('leave.view','Leave','view','View leave','View leave applications and relief schedules',140),
('leave.apply','Leave','create','Apply for leave','Apply for leave and select relief teachers',141),
('leave.apply_on_behalf','Leave','create','Apply on behalf','Submit leave for another staff member',142),
('leave.review','Leave','approve','Review leave','Approve or decline staff leave',143),
('leave.relief','Leave','edit','Manage relief coverage','Manage relief teachers and coverage schedules',144),
('staff.password_reset','People','edit','Reset user password','Issue a new password setup/reset link',145),
('staff.status','People','edit','Enable or disable users','Enable, disable or unlock School users',146)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE
    WHEN sr.key='school_admin' THEN true
    WHEN sr.key='accountant' AND c.key IN('finance.view','finance.manage','finance.post','finance.report','tax.view','tax.manage') THEN true
    WHEN sr.key='bursar' AND c.key IN('finance.view','finance.post','finance.report','tax.view','tax.manage') THEN true
    WHEN sr.key='headteacher' AND c.key IN('finance.view','finance.report','leave.view','leave.apply','leave.apply_on_behalf','leave.review','leave.relief') THEN true
    WHEN sr.can_teach AND c.key IN('leave.view','leave.apply') THEN true
    WHEN sr.key='registrar' AND c.key IN('leave.view','leave.apply_on_behalf') THEN true
    ELSE false
  END
FROM school_roles sr
CROSS JOIN school_capabilities c
WHERE c.key IN(
 'finance.view','finance.manage','finance.post','finance.report','tax.view','tax.manage',
 'leave.view','leave.apply','leave.apply_on_behalf','leave.review','leave.relief',
 'staff.password_reset','staff.status'
)
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();

-- Existing payments can be backfilled into the ledger by the application safely using source uniqueness.
