-- Normalize legacy Class Teacher data before enforcing the rule.
-- classrooms.class_teacher_os_user_id represents the whole-year Class Teacher only.
UPDATE classrooms c
SET class_teacher_os_user_id=NULL
WHERE class_teacher_os_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM teacher_assignments ta
    WHERE ta.organisation_id=c.organisation_id
      AND ta.academic_year_id=c.academic_year_id
      AND ta.classroom_id=c.id
      AND ta.teacher_os_user_id=c.class_teacher_os_user_id
      AND ta.subject_id IS NULL
      AND ta.term_id IS NULL
      AND ta.is_active=true
  );

-- If legacy data gives the same teacher different Class Teacher classes in one year,
-- keep the whole-year assignment first, otherwise the oldest assignment.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY organisation_id,academic_year_id,teacher_os_user_id
           ORDER BY (term_id IS NULL) DESC,created_at,id
         ) rn,
         first_value(classroom_id) OVER (
           PARTITION BY organisation_id,academic_year_id,teacher_os_user_id
           ORDER BY (term_id IS NULL) DESC,created_at,id
         ) keep_classroom_id
  FROM teacher_assignments
  WHERE subject_id IS NULL AND is_active=true
)
UPDATE teacher_assignments ta
SET is_active=false
FROM ranked r
WHERE ta.id=r.id
  AND r.rn>1
  AND ta.classroom_id<>r.keep_classroom_id;

-- Re-sync the whole-year shortcut field.
UPDATE classrooms c
SET class_teacher_os_user_id=ta.teacher_os_user_id
FROM teacher_assignments ta
WHERE ta.organisation_id=c.organisation_id
  AND ta.academic_year_id=c.academic_year_id
  AND ta.classroom_id=c.id
  AND ta.subject_id IS NULL
  AND ta.term_id IS NULL
  AND ta.is_active=true;

CREATE UNIQUE INDEX IF NOT EXISTS classrooms_one_class_per_teacher_year_idx
  ON classrooms(organisation_id,academic_year_id,class_teacher_os_user_id)
  WHERE is_active=true AND class_teacher_os_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_single_active_class_teacher()
RETURNS trigger AS $$
BEGIN
  IF NEW.subject_id IS NULL AND NEW.is_active=true THEN
    IF EXISTS (
      SELECT 1
      FROM teacher_assignments ta
      WHERE ta.organisation_id=NEW.organisation_id
        AND ta.academic_year_id=NEW.academic_year_id
        AND ta.teacher_os_user_id=NEW.teacher_os_user_id
        AND ta.subject_id IS NULL
        AND ta.is_active=true
        AND ta.classroom_id<>NEW.classroom_id
        AND ta.id<>NEW.id
    ) THEN
      RAISE EXCEPTION 'A teacher can be Class Teacher for only one active class in an academic year'
        USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teacher_assignments_single_class_teacher_trg ON teacher_assignments;
CREATE TRIGGER teacher_assignments_single_class_teacher_trg
BEFORE INSERT OR UPDATE OF teacher_os_user_id,classroom_id,academic_year_id,subject_id,is_active
ON teacher_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_single_active_class_teacher();
