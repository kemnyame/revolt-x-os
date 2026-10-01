ALTER TABLE school_license_state
  ADD COLUMN IF NOT EXISTS organisation_admin_email varchar(320);

CREATE INDEX IF NOT EXISTS school_license_state_admin_email_idx
  ON school_license_state(organisation_admin_email)
  WHERE organisation_admin_email IS NOT NULL;
