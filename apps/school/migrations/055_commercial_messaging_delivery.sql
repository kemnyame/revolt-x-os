-- Preserve the exact email body across retries and distinguish provider acceptance
-- from confirmed recipient delivery without changing existing workflow statuses.
ALTER TABLE communication_outbox
  ADD COLUMN IF NOT EXISTS html_body text,
  ADD COLUMN IF NOT EXISTS provider_status varchar(50);
