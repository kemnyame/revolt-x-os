ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS teacher_os_user_id uuid;

UPDATE assessments
SET teacher_os_user_id=created_by_os_user_id
WHERE teacher_os_user_id IS NULL;

ALTER TABLE assessments
  ALTER COLUMN teacher_os_user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS assessments_teacher_idx
  ON assessments(organisation_id,teacher_os_user_id,term_id,classroom_id,subject_id);

ALTER TABLE homework_assignments
  ADD COLUMN IF NOT EXISTS teacher_os_user_id uuid;

UPDATE homework_assignments
SET teacher_os_user_id=created_by_os_user_id
WHERE teacher_os_user_id IS NULL;

ALTER TABLE homework_assignments
  ALTER COLUMN teacher_os_user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS homework_teacher_idx
  ON homework_assignments(organisation_id,teacher_os_user_id,term_id,classroom_id,subject_id);

INSERT INTO notification_rules(organisation_id,event_key,channel,enabled)
SELECT sp.organisation_id,e.event_key,c.channel,true
FROM school_profiles sp
CROSS JOIN (VALUES
  ('homework.published'),
  ('homework.submitted'),
  ('homework.graded')
) e(event_key)
CROSS JOIN (VALUES('email'),('sms'),('whatsapp')) c(channel)
ON CONFLICT(organisation_id,event_key,channel) DO NOTHING;
