CREATE TABLE IF NOT EXISTS class_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(academic_year_id,classroom_id,subject_id)
);

CREATE INDEX IF NOT EXISTS class_subjects_class_idx
  ON class_subjects(organisation_id,classroom_id,is_active);

CREATE INDEX IF NOT EXISTS class_subjects_subject_idx
  ON class_subjects(organisation_id,subject_id,is_active);
