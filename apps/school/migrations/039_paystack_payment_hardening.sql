-- Paystack payment hardening and provider-managed checkout support.
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS provider_channel varchar(40),
  ADD COLUMN IF NOT EXISTS receipt_notified_at timestamptz;

ALTER TABLE payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_method_check;

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_method_check
  CHECK(method IN('card','mobile_money','cash','paystack'));

CREATE INDEX IF NOT EXISTS payment_intents_receipt_notification_idx
  ON payment_intents(status,receipt_notified_at)
  WHERE status='success' AND receipt_notified_at IS NULL;
