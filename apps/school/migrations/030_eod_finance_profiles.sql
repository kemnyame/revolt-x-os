-- End-of-day finance, richer chart of accounts and image-backed profiles.

ALTER TABLE school_profiles
  ADD COLUMN IF NOT EXISTS logo_image_data text;

ALTER TABLE school_memberships
  ADD COLUMN IF NOT EXISTS profile_photo_data text;

CREATE TABLE IF NOT EXISTS finance_eod_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  business_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'running' CHECK(status IN('running','completed','completed_with_warnings','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  run_by_os_user_id uuid,
  total_debit numeric(16,2) NOT NULL DEFAULT 0,
  total_credit numeric(16,2) NOT NULL DEFAULT 0,
  issue_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  UNIQUE(organisation_id,business_date)
);

CREATE TABLE IF NOT EXISTS finance_eod_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eod_run_id uuid NOT NULL REFERENCES finance_eod_runs(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL,
  business_date date NOT NULL,
  report_key varchar(80) NOT NULL,
  report_name varchar(160) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(eod_run_id,report_key)
);

CREATE INDEX IF NOT EXISTS finance_eod_runs_org_date_idx
  ON finance_eod_runs(organisation_id,business_date DESC);
CREATE INDEX IF NOT EXISTS finance_eod_reports_run_idx
  ON finance_eod_reports(eod_run_id,report_key);

-- Expand the standard school chart while preserving any accounts already configured.
INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
SELECT sp.organisation_id,v.code,v.name,v.account_type,v.subtype,v.is_cash,v.is_system
FROM school_profiles sp
CROSS JOIN (VALUES
 ('1200','Prepaid Expenses','asset','current_asset',false,true),
 ('1300','Property, Plant & Equipment','asset','fixed_asset',false,true),
 ('1310','Accumulated Depreciation','asset','contra_asset',false,true),
 ('2000','Accounts Payable','liability','current_liability',false,true),
 ('2300','Accrued Expenses','liability','current_liability',false,true),
 ('3000','Owner / School Equity','equity','capital',false,true),
 ('3100','Retained Surplus','equity','retained_earnings',false,true),
 ('4010','Admission & Registration Income','income','school_income',false,false),
 ('4020','Transport Income','income','school_income',false,false),
 ('4030','Meals & Feeding Income','income','school_income',false,false),
 ('4040','Boarding Income','income','school_income',false,false),
 ('4050','Books, Uniforms & Materials Income','income','school_income',false,false),
 ('4060','Examination Income','income','school_income',false,false),
 ('4070','Activities & Events Income','income','school_income',false,false),
 ('4090','Other School Income','income','other_income',false,false),
 ('5000','Salaries & Wages','expense','staff_cost',false,false),
 ('5010','Utilities Expense','expense','operating_expense',false,false),
 ('5020','Rent & Property Expense','expense','operating_expense',false,false),
 ('5030','Repairs & Maintenance','expense','operating_expense',false,false),
 ('5040','Teaching & Learning Materials','expense','academic_expense',false,false),
 ('5050','Transport & Fuel Expense','expense','operating_expense',false,false),
 ('5060','Communication & Internet','expense','operating_expense',false,false),
 ('5070','Professional & Consultancy Fees','expense','operating_expense',false,false),
 ('5080','Bank & Payment Charges','expense','finance_expense',false,false),
 ('5090','Depreciation Expense','expense','non_cash_expense',false,false),
 ('5100','Security & Cleaning Expense','expense','operating_expense',false,false),
 ('5110','Staff Training & Welfare','expense','staff_cost',false,false),
 ('5120','Marketing & Admissions Expense','expense','operating_expense',false,false)
) v(code,name,account_type,subtype,is_cash,is_system)
ON CONFLICT(organisation_id,code) DO NOTHING;

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('finance.eod.run','Finance','run','Run End of Day','Run and close the daily finance cycle and generate report snapshots',139),
('profile.edit','Profile','edit','Edit own profile','Edit personal profile details and profile picture',160)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE WHEN c.key='profile.edit' THEN true
       WHEN sr.key IN('school_admin','accountant','bursar') THEN true
       ELSE false END
FROM school_roles sr
CROSS JOIN (VALUES('finance.eod.run'),('profile.edit')) c(key)
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
