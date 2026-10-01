-- Standardise automatic staff IDs for every organisation membership.
-- Existing staff IDs are preserved; only missing IDs are backfilled.
WITH existing_max AS (
  SELECT organisation_id,
         COALESCE(MAX(
           CASE WHEN employee_number ~ '^STF-[0-9]{6}$'
                THEN substring(employee_number from 5)::int
                ELSE NULL END
         ),0) AS max_no
  FROM organisation_memberships
  GROUP BY organisation_id
),
missing AS (
  SELECT m.id,m.organisation_id,
         ROW_NUMBER() OVER(PARTITION BY m.organisation_id ORDER BY m.joined_at,m.id) AS rn
  FROM organisation_memberships m
  WHERE m.employee_number IS NULL OR btrim(m.employee_number)=''
)
UPDATE organisation_memberships m
SET employee_number='STF-'||lpad((x.max_no+z.rn)::text,6,'0')
FROM missing z
JOIN existing_max x ON x.organisation_id=z.organisation_id
WHERE m.id=z.id;

CREATE OR REPLACE FUNCTION assign_organisation_staff_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_no integer;
BEGIN
  IF NEW.employee_number IS NOT NULL AND btrim(NEW.employee_number)<>'' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('organisation-staff-id:'||NEW.organisation_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN employee_number ~ '^STF-[0-9]{6}$'
         THEN substring(employee_number from 5)::int
         ELSE NULL END
  ),0)+1
  INTO next_no
  FROM organisation_memberships
  WHERE organisation_id=NEW.organisation_id;

  NEW.employee_number:='STF-'||lpad(next_no::text,6,'0');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_assign_organisation_staff_id ON organisation_memberships;
CREATE TRIGGER trg_assign_organisation_staff_id
BEFORE INSERT ON organisation_memberships
FOR EACH ROW
EXECUTE FUNCTION assign_organisation_staff_id();
