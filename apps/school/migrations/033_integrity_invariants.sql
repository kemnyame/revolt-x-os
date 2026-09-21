-- Revolt-X School production hardening phase 4
-- Enforce single-current academic state and idempotent finance posting.

CREATE UNIQUE INDEX IF NOT EXISTS academic_years_one_active_per_org_idx
  ON academic_years(organisation_id)
  WHERE status='active';

CREATE UNIQUE INDEX IF NOT EXISTS terms_one_active_per_org_idx
  ON terms(organisation_id)
  WHERE status='active';

CREATE UNIQUE INDEX IF NOT EXISTS enrolments_one_active_per_student_idx
  ON enrolments(student_id)
  WHERE status='active';

CREATE UNIQUE INDEX IF NOT EXISTS student_guardians_one_primary_idx
  ON student_guardians(student_id)
  WHERE is_primary=true;

CREATE UNIQUE INDEX IF NOT EXISTS finance_journal_source_idempotency_idx
  ON finance_journal_entries(organisation_id,source_type,source_id)
  WHERE source_type IS NOT NULL
    AND source_id IS NOT NULL
    AND status<>'voided';

CREATE INDEX IF NOT EXISTS guardian_portal_sessions_active_idx
  ON guardian_portal_sessions(guardian_id,expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS student_portal_sessions_active_idx
  ON student_portal_sessions(student_id,expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS school_sessions_active_idx
  ON school_sessions(organisation_id,os_user_id,expires_at DESC)
  WHERE revoked_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM pg_constraint
    WHERE conname='student_fees_discount_valid_check'
      AND conrelid='student_fees'::regclass
  ) THEN
    ALTER TABLE student_fees
      ADD CONSTRAINT student_fees_discount_valid_check
      CHECK(discount>=0 AND amount_due>=0 AND discount<=amount_due);
  END IF;
END $$;
