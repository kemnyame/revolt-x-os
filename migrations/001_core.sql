CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  password_hash text NOT NULL,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','disabled')),
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  UNIQUE (email)
);

CREATE TABLE organisation_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_title varchar(160),
  employee_number varchar(80),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id),
  UNIQUE NULLS NOT DISTINCT (organisation_id, employee_number)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  code varchar(30) NOT NULL,
  name varchar(160) NOT NULL,
  timezone varchar(80) NOT NULL DEFAULT 'UTC',
  address jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code)
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  code varchar(30) NOT NULL,
  name varchar(160) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  name varchar(160) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES organisation_memberships(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, membership_id)
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(120) NOT NULL UNIQUE,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  key varchar(80) NOT NULL,
  name varchar(120) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (organisation_id, key)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE membership_roles (
  membership_id uuid NOT NULL REFERENCES organisation_memberships(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type varchar(20) NOT NULL DEFAULT 'organisation' CHECK (scope_type IN ('organisation','branch','department','team')),
  scope_id uuid,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id, scope_type, scope_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  ip_address inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  action varchar(160) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id text,
  outcome varchar(20) NOT NULL CHECK (outcome IN ('success','failure')),
  ip_address inet,
  user_agent text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organisation_id, created_at DESC);

CREATE TABLE operation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  title varchar(240) NOT NULL,
  description text,
  status varchar(30) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','completed','cancelled')),
  priority varchar(20) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  owner_membership_id uuid REFERENCES organisation_memberships(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  due_at timestamptz,
  source_module varchar(80),
  external_ref varchar(160),
  metadata jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (organisation_id, source_module, external_ref)
);
CREATE INDEX operation_items_queue_idx ON operation_items (organisation_id, status, priority, due_at);

CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  key varchar(100) NOT NULL,
  name varchar(180) NOT NULL,
  description text,
  version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  trigger_type varchar(40) NOT NULL CHECK (trigger_type IN ('manual','event','schedule','api')),
  trigger_config jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, key, version)
);

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_definition_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_key varchar(100) NOT NULL,
  name varchar(180) NOT NULL,
  step_type varchar(30) NOT NULL CHECK (step_type IN ('task','approval','webhook','condition','delay')),
  position integer NOT NULL CHECK (position >= 0),
  config jsonb NOT NULL DEFAULT '{}',
  retry_policy jsonb NOT NULL DEFAULT '{"maxAttempts":1}',
  UNIQUE (workflow_definition_id, step_key),
  UNIQUE (workflow_definition_id, position)
);

CREATE TABLE workflow_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workflow_definition_id uuid NOT NULL REFERENCES workflow_definitions(id),
  status varchar(30) NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting','completed','failed','cancelled')),
  context jsonb NOT NULL DEFAULT '{}',
  idempotency_key varchar(160),
  started_by uuid REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error jsonb,
  UNIQUE NULLS NOT DISTINCT (organisation_id, idempotency_key)
);

CREATE TABLE workflow_step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES workflow_steps(id),
  status varchar(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting','completed','failed','skipped','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  error jsonb,
  assigned_membership_id uuid REFERENCES organisation_memberships(id) ON DELETE SET NULL,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (workflow_instance_id, workflow_step_id)
);

CREATE TABLE module_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  client_id varchar(120) NOT NULL UNIQUE,
  client_secret_hash char(64) NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  topic varchar(160) NOT NULL,
  aggregate_type varchar(80) NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending_idx ON outbox_events (created_at) WHERE published_at IS NULL;

INSERT INTO permissions (key, description) VALUES
 ('organisation.read','View organisation settings'), ('organisation.manage','Manage organisation settings'),
 ('users.read','View organisation users'), ('users.manage','Invite and manage organisation users'),
 ('structure.read','View branches, departments and teams'), ('structure.manage','Manage branches, departments and teams'),
 ('roles.read','View roles and permissions'), ('roles.manage','Manage roles and role assignments'),
 ('audit.read','View audit records'), ('operations.read','View operation items'),
 ('operations.manage','Create and update operation items'), ('workflows.read','View workflows and runs'),
 ('workflows.manage','Create and publish workflows'), ('workflows.execute','Start and action workflows'),
 ('modules.manage','Manage module API clients'), ('ai.invoke','Invoke services through the AI Gateway')
ON CONFLICT (key) DO NOTHING;

INSERT INTO roles (organisation_id, key, name, description, is_system)
VALUES (NULL, 'owner', 'Organisation Owner', 'Full organisation administration', true),
       (NULL, 'admin', 'Administrator', 'Day-to-day organisation administration', true),
       (NULL, 'member', 'Member', 'Standard operational access', true),
       (NULL, 'auditor', 'Auditor', 'Read-only audit and operations access', true)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.key = 'owner' AND r.organisation_id IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN ('organisation.read','users.read','users.manage','structure.read','structure.manage','roles.read','operations.read','operations.manage','workflows.read','workflows.manage','workflows.execute','modules.manage','ai.invoke')
WHERE r.key = 'admin' AND r.organisation_id IS NULL ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN ('organisation.read','structure.read','operations.read','operations.manage','workflows.read','workflows.execute')
WHERE r.key = 'member' AND r.organisation_id IS NULL ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN ('organisation.read','users.read','structure.read','roles.read','audit.read','operations.read','workflows.read')
WHERE r.key = 'auditor' AND r.organisation_id IS NULL ON CONFLICT DO NOTHING;
