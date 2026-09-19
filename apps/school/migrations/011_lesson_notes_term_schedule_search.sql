ALTER TABLE terms
  ADD COLUMN IF NOT EXISTS next_term_begins date;

CREATE TABLE IF NOT EXISTS lesson_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id),
  teacher_os_user_id uuid NOT NULL,
  week_no int CHECK(week_no IS NULL OR week_no BETWEEN 1 AND 30),
  lesson_date date,
  title varchar(240) NOT NULL,
  strand varchar(240),
  sub_strand varchar(240),
  learning_objectives text,
  teaching_learning_resources text,
  introduction_activity text,
  main_activity text,
  plenary_activity text,
  differentiation text,
  assessment_method text,
  homework text,
  teacher_reflection text,
  teaching_log text,
  status varchar(24) NOT NULL DEFAULT 'draft'
    CHECK(status IN('draft','submitted','approved','returned','taught')),
  submitted_at timestamptz,
  reviewed_by_os_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  taught_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lesson_notes_org_teacher_idx
  ON lesson_notes(organisation_id,teacher_os_user_id,term_id,status,lesson_date DESC);
CREATE INDEX IF NOT EXISTS lesson_notes_class_subject_idx
  ON lesson_notes(organisation_id,classroom_id,subject_id,term_id,week_no);

CREATE TABLE IF NOT EXISTS timetable_settings (
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  school_day_start time NOT NULL DEFAULT '07:30',
  school_day_end time NOT NULL DEFAULT '15:30',
  default_period_minutes int NOT NULL DEFAULT 40 CHECK(default_period_minutes BETWEEN 15 AND 180),
  minimum_break_minutes int NOT NULL DEFAULT 20 CHECK(minimum_break_minutes BETWEEN 0 AND 180),
  max_teacher_periods_per_day int NOT NULL DEFAULT 8 CHECK(max_teacher_periods_per_day BETWEEN 1 AND 20),
  updated_by_os_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS timetable_settings_scope_unique
  ON timetable_settings(organisation_id,academic_year_id,COALESCE(term_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS timetable_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  day_of_week int CHECK(day_of_week IS NULL OR day_of_week BETWEEN 1 AND 5),
  label varchar(100) NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_type varchar(30) NOT NULL DEFAULT 'break'
    CHECK(break_type IN('break','lunch','assembly','other')),
  CHECK(end_time > start_time)
);

CREATE INDEX IF NOT EXISTS timetable_breaks_scope_idx
  ON timetable_breaks(organisation_id,academic_year_id,term_id,day_of_week,start_time);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('lesson_notes.view','Lesson Notes','view','View lesson notes','View lesson notes and teaching logs',47),
('lesson_notes.create','Lesson Notes','create','Create lesson notes','Create teacher lesson notes',48),
('lesson_notes.edit','Lesson Notes','edit','Edit lesson notes','Edit own draft or returned lesson notes',49),
('lesson_notes.submit','Lesson Notes','save','Submit lesson notes','Submit lesson notes for review',50),
('lesson_notes.review','Lesson Notes','approve','Review lesson notes','Approve or return submitted lesson notes',51),
('timetable.configure','Timetable','edit','Configure timetable schedule','Configure school-day scheduling rules and breaks',93)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('school_admin','lesson_notes.view',true),
('school_admin','lesson_notes.create',true),
('school_admin','lesson_notes.edit',true),
('school_admin','lesson_notes.submit',true),
('school_admin','lesson_notes.review',true),
('school_admin','timetable.configure',true),
('headteacher','lesson_notes.view',true),
('headteacher','lesson_notes.create',true),
('headteacher','lesson_notes.edit',true),
('headteacher','lesson_notes.submit',true),
('headteacher','lesson_notes.review',true),
('headteacher','timetable.configure',true),
('teacher','lesson_notes.view',true),
('teacher','lesson_notes.create',true),
('teacher','lesson_notes.edit',true),
('teacher','lesson_notes.submit',true),
('teacher','lesson_notes.review',false),
('teacher','timetable.configure',false),
('bursar','lesson_notes.view',false),
('bursar','lesson_notes.create',false),
('bursar','lesson_notes.edit',false),
('bursar','lesson_notes.submit',false),
('bursar','lesson_notes.review',false),
('bursar','timetable.configure',false),
('registrar','lesson_notes.view',false),
('registrar','lesson_notes.create',false),
('registrar','lesson_notes.edit',false),
('registrar','lesson_notes.submit',false),
('registrar','lesson_notes.review',false),
('registrar','timetable.configure',true)
ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS students_search_trgm_idx ON students USING gin (
  (lower(first_name||' '||COALESCE(middle_name,'')||' '||last_name||' '||admission_no)) gin_trgm_ops
);
CREATE INDEX IF NOT EXISTS guardians_search_trgm_idx ON guardians USING gin (
  (lower(first_name||' '||last_name||' '||phone||' '||COALESCE(email,''))) gin_trgm_ops
);
CREATE INDEX IF NOT EXISTS admissions_search_trgm_idx ON admission_applications USING gin (
  (lower(first_name||' '||last_name||' '||application_no||' '||guardian_phone||' '||COALESCE(guardian_email,''))) gin_trgm_ops
);
CREATE INDEX IF NOT EXISTS lesson_notes_search_trgm_idx ON lesson_notes USING gin (
  (lower(title||' '||COALESCE(strand,'')||' '||COALESCE(sub_strand,'')||' '||COALESCE(learning_objectives,''))) gin_trgm_ops
);
