-- Finance roles can maintain fee setup and payment requests from the Accounts workspace.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,true
FROM school_roles sr
CROSS JOIN (VALUES
  ('fees.view'),('fees.create'),('fees.edit'),('fees.record'),
  ('payments.initiate'),('payments.configure'),
  ('finance.view'),('finance.manage'),('finance.post'),('finance.report'),
  ('finance.receive_student_payment'),('finance.payment_setup')
) c(key)
WHERE sr.key IN('school_admin','accountant','bursar')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();
