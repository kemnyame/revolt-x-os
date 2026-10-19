-- A temporary-password session cannot be upgraded by refreshing its token.
ALTER TABLE sessions ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;
