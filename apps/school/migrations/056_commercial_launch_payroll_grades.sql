-- Revolt-X School commercial-launch hardening.
--
-- This migration intentionally keeps historical migrations intact. Applied migrations are part
-- of the database's audit trail and must never be deleted simply because the application has
-- moved away from an older feature such as Quick Login. Instead, the current production
-- constraints below remove obsolete runtime behaviours while preserving migration history.

-- -----------------------------------------------------------------------------
-- 1. Licence cache outage controls
-- -----------------------------------------------------------------------------
-- The School application keeps the most recent Core OS entitlement locally so a brief Core OS
-- outage does not interrupt teaching, attendance or other daily work. These fields make that
-- fallback finite and observable. The application will stop trusting a cached entitlement once
-- LICENSE_OUTAGE_GRACE_HOURS has elapsed since the last successful Core OS sync.
ALTER TABLE school_license_state
  ADD COLUMN IF NOT EXISTS last_core_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_core_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS outage_grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_core_error text;

UPDATE school_license_state
SET last_core_success_at=COALESCE(last_core_success_at,synced_at),
    outage_grace_ends_at=COALESCE(outage_grace_ends_at,synced_at + interval '72 hours')
WHERE synced_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Remove obsolete School-session sources from the active production contract
-- -----------------------------------------------------------------------------
-- Existing preview/quick-login sessions are revoked before the tighter CHECK is installed. This
-- means an old browser token cannot continue to use a login path that no longer exists.
UPDATE school_sessions
SET revoked_at=COALESCE(revoked_at,now())
WHERE source IN('preview','quick_login');

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='school_sessions_source_check'
      AND conrelid='school_sessions'::regclass
  ) THEN
    ALTER TABLE school_sessions DROP CONSTRAINT school_sessions_source_check;
  END IF;

  ALTER TABLE school_sessions
    ADD CONSTRAINT school_sessions_source_check
    CHECK(source IN('core_exchange','staff_id','admin_email'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Payroll grades
-- -----------------------------------------------------------------------------
-- A payroll grade holds the shared salary package for staff on the same grade. Individual staff
-- records only need personal exceptions such as loans, advances or a negotiated adjustment.
CREATE TABLE IF NOT EXISTS payroll_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(40) NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  base_salary numeric(14,2) NOT NULL DEFAULT 0 CHECK(base_salary>=0),
  currency varchar(10) NOT NULL DEFAULT 'GHS',
  is_active boolean NOT NULL DEFAULT true,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,code)
);

CREATE TABLE IF NOT EXISTS payroll_grade_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  payroll_grade_id uuid NOT NULL REFERENCES payroll_grades(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES payroll_components(id) ON DELETE CASCADE,
  value_override numeric(14,2) CHECK(value_override IS NULL OR value_override>=0),
  rate_override numeric(8,4) CHECK(rate_override IS NULL OR rate_override>=0),
  is_active boolean NOT NULL DEFAULT true,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payroll_grade_id,component_id)
);

ALTER TABLE staff_payroll_profiles
  ADD COLUMN IF NOT EXISTS payroll_grade_id uuid REFERENCES payroll_grades(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS use_grade_salary boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS payroll_grades_org_idx
  ON payroll_grades(organisation_id,is_active,code);
CREATE INDEX IF NOT EXISTS payroll_grade_components_grade_idx
  ON payroll_grade_components(organisation_id,payroll_grade_id,is_active);
CREATE INDEX IF NOT EXISTS staff_payroll_profiles_grade_idx
  ON staff_payroll_profiles(organisation_id,payroll_grade_id,is_active);

-- -----------------------------------------------------------------------------
-- 4. Finance review before GL posting
-- -----------------------------------------------------------------------------
-- Draft -> submitted_to_finance -> approved_for_payment -> paid.
-- Finance may return a run to HR without any journal entry being posted.
DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='payroll_runs_status_check'
      AND conrelid='payroll_runs'::regclass
  ) THEN
    ALTER TABLE payroll_runs DROP CONSTRAINT payroll_runs_status_check;
  END IF;

  ALTER TABLE payroll_runs
    ADD CONSTRAINT payroll_runs_status_check
    CHECK(status IN('draft','submitted_to_finance','returned_to_hr','approved_for_payment','paid','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS finance_review_note text,
  ADD COLUMN IF NOT EXISTS returned_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz;

-- Runs that were previously submitted under the old flow may already contain an accrual journal.
-- They are retained as historical records. New application code does not post the accrual until
-- Finance explicitly approves the run.
