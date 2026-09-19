INSERT INTO assessment_categories(
  organisation_id,academic_year_id,term_id,code,name,default_max_score,weight_percent,sort_order
)
SELECT t.organisation_id,t.academic_year_id,t.id,v.code,v.name,v.max_score,v.weight_percent,v.sort_order
FROM terms t
CROSS JOIN (VALUES
  ('CLASSWORK','Classwork',20::numeric,20::numeric,10),
  ('HOMEWORK','Homework',10::numeric,10::numeric,20),
  ('PROJECT','Project',30::numeric,20::numeric,30),
  ('MIDTERM','Mid-Term Test',50::numeric,20::numeric,40),
  ('EXAM','End-of-Term Examination',100::numeric,30::numeric,50)
) v(code,name,max_score,weight_percent,sort_order)
ON CONFLICT(organisation_id,academic_year_id,term_id,code)
DO UPDATE SET name=EXCLUDED.name,default_max_score=EXCLUDED.default_max_score,
              weight_percent=EXCLUDED.weight_percent,sort_order=EXCLUDED.sort_order,is_active=true,updated_at=now();

UPDATE assessments a
SET category_id=ac.id
FROM assessment_categories ac
WHERE ac.organisation_id=a.organisation_id
  AND ac.academic_year_id=a.academic_year_id
  AND ac.term_id=a.term_id
  AND ac.code=CASE a.assessment_type
    WHEN 'classwork' THEN 'CLASSWORK'
    WHEN 'homework' THEN 'HOMEWORK'
    WHEN 'project' THEN 'PROJECT'
    WHEN 'test' THEN 'MIDTERM'
    WHEN 'exam' THEN 'EXAM'
    ELSE 'CLASSWORK'
  END
  AND a.category_id IS NULL;

UPDATE school_role_capabilities
SET allowed=false,updated_at=now()
WHERE role='headteacher'
  AND capability_key IN('roles.manage','staff.delete');

UPDATE school_role_capabilities
SET allowed=true,updated_at=now()
WHERE role='headteacher'
  AND capability_key IN(
    'academic.view','academic.create','academic.edit','academic.delete',
    'students.view','students.create','students.edit',
    'attendance.view','attendance.mark',
    'assessment.view','assessment.create','assessment.edit','assessment.delete','assessment.score',
    'reports.view','reports.edit','reports.print',
    'staff.view','staff.create','staff.edit','roles.view',
    'timetable.view','timetable.manage',
    'admissions.view','admissions.manage',
    'communications.view','communications.manage',
    'promotion.manage','portals.manage'
  );

UPDATE school_role_capabilities
SET allowed=true,updated_at=now()
WHERE role='registrar'
  AND capability_key IN('roles.view','staff.view');

UPDATE school_role_capabilities
SET allowed=true,updated_at=now()
WHERE role IN('teacher','bursar')
  AND capability_key IN('roles.view');
