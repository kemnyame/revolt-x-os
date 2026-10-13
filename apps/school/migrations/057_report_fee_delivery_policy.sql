ALTER TABLE school_security_settings
  ADD COLUMN IF NOT EXISTS block_report_delivery_when_fees_owed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN school_security_settings.block_report_delivery_when_fees_owed IS
  'When enabled, approved reports are not released or delivered to guardians while the student has an outstanding school fee balance.';

CREATE INDEX IF NOT EXISTS idx_student_fees_org_student_report_gate
  ON student_fees(organisation_id,student_id);

CREATE INDEX IF NOT EXISTS idx_payments_student_fee_active
  ON payments(student_fee_id)
  WHERE voided_at IS NULL;
