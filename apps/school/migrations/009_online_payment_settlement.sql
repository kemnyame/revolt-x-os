ALTER TABLE payments
  ALTER COLUMN received_by_os_user_id DROP NOT NULL;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS source varchar(30) NOT NULL DEFAULT 'school_manual',
  ADD COLUMN IF NOT EXISTS payment_intent_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema='revolt_x_school'
      AND table_name='payments'
      AND constraint_name='payments_source_check'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_source_check
      CHECK(source IN('school_manual','parent_online','school_online'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_intent_unique
  ON payments(payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
