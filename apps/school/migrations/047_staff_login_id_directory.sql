ALTER TABLE school_user_directory
  ADD COLUMN IF NOT EXISTS login_staff_id varchar(120);

CREATE INDEX IF NOT EXISTS ix_school_user_directory_login_staff_id
  ON school_user_directory(organisation_id,lower(login_staff_id))
  WHERE login_staff_id IS NOT NULL;
