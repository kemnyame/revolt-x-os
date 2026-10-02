-- Workflow notifications and customizable School email branding.

CREATE TABLE IF NOT EXISTS staff_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  recipient_os_user_id uuid NOT NULL,
  event_key varchar(120) NOT NULL,
  subject varchar(300) NOT NULL,
  body text NOT NULL,
  related_type varchar(120),
  related_id varchar(160),
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS staff_notifications_recipient_time_idx
  ON staff_notifications(organisation_id,recipient_os_user_id,created_at DESC);

CREATE INDEX IF NOT EXISTS staff_notifications_unread_idx
  ON staff_notifications(organisation_id,recipient_os_user_id,created_at DESC)
  WHERE read_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS staff_notifications_dedupe_idx
  ON staff_notifications(
    organisation_id,
    recipient_os_user_id,
    event_key,
    COALESCE(related_type,''),
    COALESCE(related_id,''),
    md5(body)
  );

ALTER TABLE school_profiles
  ADD COLUMN IF NOT EXISTS email_accent_color varchar(20) NOT NULL DEFAULT '#24634e',
  ADD COLUMN IF NOT EXISTS email_header_text varchar(160),
  ADD COLUMN IF NOT EXISTS email_footer_text varchar(500);

-- Ensure the review capability is visible and assignable through Access Management.
INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('lesson_notes.review','Lesson Notes','approve','Review lesson notes','Approve or return another teacher''s submitted lesson note. A teacher can never approve their own lesson note.',51)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order;
