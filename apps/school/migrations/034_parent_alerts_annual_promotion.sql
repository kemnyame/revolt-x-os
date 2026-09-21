-- Parent in-app alerts and academic-year promotion evidence.

CREATE TABLE IF NOT EXISTS guardian_alert_reads (
  guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  communication_id uuid NOT NULL REFERENCES communication_outbox(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guardian_id,communication_id)
);

CREATE INDEX IF NOT EXISTS guardian_alert_reads_guardian_idx
  ON guardian_alert_reads(guardian_id,read_at DESC);

ALTER TABLE student_promotions
  ADD COLUMN IF NOT EXISTS academic_average numeric(6,2),
  ADD COLUMN IF NOT EXISTS terms_count integer,
  ADD COLUMN IF NOT EXISTS promotion_basis varchar(40);

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='student_promotions_terms_count_check'
      AND conrelid='student_promotions'::regclass
  ) THEN
    ALTER TABLE student_promotions
      ADD CONSTRAINT student_promotions_terms_count_check
      CHECK(terms_count IS NULL OR (terms_count>=0 AND terms_count<=3));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='student_promotions_basis_check'
      AND conrelid='student_promotions'::regclass
  ) THEN
    ALTER TABLE student_promotions
      ADD CONSTRAINT student_promotions_basis_check
      CHECK(promotion_basis IS NULL OR promotion_basis IN('academic_year_average','manual_override'));
  END IF;
END $$;
