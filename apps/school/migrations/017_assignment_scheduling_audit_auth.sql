ALTER TABLE class_subjects
  ADD COLUMN IF NOT EXISTS credit_hours numeric(5,2) NOT NULL DEFAULT 2.00
    CHECK(credit_hours >= 0.25 AND credit_hours <= 20.00);

CREATE TABLE IF NOT EXISTS school_change_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  actor_os_user_id uuid,
  action varchar(160) NOT NULL,
  resource_type varchar(120) NOT NULL,
  resource_id varchar(120),
  performed_on varchar(300),
  old_value jsonb,
  new_value jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS school_change_logs_org_created_idx
  ON school_change_logs(organisation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS school_change_logs_resource_idx
  ON school_change_logs(organisation_id,resource_type,resource_id,created_at DESC);
CREATE INDEX IF NOT EXISTS school_change_logs_actor_idx
  ON school_change_logs(organisation_id,actor_os_user_id,created_at DESC);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('teaching_assignments.view','Academic','view','View teaching assignments','View the teacher, class and subject assignment hub',38),
('teaching_assignments.manage','Academic','edit','Manage teaching assignments','Assign class teachers, subject teachers and class curriculum',39),
('timetable.auto_schedule','Timetable','create','Auto-schedule timetable','Generate timetable periods from teaching assignments and credit hours',94)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('school_admin','teaching_assignments.view',true),
('school_admin','teaching_assignments.manage',true),
('school_admin','timetable.auto_schedule',true),
('headteacher','teaching_assignments.view',true),
('headteacher','teaching_assignments.manage',true),
('headteacher','timetable.auto_schedule',true),
('teacher','teaching_assignments.view',true),
('teacher','teaching_assignments.manage',false),
('teacher','timetable.auto_schedule',false),
('bursar','teaching_assignments.view',false),
('bursar','teaching_assignments.manage',false),
('bursar','timetable.auto_schedule',false),
('registrar','teaching_assignments.view',true),
('registrar','teaching_assignments.manage',true),
('registrar','timetable.auto_schedule',true)
ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
