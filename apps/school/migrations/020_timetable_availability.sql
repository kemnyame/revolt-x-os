CREATE TABLE IF NOT EXISTS timetable_teacher_unavailability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
  teacher_os_user_id uuid NOT NULL,
  day_of_week int NOT NULL CHECK(day_of_week BETWEEN 1 AND 5),
  start_time time NOT NULL,
  end_time time NOT NULL,
  reason varchar(300),
  created_by_os_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(end_time > start_time)
);

CREATE INDEX IF NOT EXISTS timetable_teacher_unavailability_lookup_idx
  ON timetable_teacher_unavailability(
    organisation_id,academic_year_id,teacher_os_user_id,term_id,day_of_week,start_time,end_time
  );

CREATE UNIQUE INDEX IF NOT EXISTS timetable_teacher_unavailability_unique
  ON timetable_teacher_unavailability(
    organisation_id,academic_year_id,teacher_os_user_id,
    COALESCE(term_id,'00000000-0000-0000-0000-000000000000'::uuid),
    day_of_week,start_time,end_time
  );
