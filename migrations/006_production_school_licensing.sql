-- Production commercial licensing and provisioning metadata.
ALTER TABLE saas_subscriptions
  ADD COLUMN IF NOT EXISTS license_code varchar(40),
  ADD COLUMN IF NOT EXISTS provisioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

UPDATE saas_subscriptions
SET license_code='RXS-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16))
WHERE license_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saas_subscriptions_license_code_uidx
  ON saas_subscriptions(license_code)
  WHERE license_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS saas_subscriptions_provider_expiry_idx
  ON saas_subscriptions(provider_organisation_id,status,current_period_end);

ALTER TABLE saas_provisioning_jobs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS saas_provisioning_jobs_status_idx
  ON saas_provisioning_jobs(provider_organisation_id,status,created_at DESC);
