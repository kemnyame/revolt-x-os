-- Multi-tenant commercial School licence state.
ALTER TABLE school_profiles
  ADD COLUMN IF NOT EXISTS tenant_slug varchar(100);

CREATE UNIQUE INDEX IF NOT EXISTS school_profiles_tenant_slug_uidx
  ON school_profiles(tenant_slug)
  WHERE tenant_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS school_license_state (
  organisation_id uuid PRIMARY KEY,
  license_code varchar(40),
  product_key varchar(80) NOT NULL DEFAULT 'school',
  plan_key varchar(80),
  plan_name varchar(120),
  status varchar(20) NOT NULL DEFAULT 'unlicensed',
  billing_frequency varchar(20),
  recurring_amount numeric(14,2) NOT NULL DEFAULT 0,
  currency varchar(8) NOT NULL DEFAULT 'GHS',
  period_end timestamptz,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  limits jsonb NOT NULL DEFAULT '{}',
  modules jsonb NOT NULL DEFAULT '[]',
  synced_at timestamptz NOT NULL DEFAULT now(),
  source varchar(30) NOT NULL DEFAULT 'core_os'
);

CREATE INDEX IF NOT EXISTS school_license_state_status_expiry_idx
  ON school_license_state(status,period_end);

CREATE TABLE IF NOT EXISTS school_provisioning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  event_type varchar(80) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'completed',
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS school_provisioning_events_org_idx
  ON school_provisioning_events(organisation_id,created_at DESC);
