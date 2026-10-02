-- Simplify assessment/reporting to a fixed two-component scheme.
-- Continuous Assessment = 30%; End-of-Term Examination = 70%.
INSERT INTO assessment_categories(
  organisation_id,academic_year_id,term_id,code,name,default_max_score,weight_percent,sort_order,is_active
)
SELECT t.organisation_id,t.academic_year_id,t.id,'CONTINUOUS','Continuous Assessment',100,30,10,true
FROM terms t
ON CONFLICT(organisation_id,academic_year_id,term_id,code)
DO UPDATE SET name='Continuous Assessment',default_max_score=100,weight_percent=30,
              sort_order=10,is_active=true,updated_at=now();

INSERT INTO assessment_categories(
  organisation_id,academic_year_id,term_id,code,name,default_max_score,weight_percent,sort_order,is_active
)
SELECT t.organisation_id,t.academic_year_id,t.id,'EXAM','End-of-Term Examination',100,70,20,true
FROM terms t
ON CONFLICT(organisation_id,academic_year_id,term_id,code)
DO UPDATE SET name='End-of-Term Examination',default_max_score=100,weight_percent=70,
              sort_order=20,is_active=true,updated_at=now();

-- Preserve the assessment subtype, but place every non-final assessment under CONTINUOUS.
UPDATE assessments a
SET category_id=ca.id
FROM assessment_categories ca
WHERE ca.organisation_id=a.organisation_id
  AND ca.academic_year_id=a.academic_year_id
  AND ca.term_id=a.term_id
  AND ca.code='CONTINUOUS'
  AND (
    a.assessment_type<>'exam'
    OR lower(a.name) LIKE '%mid%term%'
    OR lower(a.name) LIKE '%mid-term%'
  );

-- Final examinations belong to the 70% EXAM component.
UPDATE assessments a
SET category_id=ex.id
FROM assessment_categories ex
WHERE ex.organisation_id=a.organisation_id
  AND ex.academic_year_id=a.academic_year_id
  AND ex.term_id=a.term_id
  AND ex.code='EXAM'
  AND a.assessment_type='exam'
  AND lower(a.name) NOT LIKE '%mid%term%'
  AND lower(a.name) NOT LIKE '%mid-term%';

-- Legacy categories remain for audit/history but no longer appear as active report-weight controls.
UPDATE assessment_categories
SET is_active=false,updated_at=now()
WHERE code NOT IN('CONTINUOUS','EXAM') AND is_active=true;
