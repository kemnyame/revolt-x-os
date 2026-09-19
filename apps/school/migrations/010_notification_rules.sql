CREATE TABLE IF NOT EXISTS notification_rules (
  organisation_id uuid NOT NULL,
  event_key varchar(100) NOT NULL,
  channel varchar(20) NOT NULL CHECK(channel IN('email','sms','whatsapp')),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_os_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,event_key,channel)
);

INSERT INTO notification_rules(organisation_id,event_key,channel,enabled)
SELECT sp.organisation_id,e.event_key,c.channel,true
FROM school_profiles sp
CROSS JOIN (VALUES
  ('admission.received'),
  ('admission.status_changed'),
  ('fees.payment_requested'),
  ('fees.payment_received'),
  ('reports.submitted'),
  ('reports.approved'),
  ('reports.returned')
) e(event_key)
CROSS JOIN (VALUES('email'),('sms'),('whatsapp')) c(channel)
ON CONFLICT(organisation_id,event_key,channel) DO NOTHING;
