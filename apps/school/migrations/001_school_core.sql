CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_profiles (
  organisation_id uuid PRIMARY KEY,
  school_name varchar(240) NOT NULL,
  short_name varchar(80),
  motto varchar(240),
  phone varchar(60),
  email varchar(320),
  address text,
  currency varchar(8) NOT NULL DEFAULT 'GHS',
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  role varchar(40) NOT NULL CHECK(role IN('school_admin','headteacher','teacher','bursar','registrar')),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,os_user_id)
);

CREATE TABLE academic_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  name varchar(40) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,name)
);

CREATE TABLE terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_no int NOT NULL CHECK(term_no BETWEEN 1 AND 3),
  name varchar(80) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'planned' CHECK(status IN('planned','active','closed')),
  UNIQUE(academic_year_id,term_no)
);

CREATE TABLE grade_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(20) NOT NULL,
  name varchar(80) NOT NULL,
  stage varchar(20) NOT NULL CHECK(stage IN('primary','jhs')),
  level_order int NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE(organisation_id,code),
  UNIQUE(organisation_id,level_order)
);

CREATE TABLE classrooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  grade_level_id uuid NOT NULL REFERENCES grade_levels(id),
  name varchar(120) NOT NULL,
  stream varchar(40),
  class_teacher_os_user_id uuid,
  capacity int CHECK(capacity IS NULL OR capacity > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academic_year_id,name)
);

CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(30) NOT NULL,
  name varchar(120) NOT NULL,
  stage varchar(20) NOT NULL DEFAULT 'both' CHECK(stage IN('primary','jhs','both')),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE(organisation_id,code)
);

CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  admission_no varchar(60) NOT NULL,
  first_name varchar(100) NOT NULL,
  middle_name varchar(100),
  last_name varchar(100) NOT NULL,
  sex varchar(20) CHECK(sex IN('male','female')),
  date_of_birth date,
  admission_date date NOT NULL DEFAULT current_date,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN('active','graduated','transferred','withdrawn')),
  photo_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,admission_no)
);

CREATE TABLE guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  phone varchar(60) NOT NULL,
  email varchar(320),
  address text,
  os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student_guardians (
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  relationship varchar(60) NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY(student_id,guardian_id)
);

CREATE TABLE enrolments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN('active','promoted','repeated','transferred','completed')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id,academic_year_id)
);

CREATE TABLE attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  status varchar(20) NOT NULL CHECK(status IN('present','absent','late','excused')),
  note varchar(500),
  marked_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id,classroom_id,attendance_date)
);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id),
  name varchar(160) NOT NULL,
  assessment_type varchar(40) NOT NULL CHECK(assessment_type IN('classwork','homework','project','test','exam','other')),
  max_score numeric(8,2) NOT NULL CHECK(max_score > 0),
  weight numeric(6,2) NOT NULL DEFAULT 100 CHECK(weight > 0),
  assessment_date date,
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessment_scores (
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score numeric(8,2) NOT NULL CHECK(score >= 0),
  comment varchar(500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(assessment_id,student_id)
);

CREATE TABLE fee_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  grade_level_id uuid REFERENCES grade_levels(id),
  name varchar(160) NOT NULL,
  amount numeric(12,2) NOT NULL CHECK(amount >= 0),
  mandatory boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  fee_item_id uuid NOT NULL REFERENCES fee_items(id) ON DELETE CASCADE,
  amount_due numeric(12,2) NOT NULL CHECK(amount_due >= 0),
  discount numeric(12,2) NOT NULL DEFAULT 0 CHECK(discount >= 0),
  status varchar(20) NOT NULL DEFAULT 'unpaid' CHECK(status IN('unpaid','part_paid','paid','waived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id,fee_item_id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  student_fee_id uuid REFERENCES student_fees(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL CHECK(amount > 0),
  payment_method varchar(30) NOT NULL CHECK(payment_method IN('cash','mobile_money','bank','card','other')),
  reference varchar(120),
  paid_at timestamptz NOT NULL DEFAULT now(),
  received_by_os_user_id uuid NOT NULL,
  note varchar(500)
);

CREATE TABLE timetable_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id),
  teacher_os_user_id uuid,
  day_of_week int NOT NULL CHECK(day_of_week BETWEEN 1 AND 5),
  start_time time NOT NULL,
  end_time time NOT NULL,
  room varchar(80),
  CHECK(end_time > start_time)
);

CREATE TABLE school_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  actor_os_user_id uuid NOT NULL,
  action varchar(160) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX school_students_org_name_idx ON students(organisation_id,last_name,first_name);
CREATE INDEX school_enrolments_class_idx ON enrolments(classroom_id,status);
CREATE INDEX school_attendance_class_date_idx ON attendance_records(classroom_id,attendance_date);
CREATE INDEX school_payments_student_idx ON payments(student_id,paid_at DESC);
CREATE INDEX school_audit_org_time_idx ON school_audit_logs(organisation_id,created_at DESC);
