-- Names repeat across academic years, but a class/stream must not be created
-- twice in the same school/year through case, whitespace or concurrent saves.
CREATE UNIQUE INDEX IF NOT EXISTS classrooms_normalized_name_stream_year_idx
  ON classrooms(organisation_id,academic_year_id,lower(btrim(name)),COALESCE(lower(btrim(stream)),''));
