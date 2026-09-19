INSERT INTO student_fees(organisation_id,student_id,fee_item_id,amount_due)
SELECT e.organisation_id,e.student_id,f.id,f.amount
FROM enrolments e
JOIN classrooms c ON c.id=e.classroom_id
JOIN fee_items f
  ON f.organisation_id=e.organisation_id
 AND f.academic_year_id=e.academic_year_id
 AND f.mandatory=true
 AND (f.grade_level_id IS NULL OR f.grade_level_id=c.grade_level_id)
WHERE e.status='active'
ON CONFLICT(student_id,fee_item_id) DO NOTHING;
