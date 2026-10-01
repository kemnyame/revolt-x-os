-- School setup catalogue visibility and admission-to-student onboarding support.

CREATE INDEX IF NOT EXISTS admission_applications_approved_onboarding_idx
  ON admission_applications(organisation_id,status,reviewed_at DESC,submitted_at DESC)
  WHERE status='approved' AND student_id IS NULL;

CREATE INDEX IF NOT EXISTS subjects_org_stage_active_idx
  ON subjects(organisation_id,stage,is_active,name);

CREATE INDEX IF NOT EXISTS classrooms_org_year_grade_active_idx
  ON classrooms(organisation_id,academic_year_id,grade_level_id,is_active,name);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('school_setup.catalogue.manage','Academic','edit','Manage school setup catalogue','Create and manage grade levels, classes and subjects from School Setup',24),
('admissions.enrol','Admissions','create','Enrol approved admissions','Convert approved admission applications into student records without duplicate entry',112)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE WHEN sr.key IN('school_admin','registrar','headteacher') THEN true ELSE false END
FROM school_roles sr
CROSS JOIN (VALUES('school_setup.catalogue.manage'),('admissions.enrol')) c(key)
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
