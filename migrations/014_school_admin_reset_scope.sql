ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS purpose varchar(20) NOT NULL DEFAULT 'account' CHECK(purpose IN('account','school_admin'));
CREATE TABLE IF NOT EXISTS auth_configuration_state (
  key varchar(80) PRIMARY KEY,
  value_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
