-- Executive assurance, customer reports and tenant backup management.

INSERT INTO permissions(key,description) VALUES
 ('commercial.reports','Request, generate and download customer organisation reports'),
 ('commercial.audit','Review commercial and customer organisation audit assurance'),
 ('commercial.backups','Run, inspect and download customer organisation backups')
ON CONFLICT(key) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.organisation_id IS NULL
  AND r.key IN('owner','admin')
  AND p.key IN('commercial.reports','commercial.audit','commercial.backups')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_report_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  report_key varchar(100) NOT NULL,
  report_name varchar(200) NOT NULL,
  category varchar(80) NOT NULL,
  format varchar(20) NOT NULL DEFAULT 'json' CHECK(format IN('json')),
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed')),
  progress int NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  parameters jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  error text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_report_requests_provider_idx
  ON saas_report_requests(provider_organisation_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS saas_report_requests_customer_idx
  ON saas_report_requests(provider_organisation_id,customer_organisation_id,requested_at DESC);

CREATE TABLE IF NOT EXISTS saas_backup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  backup_type varchar(30) NOT NULL DEFAULT 'tenant_logical' CHECK(backup_type IN('tenant_logical')),
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed')),
  progress int NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  phase varchar(120),
  table_count int NOT NULL DEFAULT 0,
  row_count bigint NOT NULL DEFAULT 0,
  size_bytes bigint NOT NULL DEFAULT 0,
  checksum_sha256 char(64),
  snapshot jsonb,
  error text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  retention_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_backup_jobs_provider_idx
  ON saas_backup_jobs(provider_organisation_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS saas_backup_jobs_customer_idx
  ON saas_backup_jobs(provider_organisation_id,customer_organisation_id,requested_at DESC);

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS severity varchar(20) NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS source varchar(80) NOT NULL DEFAULT 'core_os',
  ADD COLUMN IF NOT EXISTS previous_event_hash char(64),
  ADD COLUMN IF NOT EXISTS event_hash char(64),
  ADD COLUMN IF NOT EXISTS integrity_version smallint NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS audit_logs_action_time_idx
  ON audit_logs(action,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_outcome_time_idx
  ON audit_logs(outcome,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx
  ON audit_logs(resource_type,resource_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_hash_idx
  ON audit_logs(organisation_id,event_hash)
  WHERE event_hash IS NOT NULL;
