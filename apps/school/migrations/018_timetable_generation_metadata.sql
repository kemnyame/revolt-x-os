ALTER TABLE timetable_entries
  ADD COLUMN IF NOT EXISTS schedule_source varchar(20) NOT NULL DEFAULT 'manual'
    CHECK(schedule_source IN('manual','auto')),
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS timetable_entries_generation_idx
  ON timetable_entries(organisation_id,academic_year_id,term_id,schedule_source,is_locked);
