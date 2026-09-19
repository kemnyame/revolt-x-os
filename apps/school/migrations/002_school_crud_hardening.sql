ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS void_reason varchar(500);

ALTER TABLE guardians
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS school_payments_active_idx
  ON payments(organisation_id, paid_at DESC)
  WHERE voided_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS school_timetable_unique_slot_idx
  ON timetable_entries(organisation_id,classroom_id,day_of_week,start_time,end_time)
  WHERE term_id IS NOT NULL;
