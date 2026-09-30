-- Backfill tenant codes for School workspaces created before commercial provisioning.
UPDATE school_profiles
SET tenant_slug = lower(
  regexp_replace(
    regexp_replace(trim(school_name), '[^a-zA-Z0-9]+', '-', 'g'),
    '(^-+|-+$)', '', 'g'
  )
) || '-' || substr(organisation_id::text,1,6)
WHERE tenant_slug IS NULL OR btrim(tenant_slug)='';

CREATE UNIQUE INDEX IF NOT EXISTS school_profiles_tenant_slug_uidx
  ON school_profiles(tenant_slug)
  WHERE tenant_slug IS NOT NULL;
