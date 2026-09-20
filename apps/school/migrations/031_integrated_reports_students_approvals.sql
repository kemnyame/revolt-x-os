-- Integrated report-card release, promotion decisions, student lifecycle and approvals.

ALTER TABLE school_profiles
  ADD COLUMN IF NOT EXISTS promotion_threshold_percent numeric(5,2) NOT NULL DEFAULT 50.00
    CHECK(promotion_threshold_percent>=0 AND promotion_threshold_percent<=100);

ALTER TABLE report_comments
  ADD COLUMN IF NOT EXISTS promotion_decision varchar(20),
  ADD COLUMN IF NOT EXISTS promotion_basis varchar(20),
  ADD COLUMN IF NOT EXISTS promotion_threshold_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by_os_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='report_comments_promotion_decision_check'
      AND conrelid='report_comments'::regclass
  ) THEN
    ALTER TABLE report_comments
      ADD CONSTRAINT report_comments_promotion_decision_check
      CHECK(promotion_decision IS NULL OR promotion_decision IN('promoted','repeated','completed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='report_comments_promotion_basis_check'
      AND conrelid='report_comments'::regclass
  ) THEN
    ALTER TABLE report_comments
      ADD CONSTRAINT report_comments_promotion_basis_check
      CHECK(promotion_basis IS NULL OR promotion_basis IN('threshold','teacher_override'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS report_comments_release_idx
  ON report_comments(organisation_id,term_id,workflow_status,released_at);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='students_status_check'
      AND conrelid='students'::regclass
  ) THEN
    ALTER TABLE students DROP CONSTRAINT students_status_check;
  END IF;
  ALTER TABLE students
    ADD CONSTRAINT students_status_check
    CHECK(status IN('active','inactive','suspended','graduated','transferred','withdrawn'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='enrolments_status_check'
      AND conrelid='enrolments'::regclass
  ) THEN
    ALTER TABLE enrolments DROP CONSTRAINT enrolments_status_check;
  END IF;
  ALTER TABLE enrolments
    ADD CONSTRAINT enrolments_status_check
    CHECK(status IN('active','promoted','repeated','transferred','completed','withdrawn','suspended','inactive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS student_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  old_status varchar(20),
  new_status varchar(20) NOT NULL,
  reason varchar(2000),
  enrolment_id uuid REFERENCES enrolments(id) ON DELETE SET NULL,
  classroom_id uuid REFERENCES classrooms(id) ON DELETE SET NULL,
  changed_by_os_user_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_status_history_student_idx
  ON student_status_history(organisation_id,student_id,changed_at DESC);

INSERT INTO student_status_history(organisation_id,student_id,old_status,new_status,reason,changed_at)
SELECT s.organisation_id,s.id,NULL,s.status,'Historical status backfilled',s.created_at
FROM students s
WHERE NOT EXISTS(SELECT 1 FROM student_status_history h WHERE h.student_id=s.id);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('reports.release','Reports','release','Release report cards','Release approved class reports to family portals and guardian email',67),
('students.status','Students','approve','Manage student lifecycle','Suspend, withdraw, transfer, graduate, deactivate or reactivate students while preserving history',26),
('approvals.manage','Approvals','approve','Process approval queue','Open and approve or return pending workflow items from the central approval screen',130)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,
  description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,
  CASE
    WHEN c.key='reports.release' AND sr.key IN('school_admin','headteacher','teacher') THEN true
    WHEN c.key='students.status' AND sr.key IN('school_admin','headteacher','registrar') THEN true
    WHEN c.key='approvals.manage' AND sr.key IN('school_admin','headteacher') THEN true
    ELSE false
  END
FROM school_roles sr
CROSS JOIN (VALUES('reports.release'),('students.status'),('approvals.manage')) c(key)
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
