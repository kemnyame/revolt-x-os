-- Academic reporting and rollover consistency fixes.
-- 1) Exams are entered as raw marks out of 100 and scaled to the 70% report component.
-- 2) Every academic year owns exactly three fixed terms; only their dates remain editable.

UPDATE assessment_categories
SET default_max_score=100,weight_percent=70,name='End-of-Term Examination',is_active=true,updated_at=now()
WHERE code='EXAM';

UPDATE terms
SET name=CASE term_no WHEN 1 THEN 'First Term' WHEN 2 THEN 'Second Term' WHEN 3 THEN 'Third Term' ELSE name END
WHERE term_no IN(1,2,3);

-- Promotion is an annual/cumulative outcome and belongs only on Third Term reports.
UPDATE report_comments rc
SET promotion_decision=NULL,
    promotion_basis=NULL,
    promotion_threshold_percent=NULL,
    promotion_override_reason=NULL,
    promotion_overridden_by_os_user_id=NULL
FROM terms t
WHERE rc.term_id=t.id AND t.term_no IN(1,2);


WITH year_span AS (
  SELECT y.id academic_year_id,y.organisation_id,y.start_date,y.end_date,
    GREATEST(3,(y.end_date-y.start_date)+1) total_days
  FROM academic_years y
),
slots AS (
  SELECT ys.*,v.term_no,
    CASE v.term_no
      WHEN 1 THEN ys.start_date
      WHEN 2 THEN ys.start_date + GREATEST(1,FLOOR(ys.total_days/3.0)::int)
      ELSE ys.start_date + GREATEST(2,FLOOR((ys.total_days*2)/3.0)::int)
    END term_start,
    CASE v.term_no
      WHEN 1 THEN ys.start_date + GREATEST(0,FLOOR(ys.total_days/3.0)::int-1)
      WHEN 2 THEN ys.start_date + GREATEST(1,FLOOR((ys.total_days*2)/3.0)::int-1)
      ELSE ys.end_date
    END term_end
  FROM year_span ys CROSS JOIN (VALUES(1),(2),(3)) v(term_no)
)
INSERT INTO terms(organisation_id,academic_year_id,term_no,name,start_date,end_date,status)
SELECT organisation_id,academic_year_id,term_no,
  CASE term_no WHEN 1 THEN 'First Term' WHEN 2 THEN 'Second Term' ELSE 'Third Term' END,
  term_start,term_end,'planned'
FROM slots
ON CONFLICT(academic_year_id,term_no) DO UPDATE
SET name=EXCLUDED.name;
