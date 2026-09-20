-- Revolt-X School production hardening
-- Adds persistent portal throttling, communication retry metadata and targeted indexes.

CREATE TABLE IF NOT EXISTS portal_login_throttle(
  portal varchar(40) NOT NULL,
  throttle_key varchar(96) NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(portal,throttle_key)
);

CREATE INDEX IF NOT EXISTS portal_login_throttle_blocked_idx
  ON portal_login_throttle(blocked_until)
  WHERE blocked_until IS NOT NULL;

ALTER TABLE communication_outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='communication_outbox_max_attempts_check'
      AND conrelid='communication_outbox'::regclass
  ) THEN
    ALTER TABLE communication_outbox
      ADD CONSTRAINT communication_outbox_max_attempts_check
      CHECK(max_attempts BETWEEN 1 AND 20);
  END IF;
END $$;

UPDATE communication_outbox
SET next_attempt_at=COALESCE(next_attempt_at,now())
WHERE status IN('queued','failed','pending_configuration')
  AND next_attempt_at IS NULL;

CREATE INDEX IF NOT EXISTS communication_outbox_retry_idx
  ON communication_outbox(status,next_attempt_at,created_at)
  WHERE status IN('queued','failed','pending_configuration');

CREATE INDEX IF NOT EXISTS payments_org_paid_at_idx
  ON payments(organisation_id,paid_at DESC)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS student_fees_org_student_idx
  ON student_fees(organisation_id,student_id,created_at DESC);

CREATE INDEX IF NOT EXISTS report_comments_workflow_idx
  ON report_comments(organisation_id,workflow_status,submitted_at DESC);

CREATE INDEX IF NOT EXISTS attendance_org_student_date_idx
  ON attendance_records(organisation_id,student_id,attendance_date DESC);

CREATE INDEX IF NOT EXISTS assessment_scores_student_idx
  ON assessment_scores(student_id,assessment_id);
