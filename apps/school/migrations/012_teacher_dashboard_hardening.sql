ALTER TABLE class_subjects
  ADD COLUMN IF NOT EXISTS weekly_periods int NOT NULL DEFAULT 3
    CHECK(weekly_periods BETWEEN 1 AND 20);

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('homework.view','Homework','view','View homework','View homework for assigned classes and subjects',52),
('homework.create','Homework','create','Create homework','Create homework for assigned classes and subjects',53),
('homework.edit','Homework','edit','Edit and publish homework','Edit and publish homework for assigned classes and subjects',54),
('homework.score','Homework','save','Save homework submissions','Record submission status, marks and feedback',55),
('homework.delete','Homework','delete','Delete homework','Delete homework records within assigned teaching scope',56)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order;

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('school_admin','homework.view',true),
('school_admin','homework.create',true),
('school_admin','homework.edit',true),
('school_admin','homework.score',true),
('school_admin','homework.delete',true),
('headteacher','homework.view',true),
('headteacher','homework.create',true),
('headteacher','homework.edit',true),
('headteacher','homework.score',true),
('headteacher','homework.delete',true),
('teacher','homework.view',true),
('teacher','homework.create',true),
('teacher','homework.edit',true),
('teacher','homework.score',true),
('teacher','homework.delete',true),
('bursar','homework.view',false),
('bursar','homework.create',false),
('bursar','homework.edit',false),
('bursar','homework.score',false),
('bursar','homework.delete',false),
('registrar','homework.view',false),
('registrar','homework.create',false),
('registrar','homework.edit',false),
('registrar','homework.score',false),
('registrar','homework.delete',false)
ON CONFLICT(role,capability_key) DO UPDATE SET
  allowed=EXCLUDED.allowed,
  updated_at=now();

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
