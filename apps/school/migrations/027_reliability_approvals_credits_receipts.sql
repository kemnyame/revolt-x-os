-- Reliability, approvals, student overpayment credits, references and receipt branding.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_source_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_source_check
  CHECK(source IN('school_manual','parent_online','school_online','accounting_receipt','credit_applied'));

ALTER TABLE school_profiles
  ADD COLUMN IF NOT EXISTS logo_url text;

INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
SELECT sp.organisation_id,'2200','Student Deposits / Credits','liability','student_credit',false,true
FROM school_profiles sp
ON CONFLICT(organisation_id,code) DO NOTHING;

CREATE TABLE IF NOT EXISTS finance_reference_counters (
  organisation_id uuid NOT NULL,
  reference_key varchar(40) NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK(next_number>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,reference_key)
);

CREATE TABLE IF NOT EXISTS student_account_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  source_receipt_id uuid REFERENCES finance_student_receipts(id) ON DELETE SET NULL,
  original_amount numeric(14,2) NOT NULL CHECK(original_amount>0),
  balance numeric(14,2) NOT NULL CHECK(balance>=0),
  status varchar(20) NOT NULL DEFAULT 'open' CHECK(status IN('open','used','voided')),
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_credit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  credit_id uuid NOT NULL REFERENCES student_account_credits(id) ON DELETE RESTRICT,
  student_fee_id uuid NOT NULL REFERENCES student_fees(id) ON DELETE RESTRICT,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  journal_entry_id uuid REFERENCES finance_journal_entries(id) ON DELETE SET NULL,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_account_credits_student_idx
  ON student_account_credits(organisation_id,student_id,status,created_at);
CREATE INDEX IF NOT EXISTS student_credit_applications_fee_idx
  ON student_credit_applications(student_fee_id,created_at);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('approvals.view','Approvals','view','View approvals','Open the central approval queue across Admissions, Reports and Leave',150),
('approvals.manage','Approvals','approve','Action approvals','Approve or decline application workflows available to the role',151)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE WHEN sr.key IN('school_admin','headteacher') OR lower(sr.name) IN('headmaster','head master','principal') THEN true ELSE false END
FROM school_roles sr
CROSS JOIN (VALUES('approvals.view'),('approvals.manage')) c(key)
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,'leave.review',true
FROM school_roles sr
WHERE sr.key IN('school_admin','headteacher') OR lower(sr.name) IN('headmaster','head master','principal')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Performance indexes for commonly opened pages.
CREATE INDEX IF NOT EXISTS students_org_status_name_fast_idx
  ON students(organisation_id,status,last_name,first_name);
CREATE INDEX IF NOT EXISTS admission_applications_org_status_submitted_idx
  ON admission_applications(organisation_id,status,submitted_at DESC);
CREATE INDEX IF NOT EXISTS school_role_capabilities_org_role_idx
  ON school_role_capabilities(organisation_id,role,capability_key);
CREATE INDEX IF NOT EXISTS teacher_assignments_org_active_idx
  ON teacher_assignments(organisation_id,is_active,academic_year_id,term_id,classroom_id);
CREATE INDEX IF NOT EXISTS timetable_entries_org_year_term_idx
  ON timetable_entries(organisation_id,academic_year_id,term_id,classroom_id,day_of_week);
