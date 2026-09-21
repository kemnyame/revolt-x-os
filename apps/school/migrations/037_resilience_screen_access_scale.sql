-- Screen-level access, resilient staff directory cache, and indexes for larger schools.

CREATE TABLE IF NOT EXISTS school_user_directory(
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  core_membership_id uuid,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  email text,
  job_title text,
  employee_number text,
  user_status text,
  membership_status text,
  roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,os_user_id)
);
CREATE INDEX IF NOT EXISTS idx_school_user_directory_org_name
  ON school_user_directory(organisation_id,last_name,first_name);
CREATE INDEX IF NOT EXISTS idx_school_user_directory_org_staff_no
  ON school_user_directory(organisation_id,employee_number);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('screen.dashboard.view','Screen Access','view','Dashboard','Open the School dashboard screen',1),
('screen.setup.view','Screen Access','view','School Setup','Open the School Setup screen',2),
('screen.admissions.view','Screen Access','view','Admissions','Open the Admissions screen',3),
('screen.students.view','Screen Access','view','Student Management','Open the Student Management directory screen',4),
('screen.approvals.view','Screen Access','view','Approvals','Open the Approvals screen',5),
('screen.academic_manager.view','Screen Access','view','Academic Manager','Open the Academic Manager screen',6),
('screen.promotions.view','Screen Access','view','Promotion & Rollover','Open Academic Promotion & Rollover',7),
('screen.attendance.view','Screen Access','view','Attendance','Open the Attendance screen',8),
('screen.assessments.view','Screen Access','view','Assessments & Scores','Open Assessments & Scores',9),
('screen.homework.view','Screen Access','view','Homework','Open the Homework screen',10),
('screen.lesson_notes.view','Screen Access','view','Lesson Notes','Open the Lesson Notes screen',11),
('screen.report_cards.view','Screen Access','view','Report Cards','Open the Report Cards screen',12),
('screen.student_statements.view','Screen Access','view','Student Statements','Open Student Statements',13),
('screen.grading.view','Screen Access','view','Grading Setup','Open Grading Setup',14),
('screen.finance.view','Screen Access','view','Finance & Accounts','Open Finance & Accounts',15),
('screen.leave.view','Screen Access','view','Leave & Relief','Open Leave & Relief',16),
('screen.timetable.view','Screen Access','view','Timetable & Scheduling','Open Timetable & Scheduling',17),
('screen.teacher_schedule.view','Screen Access','view','Teacher Scheduling','Open Teacher Scheduling',18),
('screen.communications.view','Screen Access','view','Communication Centre','Open Communication Centre',19),
('screen.access_management.view','Screen Access','view','Access Management','Open Staff, Roles & Access Management',20),
('screen.system.view','Screen Access','view','System & Audit Logs','Open System & Audit Logs',21),
('screen.portals.view','Screen Access','view','Portals & Interfaces','Open Portals & Interfaces',22),
('students.profile.view','Students','view','Open full student profile','Open the full Student profile page',34),
('students.360.view','Students','view','Open Student 360','View the consolidated Student 360 profile',35)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,
  description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

-- Preserve existing intended access while separating navigation from backend data dependencies.
WITH access_map(source_key,target_key) AS (
  VALUES
  ('reports.view','screen.dashboard.view'),
  ('school.manage','screen.setup.view'),('academic.view','screen.setup.view'),
  ('admissions.view','screen.admissions.view'),
  ('students.view','screen.students.view'),
  ('approvals.view','screen.approvals.view'),
  ('teaching_assignments.view','screen.academic_manager.view'),('academic.view','screen.academic_manager.view'),
  ('promotion.manage','screen.promotions.view'),
  ('attendance.view','screen.attendance.view'),
  ('assessment.view','screen.assessments.view'),
  ('homework.view','screen.homework.view'),
  ('lesson_notes.view','screen.lesson_notes.view'),
  ('reports.view','screen.report_cards.view'),
  ('finance.view','screen.student_statements.view'),
  ('assessment.view','screen.grading.view'),
  ('finance.view','screen.finance.view'),
  ('leave.view','screen.leave.view'),
  ('timetable.view','screen.timetable.view'),
  ('teaching_assignments.view','screen.teacher_schedule.view'),('timetable.view','screen.teacher_schedule.view'),
  ('communications.view','screen.communications.view'),
  ('staff.view','screen.access_management.view'),('roles.view','screen.access_management.view'),
  ('system.logs.view','screen.system.view'),('school.manage','screen.system.view'),
  ('portals.manage','screen.portals.view'),
  ('students.view','students.profile.view'),
  ('students.view','students.360.view')
)
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT DISTINCT src.organisation_id,src.role,m.target_key,true
FROM school_role_capabilities src
JOIN access_map m ON m.source_key=src.capability_key
WHERE src.allowed=true
  AND NOT (
    src.role IN ('accountant','bursar')
    AND m.target_key IN ('screen.students.view','screen.report_cards.view','students.profile.view','students.360.view')
  )
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Core finance dependencies must never automatically reveal unrelated student/report screens.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,v.key,true
FROM school_roles sr
CROSS JOIN (VALUES('screen.finance.view'),('screen.student_statements.view'),('screen.dashboard.view')) v(key)
WHERE sr.key IN ('accountant','bursar')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Query support for 5,000+ student schools.
CREATE INDEX IF NOT EXISTS idx_students_org_status_name
  ON students(organisation_id,status,last_name,first_name);
CREATE INDEX IF NOT EXISTS idx_students_org_admission
  ON students(organisation_id,admission_no);
CREATE INDEX IF NOT EXISTS idx_enrolments_org_status_student
  ON enrolments(organisation_id,status,student_id);
CREATE INDEX IF NOT EXISTS idx_enrolments_org_status_class
  ON enrolments(organisation_id,status,classroom_id);
CREATE INDEX IF NOT EXISTS idx_attendance_org_student_date
  ON attendance_records(organisation_id,student_id,attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_org_student_date
  ON payments(organisation_id,student_id,paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_student_fees_org_student
  ON student_fees(organisation_id,student_id);
CREATE INDEX IF NOT EXISTS idx_school_memberships_org_status_role
  ON school_memberships(organisation_id,status,role);
