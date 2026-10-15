-- Payroll keeps immutable component-to-GL snapshots from preparation to payment.
ALTER TABLE payroll_components ADD COLUMN IF NOT EXISTS posting_account_id uuid REFERENCES finance_accounts(id);
ALTER TABLE payroll_run_item_components ADD COLUMN IF NOT EXISTS posting_account_id uuid REFERENCES finance_accounts(id);
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS payment_reference varchar(160),
  ADD COLUMN IF NOT EXISTS payment_date date,
  ADD COLUMN IF NOT EXISTS payable_account_id uuid REFERENCES finance_accounts(id);
ALTER TABLE payroll_run_items
  ADD COLUMN IF NOT EXISTS salary_grade_code varchar(40),
  ADD COLUMN IF NOT EXISTS salary_grade_name varchar(160);

CREATE TABLE IF NOT EXISTS payroll_account_settings (
  organisation_id uuid PRIMARY KEY,
  expense_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  payable_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  payment_account_id uuid NOT NULL REFERENCES finance_accounts(id),
  updated_by_os_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_system)
SELECT organisation_id,v.code,v.name,v.account_type,v.subtype,true FROM school_profiles
CROSS JOIN (VALUES
 ('2110','PAYE Payable','liability','payroll_tax'),
 ('2120','Pension Contributions Payable','liability','payroll_pension'),
 ('1130','Staff Loans Receivable','asset','staff_loans')
) v(code,name,account_type,subtype)
ON CONFLICT(organisation_id,code) DO NOTHING;

-- Give every other deduction its own account, preserving later school overrides.
INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_system)
SELECT organisation_id,'PD-'||substr(md5(code),1,12),left(name||' Payable',180),'liability','payroll_deduction',true
FROM payroll_components WHERE component_type='deduction' AND code NOT IN('PAYE','SSNIT','LOAN')
ON CONFLICT(organisation_id,code) DO NOTHING;

UPDATE payroll_components c SET posting_account_id=a.id FROM finance_accounts a
WHERE a.organisation_id=c.organisation_id AND c.posting_account_id IS NULL
  AND a.code=CASE WHEN c.component_type='earning' THEN '5000'
    WHEN c.code='PAYE' THEN '2110' WHEN c.code='SSNIT' THEN '2120' WHEN c.code='LOAN' THEN '1130'
    ELSE 'PD-'||substr(md5(c.code),1,12) END;

INSERT INTO payroll_account_settings(organisation_id,expense_account_id,payable_account_id,payment_account_id)
SELECT sp.organisation_id,e.id,p.id,b.id FROM school_profiles sp
JOIN finance_accounts e ON e.organisation_id=sp.organisation_id AND e.code='5000'
JOIN finance_accounts p ON p.organisation_id=sp.organisation_id AND p.code='2050'
JOIN finance_accounts b ON b.organisation_id=sp.organisation_id AND b.code='1010'
ON CONFLICT(organisation_id) DO NOTHING;

UPDATE payroll_runs r SET payable_account_id=a.id FROM finance_accounts a
WHERE a.organisation_id=r.organisation_id AND a.code='2050' AND r.payable_account_id IS NULL;

UPDATE payroll_run_item_components snap SET posting_account_id=c.posting_account_id
FROM payroll_components c WHERE c.id=snap.component_id AND snap.posting_account_id IS NULL;
UPDATE payroll_run_item_components snap SET posting_account_id=a.id
FROM payroll_run_items item JOIN finance_accounts a ON a.organisation_id=item.organisation_id AND a.code='5000'
WHERE item.id=snap.payroll_run_item_id AND snap.code='BASIC' AND snap.posting_account_id IS NULL;

-- "completed_with_warnings" has 23 characters; the old 20-character field broke EOD.
ALTER TABLE finance_eod_runs ALTER COLUMN status TYPE varchar(30);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
 ('payroll.publish','HR & Payroll','publish','Publish paid payroll','Release paid payslips to individual staff',153),
 ('reports.operations','Reports','view','School reporting centre','Generate permission-scoped operational reports',154)
ON CONFLICT(key) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description;
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT r.organisation_id,r.key,c.key,
 CASE WHEN c.key='payroll.publish' THEN r.key IN('school_admin','headteacher','registrar')
 ELSE r.key IN('school_admin','headteacher','registrar','accountant','bursar','teacher') END
FROM school_roles r CROSS JOIN (VALUES('payroll.publish'),('reports.operations')) c(key)
ON CONFLICT(organisation_id,role,capability_key) DO NOTHING;

-- Closed periods are read-only, and only the current year can have an active term.
UPDATE academic_years SET is_locked=true WHERE status='closed';
UPDATE terms SET status='closed',is_locked=true
WHERE status='active' AND academic_year_id IN(SELECT id FROM academic_years WHERE status<>'active' OR is_locked);
UPDATE terms SET is_locked=true WHERE status='closed';

CREATE TABLE IF NOT EXISTS timetable_agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organisation_id uuid NOT NULL,
 academic_year_id uuid NOT NULL REFERENCES academic_years(id),
 term_id uuid REFERENCES terms(id),
 actor_os_user_id uuid NOT NULL,
 status varchar(20) NOT NULL CHECK(status IN('preview','applied','infeasible')),
 summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timetable_agent_runs_org_time_idx ON timetable_agent_runs(organisation_id,created_at DESC);
