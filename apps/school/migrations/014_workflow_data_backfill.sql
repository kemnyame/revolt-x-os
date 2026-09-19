WITH next_terms AS (
  SELECT id,
         lead(start_date) OVER(PARTITION BY academic_year_id ORDER BY term_no) AS next_start
  FROM terms
)
UPDATE terms t
SET next_term_begins=n.next_start
FROM next_terms n
WHERE t.id=n.id
  AND t.next_term_begins IS NULL
  AND n.next_start IS NOT NULL;

UPDATE report_comments rc
SET next_term_begins=t.next_term_begins,
    updated_at=now()
FROM terms t
WHERE rc.term_id=t.id
  AND t.next_term_begins IS NOT NULL
  AND rc.next_term_begins IS DISTINCT FROM t.next_term_begins;

INSERT INTO admission_status_history(
  organisation_id,application_id,old_status,new_status,note,actor_os_user_id,created_at
)
SELECT aa.organisation_id,aa.id,NULL,aa.status,
       'Historical application status backfilled for tracking',
       aa.reviewed_by_os_user_id,
       COALESCE(aa.reviewed_at,aa.updated_at,aa.submitted_at,now())
FROM admission_applications aa
WHERE NOT EXISTS(
  SELECT 1 FROM admission_status_history h WHERE h.application_id=aa.id
);
