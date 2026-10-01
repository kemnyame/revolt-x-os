-- Report workflow hardening: automatic signatures and system-led promotion with reviewer override.

CREATE TABLE IF NOT EXISTS report_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  signer_role varchar(20) NOT NULL CHECK(signer_role IN('teacher','headteacher')),
  display_name varchar(200) NOT NULL,
  signature_image_data text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,os_user_id,signer_role)
);

CREATE INDEX IF NOT EXISTS report_signatures_org_idx
  ON report_signatures(organisation_id,signer_role,is_active);

ALTER TABLE report_comments
  ADD COLUMN IF NOT EXISTS promotion_override_reason text,
  ADD COLUMN IF NOT EXISTS promotion_overridden_by_os_user_id uuid;

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='report_comments_promotion_basis_check'
      AND conrelid='report_comments'::regclass
  ) THEN
    ALTER TABLE report_comments DROP CONSTRAINT report_comments_promotion_basis_check;
  END IF;

  ALTER TABLE report_comments
    ADD CONSTRAINT report_comments_promotion_basis_check
    CHECK(promotion_basis IS NULL OR promotion_basis IN('threshold','teacher_override','reviewer_override'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
