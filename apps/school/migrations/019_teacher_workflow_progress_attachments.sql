CREATE TABLE IF NOT EXISTS lesson_note_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  lesson_note_id uuid NOT NULL REFERENCES lesson_notes(id) ON DELETE CASCADE,
  file_name varchar(260) NOT NULL,
  mime_type varchar(160) NOT NULL,
  file_size int NOT NULL CHECK(file_size > 0 AND file_size <= 5242880),
  file_data bytea NOT NULL,
  uploaded_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lesson_note_attachments_note_idx
  ON lesson_note_attachments(organisation_id,lesson_note_id,created_at);

UPDATE classrooms
SET name=trim(name),
    stream=NULLIF(trim(COALESCE(stream,'')),'')
WHERE name<>trim(name)
   OR COALESCE(stream,'')<>COALESCE(NULLIF(trim(COALESCE(stream,'')),''),'');

UPDATE subjects
SET code=upper(trim(code)),
    name=trim(name)
WHERE code<>upper(trim(code)) OR name<>trim(name);

UPDATE assessments
SET name=trim(name)
WHERE name<>trim(name);

UPDATE homework_assignments
SET title=trim(title)
WHERE title<>trim(title);

CREATE UNIQUE INDEX IF NOT EXISTS classrooms_normalized_identity_unique
  ON classrooms(organisation_id,academic_year_id,lower(trim(name)),COALESCE(lower(trim(stream)),''));

CREATE UNIQUE INDEX IF NOT EXISTS assessments_normalized_identity_unique
  ON assessments(
    organisation_id,term_id,classroom_id,subject_id,teacher_os_user_id,
    lower(trim(name)),COALESCE(assessment_date,DATE '0001-01-01')
  );

CREATE UNIQUE INDEX IF NOT EXISTS homework_normalized_identity_unique
  ON homework_assignments(
    organisation_id,term_id,classroom_id,subject_id,teacher_os_user_id,
    lower(trim(title)),COALESCE(due_at,'0001-01-01 00:00:00+00'::timestamptz)
  );

UPDATE school_capabilities
SET label='Approve & release report cards',
    description='Approve submitted report cards and release them to Parent and Student portals',
    action='approve'
WHERE key='reports.approve';

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('teacher','reports.approve',true)
ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();

INSERT INTO school_role_capabilities(role,capability_key,allowed) VALUES
('teacher','lesson_notes.review',false),
('headteacher','lesson_notes.review',true),
('school_admin','lesson_notes.review',true)
ON CONFLICT(role,capability_key) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now();
