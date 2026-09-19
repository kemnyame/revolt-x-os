CREATE TABLE IF NOT EXISTS school_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash varchar(64) NOT NULL UNIQUE,
  organisation_id uuid NOT NULL,
  os_user_id uuid NOT NULL,
  core_context jsonb NOT NULL,
  source varchar(30) NOT NULL DEFAULT 'core_exchange'
    CHECK(source IN('core_exchange','preview')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS school_sessions_lookup_idx
  ON school_sessions(token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS school_sessions_expiry_idx
  ON school_sessions(expires_at);

DELETE FROM school_sessions
WHERE expires_at < now() - interval '1 day'
   OR revoked_at IS NOT NULL;
