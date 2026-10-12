-- A school password must never replace an OS password or another school's password.
CREATE TABLE school_credentials (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  initialized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,user_id)
);
INSERT INTO school_credentials(organisation_id,user_id,password_hash,must_change_password,initialized_at)
SELECT DISTINCT m.organisation_id,u.id,u.password_hash,u.must_change_password,u.school_password_bootstrapped_at
FROM organisation_memberships m JOIN users u ON u.id=m.user_id
JOIN saas_customers c ON c.customer_organisation_id=m.organisation_id AND c.customer_type='school';
ALTER TABLE password_reset_tokens DROP CONSTRAINT password_reset_tokens_purpose_check;
ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_purpose_check CHECK(purpose IN('account','school_admin','school_staff'));
-- Old unbound links cannot safely identify which credential they should reset.
UPDATE password_reset_tokens SET used_at=now() WHERE organisation_id IS NULL AND used_at IS NULL;
