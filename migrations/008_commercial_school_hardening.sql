-- Commercial control hardening for school licence dashboard and reports.

-- The assurance report reads verified_at from customer domains. Older deployments may not have the column.
ALTER TABLE saas_customer_domains
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Keep useful indexes for the new grouped billing and dashboard support views.
CREATE INDEX IF NOT EXISTS saas_invoices_provider_customer_status_idx
  ON saas_invoices(provider_organisation_id, customer_organisation_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS saas_subscriptions_provider_customer_status_idx
  ON saas_subscriptions(provider_organisation_id, customer_organisation_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS saas_provisioning_jobs_provider_status_idx
  ON saas_provisioning_jobs(provider_organisation_id, status, created_at DESC);
