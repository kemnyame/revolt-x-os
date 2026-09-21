-- Granular Finance & Accounts workspace access, dependency repair, and accountant visibility.
-- Each Finance tab is now independently assignable in Access Management.

INSERT INTO school_capabilities(key,module,action,label,description,sort_order) VALUES
('finance.overview.view','Finance & Accounts','view','Overview','Open the Finance & Accounts overview dashboard',170),
('finance.student_payments.view','Finance & Accounts','view','Student Payments','Search student accounts and view student payment workspaces',171),
('finance.parent_payment_requests.view','Finance & Accounts','view','Parent Payment Requests','View and manage parent payment requests',172),
('finance.setup.view','Finance & Accounts','view','Payment, Fees & GL Setup','Open payment methods, fee setup and GL mapping',173),
('finance.expenses.view','Finance & Accounts','view','Expenses','View the expense register',174),
('finance.journals.view','Finance & Accounts','view','Journals','View finance journal entries',175),
('finance.taxes.view','Finance & Accounts','view','Taxes','View tax setup, obligations and payment history',176),
('finance.budgets.view','Finance & Accounts','view','Budgets','View finance budgets',177),
('finance.accounts.view','Finance & Accounts','view','Chart of Accounts','View the chart of accounts and balances',178),
('finance.vendors.view','Finance & Accounts','view','Vendors','View finance vendors',179),
('finance.reversals.view','Finance & Accounts','view','Reversal Module','Open the finance reversal workspace',180),
('finance.eod.view','Finance & Accounts','view','End of Day','View End of Day runs and generated reports',181),
('finance.reports.view','Finance & Accounts','view','Reports','Run and view financial reports',182)
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order;

-- Preserve historical Finance access for custom roles by mapping their existing finance.view
-- permission to all Finance workspace tabs. Standard roles receive deliberate defaults below.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT existing.organisation_id,existing.role,c.key,true
FROM school_role_capabilities existing
CROSS JOIN (VALUES
 ('finance.overview.view'),('finance.student_payments.view'),('finance.parent_payment_requests.view'),
 ('finance.setup.view'),('finance.expenses.view'),('finance.journals.view'),('finance.taxes.view'),
 ('finance.budgets.view'),('finance.accounts.view'),('finance.vendors.view'),('finance.reversals.view'),
 ('finance.eod.view'),('finance.reports.view')
) c(key)
WHERE existing.capability_key='finance.view'
  AND existing.allowed=true
  AND existing.role NOT IN('headteacher')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Headteacher retains a review-oriented finance view rather than transactional setup.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,true
FROM school_roles sr
CROSS JOIN (VALUES('finance.overview.view'),('finance.eod.view'),('finance.reports.view')) c(key)
WHERE sr.key='headteacher'
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Repair the Accountant/Bursar dependency mismatch that caused students.view/reports.view 403s
-- inside Finance & Accounts. Finance currently needs these read-only school reference datasets.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,true
FROM school_roles sr
CROSS JOIN (VALUES
 ('finance.view'),('students.view'),('reports.view'),('academic.view'),('fees.view'),('tax.view')
) c(key)
WHERE sr.key IN('accountant','bursar')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Any custom role that already has Finance access also receives the read dependencies required
-- to render the Finance workspace without hidden cross-module permission failures.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT fv.organisation_id,fv.role,d.key,true
FROM school_role_capabilities fv
CROSS JOIN (VALUES('students.view'),('reports.view'),('academic.view'),('fees.view'),('tax.view')) d(key)
WHERE fv.capability_key='finance.view' AND fv.allowed=true
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();
