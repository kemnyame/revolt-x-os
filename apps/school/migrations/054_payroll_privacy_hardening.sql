-- Payroll privacy: full payroll registers are limited to HR/leadership and Finance roles.
-- Other active staff use /api/payroll/me to view only their own payslips.
UPDATE school_role_capabilities
SET allowed=false,updated_at=now()
WHERE capability_key IN('payroll.view','payroll.manage','payroll.process')
  AND role NOT IN('school_admin','headteacher','registrar','accountant','bursar');

UPDATE school_role_capabilities
SET allowed=true,updated_at=now()
WHERE capability_key='payroll.view'
  AND role IN('school_admin','headteacher','registrar','accountant','bursar');

UPDATE school_role_capabilities
SET allowed=true,updated_at=now()
WHERE capability_key='payroll.manage'
  AND role IN('school_admin','headteacher','registrar');

UPDATE school_role_capabilities
SET allowed=true,updated_at=now()
WHERE capability_key='payroll.process'
  AND role IN('school_admin','accountant','bursar');
