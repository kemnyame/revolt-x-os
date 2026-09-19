CREATE TABLE IF NOT EXISTS teacher_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_os_user_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id)
);

CREATE TABLE IF NOT EXISTS homework_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id),
  title varchar(200) NOT NULL,
  instructions text NOT NULL,
  due_at timestamptz,
  max_score numeric(8,2) CHECK(max_score IS NULL OR max_score > 0),
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','closed')),
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS homework_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  homework_id uuid NOT NULL REFERENCES homework_assignments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'not_submitted' CHECK(status IN('not_submitted','submitted','late','graded')),
  submitted_at timestamptz,
  score numeric(8,2) CHECK(score IS NULL OR score >= 0),
  teacher_comment varchar(1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(homework_id,student_id)
);

CREATE TABLE IF NOT EXISTS grading_bands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  name varchar(40) NOT NULL,
  min_percentage numeric(5,2) NOT NULL CHECK(min_percentage >= 0 AND min_percentage <= 100),
  max_percentage numeric(5,2) NOT NULL CHECK(max_percentage >= 0 AND max_percentage <= 100),
  remark varchar(120),
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  CHECK(max_percentage >= min_percentage),
  UNIQUE(organisation_id,name)
);

CREATE TABLE IF NOT EXISTS report_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  class_teacher_comment text,
  headteacher_comment text,
  conduct varchar(80),
  interest text,
  next_term_begins date,
  updated_by_os_user_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id,term_id)
);

CREATE TABLE IF NOT EXISTS student_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  from_academic_year_id uuid NOT NULL REFERENCES academic_years(id),
  to_academic_year_id uuid NOT NULL REFERENCES academic_years(id),
  from_classroom_id uuid REFERENCES classrooms(id),
  to_classroom_id uuid REFERENCES classrooms(id),
  outcome varchar(20) NOT NULL CHECK(outcome IN('promoted','repeated','completed')),
  processed_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id,to_academic_year_id)
);

CREATE TABLE IF NOT EXISTS school_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  audience varchar(30) NOT NULL CHECK(audience IN('all','staff','parents','students','class')),
  classroom_id uuid REFERENCES classrooms(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  body text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','archived')),
  published_at timestamptz,
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guardian_portal_access (
  guardian_id uuid PRIMARY KEY REFERENCES guardians(id) ON DELETE CASCADE,
  pin_hash varchar(128) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guardian_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  token_hash varchar(128) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teacher_assignments_teacher_idx
  ON teacher_assignments(organisation_id,teacher_os_user_id,is_active);

CREATE INDEX IF NOT EXISTS homework_class_term_idx
  ON homework_assignments(organisation_id,classroom_id,term_id,status);

CREATE INDEX IF NOT EXISTS announcements_org_status_idx
  ON school_announcements(organisation_id,status,published_at DESC);

CREATE INDEX IF NOT EXISTS promotions_student_idx
  ON student_promotions(organisation_id,student_id,created_at DESC);

CREATE INDEX IF NOT EXISTS guardian_sessions_active_idx
  ON guardian_portal_sessions(guardian_id,expires_at)
  WHERE revoked_at IS NULL;
