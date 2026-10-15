-- All writers, including manual edits and the scheduling agent, share this lock.
-- Check interval overlap (including partial overlaps), not only identical starts.
CREATE OR REPLACE FUNCTION prevent_school_timetable_conflicts() RETURNS trigger AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('timetable:'||NEW.organisation_id::text||':'||NEW.academic_year_id::text,0));
 IF EXISTS(SELECT 1 FROM timetable_entries t WHERE t.organisation_id=NEW.organisation_id
   AND t.academic_year_id=NEW.academic_year_id AND t.id<>NEW.id AND t.day_of_week=NEW.day_of_week
   AND (NEW.term_id IS NULL OR t.term_id IS NULL OR t.term_id=NEW.term_id)
   AND t.start_time<NEW.end_time AND t.end_time>NEW.start_time
   AND (t.classroom_id=NEW.classroom_id OR (NEW.teacher_os_user_id IS NOT NULL AND t.teacher_os_user_id=NEW.teacher_os_user_id)
     OR (NULLIF(trim(NEW.room),'') IS NOT NULL AND lower(trim(t.room))=lower(trim(NEW.room))))) THEN
   RAISE EXCEPTION 'This period conflicts with an existing class, teacher or room booking' USING ERRCODE='23P01';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS school_timetable_conflict_guard ON timetable_entries;
CREATE TRIGGER school_timetable_conflict_guard BEFORE INSERT OR UPDATE ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION prevent_school_timetable_conflicts();
