-- The installable teacher/parent mobile app is included from Growth upward.
INSERT INTO saas_product_modules(product_id,module_key,name,description,base_monthly_price,dependency_keys,is_core,sort_order,is_active)
SELECT id,'school.mobile','Mobile App','Installable teacher and parent app, included from Growth',0,ARRAY['school.core'],false,145,true
FROM saas_products WHERE product_key='school'
ON CONFLICT(module_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,is_active=true;

INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT p.id,m.id,p.plan_key IN('growth','professional','enterprise')
FROM saas_pricing_plans p JOIN saas_products product ON product.id=p.product_id AND product.product_key='school'
JOIN saas_product_modules m ON m.product_id=product.id AND m.module_key='school.mobile'
WHERE p.plan_key IN('basic','starter','growth','professional','enterprise')
ON CONFLICT(plan_id,module_id) DO UPDATE SET included=EXCLUDED.included;
