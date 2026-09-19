CREATE TABLE IF NOT EXISTS student_portal_access (
  student_id uuid PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  pin_hash varchar(128) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token_hash varchar(128) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admission_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  application_no varchar(40) NOT NULL,
  first_name varchar(100) NOT NULL,
  middle_name varchar(100),
  last_name varchar(100) NOT NULL,
  sex varchar(20) CHECK(sex IN('male','female')),
  date_of_birth date,
  requested_grade_code varchar(20) NOT NULL,
  previous_school varchar(240),
  guardian_first_name varchar(100) NOT NULL,
  guardian_last_name varchar(100) NOT NULL,
  guardian_phone varchar(60) NOT NULL,
  guardian_email varchar(320),
  guardian_relationship varchar(60) NOT NULL,
  address text,
  notes text,
  status varchar(30) NOT NULL DEFAULT 'submitted'
    CHECK(status IN('submitted','under_review','approved','waitlisted','declined','enrolled')),
  reviewed_by_os_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,application_no)
);

CREATE INDEX IF NOT EXISTS student_portal_sessions_active_idx
  ON student_portal_sessions(student_id,expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS admission_applications_org_status_idx
  ON admission_applications(organisation_id,status,submitted_at DESC);
