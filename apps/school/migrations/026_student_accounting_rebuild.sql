-- Robust student receipting, fee-to-income mapping and payment setup.

ALTER TABLE fee_items
  ADD COLUMN IF NOT EXISTS income_account_id uuid REFERENCES finance_accounts(id);

UPDATE fee_items f
SET income_account_id=fa.id
FROM finance_accounts fa
WHERE f.income_account_id IS NULL
  AND fa.organisation_id=f.organisation_id
  AND fa.code='4000';

CREATE TABLE IF NOT EXISTS finance_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  method_key varchar(30) NOT NULL CHECK(method_key IN('cash','mobile_money','bank','card','other')),
  label varchar(120) NOT NULL,
  settlement_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  provider varchar(60),
  enabled boolean NOT NULL DEFAULT true,
  allow_manual_receipt boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,method_key)
);

INSERT INTO finance_payment_methods(organisation_id,method_key,label,settlement_account_id,provider)
SELECT sp.organisation_id,v.method_key,v.label,fa.id,v.provider
FROM school_profiles sp
CROSS JOIN (VALUES
 ('cash','Cash','1000','Internal'),
 ('bank','Bank Transfer / Deposit','1010','Manual'),
 ('mobile_money','Mobile Money','1020','Paystack / Manual'),
 ('card','Card','1030','Paystack'),
 ('other','Other Receipt','1000','Manual')
) v(method_key,label,account_code,provider)
JOIN finance_accounts fa ON fa.organisation_id=sp.organisation_id AND fa.code=v.account_code
ON CONFLICT(organisation_id,method_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS finance_student_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  receipt_no varchar(70) NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  payment_method_id uuid NOT NULL REFERENCES finance_payment_methods(id),
  settlement_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  reference varchar(160),
  note varchar(1200),
  paid_at timestamptz NOT NULL DEFAULT now(),
  status varchar(20) NOT NULL DEFAULT 'posted' CHECK(status IN('posted','voided')),
  journal_entry_id uuid REFERENCES finance_journal_entries(id),
  received_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,receipt_no)
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS finance_receipt_id uuid REFERENCES finance_student_receipts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS income_account_id uuid REFERENCES finance_accounts(id);

CREATE TABLE IF NOT EXISTS finance_student_receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES finance_student_receipts(id) ON DELETE CASCADE,
  student_fee_id uuid REFERENCES student_fees(id) ON DELETE RESTRICT,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  income_account_id uuid REFERENCES finance_accounts(id),
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(student_fee_id IS NOT NULL OR income_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS finance_student_receipts_student_idx
  ON finance_student_receipts(organisation_id,student_id,paid_at DESC);
CREATE INDEX IF NOT EXISTS finance_student_receipt_allocations_receipt_idx
  ON finance_student_receipt_allocations(receipt_id);
CREATE INDEX IF NOT EXISTS finance_payment_methods_org_idx
  ON finance_payment_methods(organisation_id,enabled,method_key);
CREATE INDEX IF NOT EXISTS fee_items_income_account_idx
  ON fee_items(organisation_id,income_account_id);
CREATE INDEX IF NOT EXISTS payments_finance_receipt_idx
  ON payments(finance_receipt_id);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('finance.receive_student_payment','Finance','create','Receive student payments','Search students, allocate receipts and post the related finance journal',137),
('finance.payment_setup','Finance','edit','Manage payment setup','Map receipt methods and fee items to finance accounts',138)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE
    WHEN sr.key IN('school_admin','accountant') THEN true
    WHEN sr.key='bursar' AND c.key='finance.receive_student_payment' THEN true
    ELSE false
  END
FROM school_roles sr
CROSS JOIN (VALUES('finance.receive_student_payment'),('finance.payment_setup')) c(key)
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
