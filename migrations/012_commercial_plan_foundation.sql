-- Revolt-X OS commercial plan foundation.
--
-- A School subscription always starts from a clearly defined Basic plan. Higher plans add
-- capabilities; they do not remove the operational minimum required for a usable School tenant.

WITH product AS (
  SELECT id FROM saas_products WHERE product_key='school'
)
INSERT INTO saas_pricing_plans(
  product_id,plan_key,name,description,monthly_price,termly_price,annual_price,currency,
  student_limit,staff_limit,campus_limit,storage_gb,is_custom,is_active,sort_order
)
SELECT id,'basic','Basic',
  'Required School foundation: administration, admissions, students, academics, attendance and staff directory.',
  149,410,1490,'GHS',250,25,1,5,false,true,5
FROM product
ON CONFLICT(product_id,plan_key) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  is_active=true,
  sort_order=EXCLUDED.sort_order;

-- These modules make up the non-optional School foundation. `is_core=true` is used by the
-- commercial API and database triggers to prevent a plan or customer override from disabling
-- the minimum working product.
UPDATE saas_product_modules
SET is_core=true,updated_at=now()
WHERE module_key IN(
  'school.core',
  'school.admissions',
  'school.students',
  'school.academics',
  'school.attendance',
  'school.staff'
);

-- Basic receives every core module.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true
FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id AND m.is_core=true AND m.is_active=true
WHERE pl.plan_key='basic'
ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;

-- Existing plans must also retain the baseline. This protects current customers when the plan
-- catalogue is edited later from Commercial Control.
INSERT INTO saas_plan_modules(plan_id,module_id,included)
SELECT pl.id,m.id,true
FROM saas_pricing_plans pl
JOIN saas_products p ON p.id=pl.product_id AND p.product_key='school'
JOIN saas_product_modules m ON m.product_id=p.id AND m.is_core=true AND m.is_active=true
WHERE pl.is_active=true
ON CONFLICT(plan_id,module_id) DO UPDATE SET included=true;

-- Database guard: UI/API bugs must not be able to switch off a baseline module for a single
-- School subscription. Non-core modules remain fully configurable.
CREATE OR REPLACE FUNCTION protect_core_subscription_module()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE core_module boolean;
BEGIN
  SELECT is_core INTO core_module FROM saas_product_modules WHERE id=NEW.module_id;
  IF COALESCE(core_module,false) AND NEW.enabled=false THEN
    RAISE EXCEPTION 'Core School modules cannot be disabled for an individual subscription';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_core_subscription_module_trg ON saas_subscription_modules;
CREATE TRIGGER protect_core_subscription_module_trg
BEFORE INSERT OR UPDATE OF enabled,module_id ON saas_subscription_modules
FOR EACH ROW EXECUTE FUNCTION protect_core_subscription_module();

-- Plan-level guard for the same reason. A baseline module may be present explicitly or inherited,
-- but if a row exists it cannot say included=false.
CREATE OR REPLACE FUNCTION protect_core_plan_module()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE core_module boolean;
BEGIN
  SELECT is_core INTO core_module FROM saas_product_modules WHERE id=NEW.module_id;
  IF COALESCE(core_module,false) AND NEW.included=false THEN
    RAISE EXCEPTION 'Core School modules cannot be excluded from a pricing plan';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_core_plan_module_trg ON saas_plan_modules;
CREATE TRIGGER protect_core_plan_module_trg
BEFORE INSERT OR UPDATE OF included,module_id ON saas_plan_modules
FOR EACH ROW EXECUTE FUNCTION protect_core_plan_module();

-- Dedicated licence administrators can be granted a narrow system role instead of receiving
-- the broad Core OS administrator role. The same authentication system is used; permissions
-- determine whether the user enters Core OS or the Commercial/Licence workspace.
INSERT INTO roles(organisation_id,key,name,description,is_system)
VALUES(NULL,'license_admin','Licence Administrator',
  'Manage School customers, plans, modules, licences and subscription billing without full Core OS administration.',true)
ON CONFLICT NULLS NOT DISTINCT (organisation_id,key) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,is_system=true;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.key IN('commercial.read','commercial.manage','commercial.billing')
WHERE r.organisation_id IS NULL AND r.key='license_admin'
ON CONFLICT DO NOTHING;
