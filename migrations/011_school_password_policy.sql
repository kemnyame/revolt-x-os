-- Unify School staff password behaviour without changing Core OS Super Admin authentication.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS school_password_bootstrapped_at timestamptz;

CREATE INDEX IF NOT EXISTS users_must_change_password_idx
  ON users (must_change_password)
  WHERE must_change_password=true;
