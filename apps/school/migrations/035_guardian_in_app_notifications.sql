-- Parent Portal in-app alerts independent of external delivery providers.

CREATE TABLE IF NOT EXISTS guardian_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  event_key varchar(120) NOT NULL,
  subject varchar(300) NOT NULL,
  body text NOT NULL,
  related_type varchar(120),
  related_id text,
  source_communication_id uuid REFERENCES communication_outbox(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS guardian_notifications_guardian_time_idx
  ON guardian_notifications(guardian_id,created_at DESC);

CREATE INDEX IF NOT EXISTS guardian_notifications_unread_idx
  ON guardian_notifications(guardian_id,created_at DESC)
  WHERE read_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS guardian_notifications_source_unique_idx
  ON guardian_notifications(guardian_id,source_communication_id)
  WHERE source_communication_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS guardian_notifications_event_dedupe_idx
  ON guardian_notifications(
    guardian_id,
    event_key,
    COALESCE(related_type,''),
    COALESCE(related_id,''),
    md5(body)
  );

-- Preserve alerts that already existed in the external communications outbox.
INSERT INTO guardian_notifications(
  organisation_id,guardian_id,event_key,subject,body,related_type,related_id,
  source_communication_id,created_at,read_at
)
SELECT DISTINCT ON (g.id,co.id)
  co.organisation_id,g.id,COALESCE(co.template_key,'school.notification'),
  COALESCE(co.subject,'School alert'),co.body,co.related_type,
  co.related_id::text,co.id,co.created_at,gar.read_at
FROM communication_outbox co
JOIN guardians g
  ON g.organisation_id=co.organisation_id
 AND (
   (co.channel='email' AND g.email IS NOT NULL AND lower(g.email)=lower(co.recipient_address))
   OR
   (co.channel IN('sms','whatsapp')
      AND regexp_replace(g.phone,'\D','','g')=regexp_replace(co.recipient_address,'\D','','g'))
 )
LEFT JOIN guardian_alert_reads gar
  ON gar.guardian_id=g.id AND gar.communication_id=co.id
ON CONFLICT DO NOTHING;
