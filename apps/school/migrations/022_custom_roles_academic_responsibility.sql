-- Custom school roles, user access profiles and multi-tenant role capabilities.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='school_memberships_role_check'
  ) THEN
    ALTER TABLE school_memberships DROP CONSTRAINT school_memberships_role_check;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='school_role_capabilities_role_check'
  ) THEN
    ALTER TABLE school_role_capabilities DROP CONSTRAINT school_role_capabilities_role_check;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS school_roles (
  organisation_id uuid NOT NULL,
  key varchar(40) NOT NULL,
  name varchar(120) NOT NULL,
  description varchar(500),
  portal_mode varchar(20) NOT NULL DEFAULT 'admin'
    CHECK(portal_mode IN('admin','teacher')),
  can_teach boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,key)
);

INSERT INTO school_roles(organisation_id,key,name,description,portal_mode,can_teach,is_system,is_active)
SELECT sp.organisation_id,v.key,v.name,v.description,v.portal_mode,v.can_teach,true,true
FROM school_profiles sp
CROSS JOIN (VALUES
  ('school_admin','School Administrator','Full School administration access','admin',true),
  ('headteacher','Headteacher','School leadership, teaching and report approval','teacher',true),
  ('teacher','Teacher','Teaching, assessment and class responsibilities','teacher',true),
  ('bursar','Bursar','Fees, payments and financial operations','admin',false),
  ('registrar','Registrar','Admissions, records and academic administration','admin',false)
) v(key,name,description,portal_mode,can_teach)
ON CONFLICT(organisation_id,key) DO NOTHING;

CREATE TABLE school_role_capabilities_v2 (
  organisation_id uuid NOT NULL,
  role varchar(40) NOT NULL,
  capability_key varchar(100) NOT NULL REFERENCES school_capabilities(key) ON DELETE CASCADE,
  allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,role,capability_key),
  FOREIGN KEY(organisation_id,role) REFERENCES school_roles(organisation_id,key) ON DELETE CASCADE
);

INSERT INTO school_role_capabilities_v2(organisation_id,role,capability_key,allowed,updated_at)
SELECT sp.organisation_id,src.role,src.capability_key,src.allowed,src.updated_at
FROM school_profiles sp
JOIN school_role_capabilities src ON true
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=EXCLUDED.updated_at;

DROP TABLE school_role_capabilities;
ALTER TABLE school_role_capabilities_v2 RENAME TO school_role_capabilities;

CREATE INDEX IF NOT EXISTS school_roles_active_idx
  ON school_roles(organisation_id,is_active,name);

CREATE INDEX IF NOT EXISTS school_memberships_role_idx
  ON school_memberships(organisation_id,role,status);

ALTER TABLE report_comments
  ADD COLUMN IF NOT EXISTS class_teacher_os_user_id uuid;

UPDATE report_comments rc
SET class_teacher_os_user_id=COALESCE(
  (
    SELECT ta.teacher_os_user_id
    FROM teacher_assignments ta
    JOIN terms t ON t.id=rc.term_id
    JOIN enrolments e ON e.student_id=rc.student_id AND e.academic_year_id=t.academic_year_id
    WHERE ta.organisation_id=rc.organisation_id
      AND ta.classroom_id=e.classroom_id
      AND ta.subject_id IS NULL
      AND ta.is_active=true
      AND (ta.term_id=rc.term_id OR ta.term_id IS NULL)
    ORDER BY (ta.term_id=rc.term_id) DESC,ta.created_at DESC
    LIMIT 1
  ),
  rc.class_teacher_os_user_id
)
WHERE rc.class_teacher_os_user_id IS NULL;
