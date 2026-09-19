CREATE TABLE IF NOT EXISTS system_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid,
  actor_os_user_id uuid,
  request_id varchar(120) NOT NULL,
  method varchar(12) NOT NULL,
  path varchar(500) NOT NULL,
  status_code int NOT NULL,
  duration_ms numeric(12,3),
  outcome varchar(20) NOT NULL CHECK(outcome IN('success','client_error','server_error')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_request_logs_created_idx
  ON system_request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS system_request_logs_org_idx
  ON system_request_logs(organisation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS system_request_logs_status_idx
  ON system_request_logs(status_code,created_at DESC);

CREATE TABLE IF NOT EXISTS system_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid,
  actor_os_user_id uuid,
  request_id varchar(120),
  method varchar(12),
  path varchar(500),
  status_code int NOT NULL,
  error_code varchar(120),
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by_os_user_id uuid,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_errors_created_idx
  ON system_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS system_errors_open_idx
  ON system_errors(resolved_at,created_at DESC);
CREATE INDEX IF NOT EXISTS system_errors_org_idx
  ON system_errors(organisation_id,created_at DESC);

CREATE TABLE IF NOT EXISTS academic_statement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id uuid REFERENCES guardians(id) ON DELETE SET NULL,
  requested_by_type varchar(20) NOT NULL
    CHECK(requested_by_type IN('guardian','student','staff')),
  purpose varchar(40) NOT NULL DEFAULT 'continuation'
    CHECK(purpose IN('continuation','transfer','scholarship','personal','other')),
  note varchar(2000),
  status varchar(20) NOT NULL DEFAULT 'requested'
    CHECK(status IN('requested','processing','approved','declined')),
  statement_reference varchar(80) UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_os_user_id uuid,
  reviewed_at timestamptz,
  issued_at timestamptz,
  school_note varchar(2000)
);

CREATE INDEX IF NOT EXISTS academic_statement_requests_student_idx
  ON academic_statement_requests(organisation_id,student_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS academic_statement_requests_status_idx
  ON academic_statement_requests(organisation_id,status,requested_at DESC);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('system.logs.view','System','view','View system logs','View audit, request and application error logs',131),
('system.errors.manage','System','edit','Manage error register','Mark application errors as resolved and document resolution',132),
('academic_statement.view','Reports','view','View cumulative academic statements','View cumulative academic records across terms and years',65),
('academic_statement.issue','Reports','approve','Issue cumulative academic statements','Approve and issue cumulative statements requested by families',66)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,
  description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('school_admin','system.logs.view',true),
('school_admin','system.errors.manage',true),
('school_admin','academic_statement.view',true),
('school_admin','academic_statement.issue',true),
('headteacher','system.logs.view',true),
('headteacher','system.errors.manage',false),
('headteacher','academic_statement.view',true),
('headteacher','academic_statement.issue',true),
('teacher','system.logs.view',false),
('teacher','system.errors.manage',false),
('teacher','academic_statement.view',false),
('teacher','academic_statement.issue',false),
('bursar','system.logs.view',false),
('bursar','system.errors.manage',false),
('bursar','academic_statement.view',false),
('bursar','academic_statement.issue',false),
('registrar','system.logs.view',true),
('registrar','system.errors.manage',false),
('registrar','academic_statement.view',true),
('registrar','academic_statement.issue',true)
ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
