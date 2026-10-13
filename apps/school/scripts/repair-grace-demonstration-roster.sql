-- One-time repair requested for the Grace Prep demonstration roster.
-- Run in a transaction after validating on a branch of the School database.
-- IDs, admission numbers, enrolments, marks, guardians and payments are retained.
SET LOCAL search_path TO revolt_x_school, public;

WITH numbered AS (
  SELECT id,sex,row_number() OVER (ORDER BY admission_no,id)-1 n
  FROM students
  WHERE organisation_id='f0941926-e7cf-46cf-b994-888ba642dd7d'
    AND notes='Grace Prep demonstration learner record'
), names AS (
  SELECT id,
    CASE WHEN sex='female'
      THEN (ARRAY['Ama','Akosua','Adwoa','Esi','Afia','Abena','Mansa','Araba','Grace','Mabel','Linda','Akua','Adelaide','Maame','Adjoa'])[n%15+1]
      ELSE (ARRAY['Kwame','Kofi','Kojo','Yaw','Kweku','Kwabena','Fiifi','Kobby','Nana','Samuel','Joseph','Daniel','Michael','Emmanuel','David'])[n%15+1]
    END first_name,
    (ARRAY['Mensah','Owusu','Asare','Addo','Appiah','Amponsah','Tetteh','Frimpong','Kusi','Darko'])[n/15+1] last_name
  FROM numbered
)
UPDATE students s SET first_name=n.first_name,last_name=n.last_name,updated_at=now()
FROM names n WHERE s.id=n.id AND (s.first_name IS DISTINCT FROM n.first_name OR s.last_name IS DISTINCT FROM n.last_name);

-- The imported class-teacher shortcut was populated without assignment records.
-- Only fill the missing whole-year link when it agrees with active teaching access
-- and cannot conflict with another class-teacher allocation in the same year.
INSERT INTO teacher_assignments(organisation_id,academic_year_id,classroom_id,subject_id,teacher_os_user_id,is_active)
SELECT c.organisation_id,c.academic_year_id,c.id,NULL,c.class_teacher_os_user_id,true
FROM classrooms c
JOIN school_memberships m ON m.organisation_id=c.organisation_id AND m.os_user_id=c.class_teacher_os_user_id AND m.status='active'
JOIN school_roles r ON r.organisation_id=m.organisation_id AND r.key=m.role AND r.is_active AND r.can_teach
WHERE c.organisation_id='f0941926-e7cf-46cf-b994-888ba642dd7d' AND c.is_active
  AND c.class_teacher_os_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM teacher_assignments a WHERE a.organisation_id=c.organisation_id
    AND a.academic_year_id=c.academic_year_id AND a.classroom_id=c.id AND a.subject_id IS NULL AND a.term_id IS NULL AND a.is_active)
  AND NOT EXISTS (SELECT 1 FROM teacher_assignments a WHERE a.organisation_id=c.organisation_id
    AND a.academic_year_id=c.academic_year_id AND a.teacher_os_user_id=c.class_teacher_os_user_id
    AND a.classroom_id<>c.id AND a.subject_id IS NULL AND a.is_active);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM students WHERE organisation_id='f0941926-e7cf-46cf-b994-888ba642dd7d'
    GROUP BY lower(btrim(first_name)||' '||btrim(last_name)) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'The repaired demonstration roster still contains duplicate names';
  END IF;
END $$;
