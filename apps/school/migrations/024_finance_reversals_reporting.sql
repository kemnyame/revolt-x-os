ALTER TABLE finance_journal_entries
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_entry_id uuid REFERENCES finance_journal_entries(id);

CREATE INDEX IF NOT EXISTS finance_journal_entries_period_idx
  ON finance_journal_entries(organisation_id,status,entry_date);

CREATE INDEX IF NOT EXISTS finance_expenses_period_idx
  ON finance_expenses(organisation_id,status,expense_date);

CREATE INDEX IF NOT EXISTS student_fees_org_status_idx
  ON student_fees(organisation_id,status,student_id);

ALTER TABLE finance_tax_types
  ADD COLUMN IF NOT EXISTS filing_frequency varchar(20) DEFAULT 'monthly'
    CHECK(filing_frequency IN('monthly','quarterly','annual','other'));

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('finance.reverse','Finance','delete','Reverse finance transactions','Reverse posted expenses and journals while preserving audit history',136)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,'finance.reverse',
  CASE WHEN sr.key IN('school_admin','accountant') THEN true ELSE false END
FROM school_roles sr
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
