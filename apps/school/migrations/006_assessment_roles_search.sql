ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS category_id uuid;

CREATE TABLE IF NOT EXISTS assessment_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  code varchar(40) NOT NULL,
  name varchar(120) NOT NULL,
  default_max_score numeric(8,2) NOT NULL CHECK(default_max_score > 0),
  weight_percent numeric(5,2) NOT NULL CHECK(weight_percent >= 0 AND weight_percent <= 100),
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,academic_year_id,term_id,code)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema='revolt_x_school'
      AND table_name='assessments'
      AND constraint_name='assessments_category_id_fkey'
  ) THEN
    ALTER TABLE assessments
      ADD CONSTRAINT assessments_category_id_fkey
      FOREIGN KEY(category_id) REFERENCES assessment_categories(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assessments_category_idx
  ON assessments(organisation_id,term_id,classroom_id,subject_id,category_id);

CREATE TABLE IF NOT EXISTS school_capabilities (
  key varchar(100) PRIMARY KEY,
  module varchar(60) NOT NULL,
  action varchar(60) NOT NULL,
  label varchar(160) NOT NULL,
  description varchar(500),
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS school_role_capabilities (
  role varchar(30) NOT NULL CHECK(role IN('school_admin','headteacher','teacher','bursar','registrar')),
  capability_key varchar(100) NOT NULL REFERENCES school_capabilities(key) ON DELETE CASCADE,
  allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(role,capability_key)
);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('school.manage','School','manage','Manage school settings','Edit core school settings and configuration',10),
('academic.view','Academic','view','View academic structure','View years, terms, classes and subjects',20),
('academic.create','Academic','create','Create academic records','Create years, terms, classes and subjects',21),
('academic.edit','Academic','edit','Edit academic records','Edit academic structure and assignments',22),
('academic.delete','Academic','delete','Delete academic records','Delete eligible academic structure records',23),
('students.view','Students','view','View students','View student lists and Student 360',30),
('students.create','Students','create','Create students','Admit or enrol students and guardians',31),
('students.edit','Students','edit','Edit students','Edit students, guardians and enrolments',32),
('students.delete','Students','delete','Delete students','Delete eligible student records',33),
('attendance.view','Attendance','view','View attendance','View recorded attendance',40),
('attendance.mark','Attendance','save','Save attendance','Mark and save attendance',41),
('assessment.view','Assessment','view','View assessments','View exercises, scores and schemes',50),
('assessment.create','Assessment','create','Create assessments','Create exercises under assessment categories',51),
('assessment.edit','Assessment','edit','Edit assessments','Edit assessment exercises and schemes',52),
('assessment.delete','Assessment','delete','Delete assessments','Delete assessment exercises and schemes',53),
('assessment.score','Assessment','save','Save scores','Enter and save student scores',54),
('reports.view','Reports','view','View reports','Generate Student 360 and report cards',60),
('reports.edit','Reports','edit','Edit report comments','Save teacher and headteacher comments',61),
('reports.print','Reports','report','Print reports','Print or save report cards',62),
('fees.view','Fees','view','View fees','View fee items, balances and payments',70),
('fees.create','Fees','create','Create fees','Create and assign fee items',71),
('fees.record','Fees','save','Record payments','Record student payments',72),
('fees.edit','Fees','edit','Edit fees','Edit fee items and financial setup',73),
('fees.void','Fees','delete','Void payments','Void posted payments with a reason',74),
('staff.view','Staff','view','View staff','View staff and teacher directory',80),
('staff.create','Staff','create','Create staff','Create teachers through Core Revolt-X OS',81),
('staff.edit','Staff','edit','Edit staff access','Edit school roles and teacher assignments',82),
('staff.delete','Staff','delete','Remove staff access','Remove eligible school access or assignments',83),
('roles.view','Roles','view','View roles and privileges','View role-to-privilege mapping',90),
('roles.manage','Roles','edit','Manage roles and privileges','Change allowed school capabilities for roles',91),
('timetable.view','Timetable','view','View timetable','View class and teacher timetable',100),
('timetable.manage','Timetable','edit','Manage timetable','Create, edit and delete timetable periods',101),
('admissions.view','Admissions','view','View admissions','View admission applications',110),
('admissions.manage','Admissions','edit','Manage admissions','Review and enrol admission applications',111),
('communications.view','Communication','view','View announcements','View school announcements',120),
('communications.manage','Communication','edit','Manage announcements','Create, publish, edit and delete announcements',121),
('promotion.manage','Academic','edit','Manage promotions','Promote, repeat or complete students',130),
('portals.manage','Portals','edit','Manage portal access','Generate or reset parent and student portal access',140)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(role,capability_key,allowed)
SELECT role,key,
  CASE
    WHEN role='school_admin' THEN true
    WHEN role='headteacher' THEN key NOT IN ('fees.record','fees.void')
    WHEN role='teacher' THEN key IN (
      'academic.view','students.view','attendance.view','attendance.mark',
      'assessment.view','assessment.create','assessment.edit','assessment.score',
      'reports.view','reports.edit','reports.print','timetable.view','communications.view'
    )
    WHEN role='bursar' THEN key IN (
      'students.view','reports.view','fees.view','fees.create','fees.record','fees.edit','fees.void','communications.view'
    )
    WHEN role='registrar' THEN key IN (
      'academic.view','academic.create','academic.edit','students.view','students.create','students.edit',
      'reports.view','reports.print','timetable.view','timetable.manage','admissions.view','admissions.manage',
      'communications.view','portals.manage'
    )
    ELSE false
  END
FROM (VALUES('school_admin'),('headteacher'),('teacher'),('bursar'),('registrar')) r(role)
CROSS JOIN school_capabilities
ON CONFLICT(role,capability_key) DO NOTHING;
