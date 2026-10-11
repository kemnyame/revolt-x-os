-- Commercial launch baseline: every School customer has a clear Basic plan.
-- Higher plans add modules while preserving the essential school-management baseline.

WITH p AS (SELECT id FROM saas_products WHERE product_key='school')
INSERT INTO saas_pricing_plans(
  product_id,plan_key,name,description,monthly_price,termly_price,annual_price,currency,
  student_limit,staff_limit,campus_limit,storage_gb,is_custom,is_active,sort_order
)
SELECT p.id,'basic','Basic','Essential school administration, student records, academics and attendance',
       149,420,1490,'GHS',200,25,1,3,false,true,5
FROM p
ON CONFLICT(product_id,plan_key) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,
  monthly_price=EXCLUDED.monthly_price,termly_price=EXCLUDED.termly_price,annual_price=EXCLUDED.annual_price,
  student_limit=EXCLUDED.student_limit,staff_limit=EXCLUDED.staff_limit,campus_limit=EXCLUDED.campus_limit,
  storage_gb=EXCLUDED.storage_gb,is_active=true,sort_order=EXCLUDED.sort_order,updated_at=now();

-- Basic is intentionally small and predictable. These are the standard modules every
-- Basic School receives. Plan/module editing in OS can extend higher plans without
-- changing this baseline.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true
FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id
WHERE pl.plan_key='basic'
  AND m.module_key IN('school.core','school.students','school.academics','school.attendance')
ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;

-- Keep the baseline capabilities available on all standard paid plans as well.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true
FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id
WHERE pl.plan_key IN('starter','growth','professional','enterprise')
  AND m.module_key IN('school.core','school.students','school.academics','school.attendance')
ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;
