-- A school's identity is (organisation,user), even when legacy memberships share
-- an OS user key. Preserve those keys, credentials and historical record links.
CREATE TABLE school_accounts (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email varchar(320),
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  status varchar(20) NOT NULL CHECK(status IN('invited','active','suspended','disabled')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,user_id),
  CHECK(email IS NULL OR email=lower(btrim(email)))
);
CREATE UNIQUE INDEX uq_school_accounts_email ON school_accounts(organisation_id,lower(email)) WHERE email IS NOT NULL;

INSERT INTO school_accounts(organisation_id,user_id,email,first_name,last_name,status)
SELECT m.organisation_id,u.id,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END,u.first_name,u.last_name,u.status
FROM organisation_memberships m JOIN users u ON u.id=m.user_id JOIN organisations o ON o.id=m.organisation_id
WHERE o.settings->>'application'='school'
   OR EXISTS(SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school')
   OR EXISTS(SELECT 1 FROM school_credentials sc WHERE sc.organisation_id=o.id AND sc.user_id=u.id);

-- Old setup/import paths can still create memberships or credentials. Initialize
-- a missing school profile once; later OS changes must never overwrite it.
CREATE FUNCTION initialize_school_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='school_credentials' OR EXISTS(
    SELECT 1 FROM organisations o WHERE o.id=NEW.organisation_id AND (
      o.settings->>'application'='school' OR EXISTS(
        SELECT 1 FROM saas_customers c WHERE c.customer_organisation_id=o.id AND c.customer_type='school'))
  ) THEN
    INSERT INTO school_accounts(organisation_id,user_id,email,first_name,last_name,status)
    SELECT NEW.organisation_id,u.id,CASE WHEN u.email LIKE '%@revolt-x.local' THEN NULL ELSE u.email END,u.first_name,u.last_name,u.status
    FROM users u WHERE u.id=NEW.user_id
    ON CONFLICT(organisation_id,user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_school_membership_identity AFTER INSERT ON organisation_memberships FOR EACH ROW EXECUTE FUNCTION initialize_school_account();
CREATE TRIGGER trg_school_credential_identity AFTER INSERT ON school_credentials FOR EACH ROW EXECUTE FUNCTION initialize_school_account();

-- Both the familiar local Staff ID and the legacy login alias belong to a school.
DROP INDEX IF EXISTS ux_organisation_memberships_login_staff_id;
CREATE UNIQUE INDEX uq_school_login_staff_id ON organisation_memberships(organisation_id,lower(login_staff_id)) WHERE login_staff_id IS NOT NULL;
CREATE UNIQUE INDEX uq_school_employee_number ON organisation_memberships(organisation_id,lower(employee_number)) WHERE employee_number IS NOT NULL;

-- A legacy alias must not identify a different member's local Staff ID. Use the
-- same organisation lock as staff-number allocation to serialize concurrent edits.
CREATE FUNCTION check_school_staff_identifiers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('school-staff-number:'||NEW.organisation_id::text));
  IF EXISTS(SELECT 1 FROM organisation_memberships m WHERE m.organisation_id=NEW.organisation_id AND m.id<>NEW.id
    AND (lower(m.employee_number) IN(lower(NEW.employee_number),lower(NEW.login_staff_id))
      OR lower(m.login_staff_id) IN(lower(NEW.employee_number),lower(NEW.login_staff_id)))) THEN
    RAISE EXCEPTION 'Staff ID is already in use in this school' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_school_staff_identifiers BEFORE INSERT OR UPDATE OF organisation_id,employee_number,login_staff_id
  ON organisation_memberships FOR EACH ROW EXECUTE FUNCTION check_school_staff_identifiers();
