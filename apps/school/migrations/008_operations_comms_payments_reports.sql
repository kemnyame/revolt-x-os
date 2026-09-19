CREATE TABLE IF NOT EXISTS communication_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  channel varchar(20) NOT NULL CHECK(channel IN('email','sms','whatsapp')),
  recipient_name varchar(200),
  recipient_address varchar(400) NOT NULL,
  subject varchar(300),
  body text NOT NULL,
  template_key varchar(100),
  related_type varchar(80),
  related_id uuid,
  status varchar(30) NOT NULL DEFAULT 'queued'
    CHECK(status IN('queued','pending_configuration','sending','sent','failed')),
  provider varchar(40),
  provider_message_id varchar(200),
  attempt_count int NOT NULL DEFAULT 0,
  last_error text,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS communication_outbox_org_idx
  ON communication_outbox(organisation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS communication_outbox_status_idx
  ON communication_outbox(status,created_at);

CREATE TABLE IF NOT EXISTS fee_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  student_fee_id uuid REFERENCES student_fees(id) ON DELETE SET NULL,
  guardian_id uuid REFERENCES guardians(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL CHECK(amount > 0),
  note varchar(1000),
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK(status IN('open','paid','cancelled','expired')),
  requested_by_os_user_id uuid NOT NULL,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fee_payment_requests_student_idx
  ON fee_payment_requests(organisation_id,student_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  student_fee_id uuid REFERENCES student_fees(id) ON DELETE SET NULL,
  payment_request_id uuid REFERENCES fee_payment_requests(id) ON DELETE SET NULL,
  guardian_id uuid REFERENCES guardians(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL CHECK(amount > 0),
  currency varchar(10) NOT NULL DEFAULT 'GHS',
  method varchar(30) NOT NULL CHECK(method IN('card','mobile_money','cash')),
  provider varchar(40) NOT NULL,
  reference varchar(120) NOT NULL UNIQUE,
  status varchar(30) NOT NULL DEFAULT 'initialized'
    CHECK(status IN('initialized','pending','success','failed','cancelled')),
  authorization_url text,
  provider_access_code varchar(240),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  initiated_by_type varchar(20) NOT NULL CHECK(initiated_by_type IN('school','guardian')),
  initiated_by_os_user_id uuid,
  initiated_by_guardian_id uuid REFERENCES guardians(id) ON DELETE SET NULL,
  settled_payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS payment_intents_org_idx
  ON payment_intents(organisation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS payment_intents_status_idx
  ON payment_intents(status,created_at DESC);

ALTER TABLE admission_applications
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'external',
  ADD COLUMN IF NOT EXISTS guardian_alt_phone varchar(60),
  ADD COLUMN IF NOT EXISTS emergency_contact_name varchar(200),
  ADD COLUMN IF NOT EXISTS emergency_contact_phone varchar(60),
  ADD COLUMN IF NOT EXISTS assigned_reviewer_os_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema='revolt_x_school'
      AND table_name='admission_applications'
      AND constraint_name='admission_applications_source_check'
  ) THEN
    ALTER TABLE admission_applications
      ADD CONSTRAINT admission_applications_source_check CHECK(source IN('external','internal'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admission_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  application_id uuid NOT NULL REFERENCES admission_applications(id) ON DELETE CASCADE,
  old_status varchar(30),
  new_status varchar(30) NOT NULL,
  note text,
  actor_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admission_status_history_application_idx
  ON admission_status_history(application_id,created_at DESC);

CREATE TABLE IF NOT EXISTS admission_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  application_id uuid NOT NULL REFERENCES admission_applications(id) ON DELETE CASCADE,
  method varchar(20) NOT NULL CHECK(method IN('call','email','sms','whatsapp')),
  recipient varchar(400) NOT NULL,
  note varchar(2000),
  status varchar(30) NOT NULL DEFAULT 'initiated'
    CHECK(status IN('initiated','sent','completed','failed')),
  actor_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admission_contacts_application_idx
  ON admission_contacts(application_id,created_at DESC);

ALTER TABLE report_comments
  ADD COLUMN IF NOT EXISTS workflow_status varchar(20) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS submitted_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema='revolt_x_school'
      AND table_name='report_comments'
      AND constraint_name='report_comments_workflow_status_check'
  ) THEN
    ALTER TABLE report_comments
      ADD CONSTRAINT report_comments_workflow_status_check
      CHECK(workflow_status IN('draft','submitted','approved','returned'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS report_reviewer_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  reviewer_os_user_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,classroom_id,reviewer_os_user_id)
);

CREATE TABLE IF NOT EXISTS promotion_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  from_academic_year_id uuid NOT NULL REFERENCES academic_years(id),
  to_academic_year_id uuid NOT NULL REFERENCES academic_years(id),
  from_classroom_id uuid REFERENCES classrooms(id),
  processed_by_os_user_id uuid NOT NULL,
  total_students int NOT NULL DEFAULT 0,
  promoted_count int NOT NULL DEFAULT 0,
  repeated_count int NOT NULL DEFAULT 0,
  completed_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('communications.send','Communication','send','Send direct messages','Send email, SMS or WhatsApp messages',122),
('payments.initiate','Fees','create','Initiate parent payments','Create payment requests for parents',75),
('payments.configure','Fees','edit','View payment integration status','View payment provider readiness',76),
('reports.submit','Reports','save','Submit report cards','Submit completed class teacher reports for review',63),
('reports.approve','Reports','approve','Approve report cards','Approve or return submitted report cards',64)
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,label=EXCLUDED.label,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('school_admin','communications.send',true),
('school_admin','payments.initiate',true),
('school_admin','payments.configure',true),
('school_admin','reports.submit',true),
('school_admin','reports.approve',true),
('headteacher','communications.send',true),
('headteacher','payments.initiate',false),
('headteacher','payments.configure',false),
('headteacher','reports.submit',true),
('headteacher','reports.approve',true),
('teacher','communications.send',false),
('teacher','payments.initiate',false),
('teacher','payments.configure',false),
('teacher','reports.submit',true),
('teacher','reports.approve',false),
('bursar','communications.send',true),
('bursar','payments.initiate',true),
('bursar','payments.configure',true),
('bursar','reports.submit',false),
('bursar','reports.approve',false),
('registrar','communications.send',true),
('registrar','payments.initiate',false),
('registrar','payments.configure',false),
('registrar','reports.submit',false),
('registrar','reports.approve',false)
ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
