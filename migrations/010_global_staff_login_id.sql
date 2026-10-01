-- Canonical global Staff ID used by Revolt-X School login.
ALTER TABLE organisation_memberships
  ADD COLUMN IF NOT EXISTS login_staff_id varchar(120);

-- Backfill every existing membership using the organisation slug plus a stable sequence.
WITH ranked AS (
  SELECT m.id,m.organisation_id,o.slug,
         row_number() OVER(PARTITION BY m.organisation_id ORDER BY m.joined_at,m.id) AS rn
  FROM organisation_memberships m
  JOIN organisations o ON o.id=m.organisation_id
)
UPDATE organisation_memberships m
SET login_staff_id=upper(regexp_replace(r.slug,'[^a-zA-Z0-9]+','-','g'))||
                   '-STF-'||lpad(r.rn::text,6,'0')
FROM ranked r
WHERE m.id=r.id
  AND (m.login_staff_id IS NULL OR btrim(m.login_staff_id)='');

CREATE UNIQUE INDEX IF NOT EXISTS ux_organisation_memberships_login_staff_id
  ON organisation_memberships(lower(login_staff_id))
  WHERE login_staff_id IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_global_staff_login_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  org_slug text;
  prefix text;
  next_no integer;
BEGIN
  IF NEW.login_staff_id IS NOT NULL AND btrim(NEW.login_staff_id)<>'' THEN
    NEW.login_staff_id=upper(NEW.login_staff_id);
    RETURN NEW;
  END IF;

  SELECT slug INTO org_slug FROM organisations WHERE id=NEW.organisation_id;
  IF org_slug IS NULL THEN
    RAISE EXCEPTION 'Organisation not found for Staff ID generation';
  END IF;

  prefix:=upper(regexp_replace(org_slug,'[^a-zA-Z0-9]+','-','g'))||'-STF-';
  PERFORM pg_advisory_xact_lock(hashtext('global-school-staff-id:'||NEW.organisation_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN login_staff_id ~ ('^'||prefix||'[0-9]{6}$')
         THEN right(login_staff_id,6)::int
         ELSE NULL END
  ),0)+1
  INTO next_no
  FROM organisation_memberships
  WHERE organisation_id=NEW.organisation_id;

  NEW.login_staff_id:=prefix||lpad(next_no::text,6,'0');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_assign_global_staff_login_id ON organisation_memberships;
CREATE TRIGGER trg_assign_global_staff_login_id
BEFORE INSERT OR UPDATE OF organisation_id,login_staff_id ON organisation_memberships
FOR EACH ROW
EXECUTE FUNCTION assign_global_staff_login_id();
