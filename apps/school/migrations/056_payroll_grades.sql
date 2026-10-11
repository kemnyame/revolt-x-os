-- Commercial payroll: reusable salary grades and grade-level earnings/deductions.
-- Individual staff assignments remain available for personal items such as loans,
-- one-off allowances and other employee-specific adjustments.

CREATE TABLE IF NOT EXISTS payroll_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  code varchar(40) NOT NULL,
  name varchar(160) NOT NULL,
  base_salary numeric(14,2) NOT NULL DEFAULT 0 CHECK(base_salary>=0),
  currency varchar(10) NOT NULL DEFAULT 'GHS',
  is_active boolean NOT NULL DEFAULT true,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,code)
);

CREATE TABLE IF NOT EXISTS payroll_grade_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  grade_id uuid NOT NULL REFERENCES payroll_grades(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES payroll_components(id) ON DELETE CASCADE,
  value_override numeric(14,2) CHECK(value_override IS NULL OR value_override>=0),
  rate_override numeric(8,4) CHECK(rate_override IS NULL OR rate_override>=0),
  is_active boolean NOT NULL DEFAULT true,
  created_by_os_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(grade_id,component_id)
);

ALTER TABLE staff_payroll_profiles
  ADD COLUMN IF NOT EXISTS grade_id uuid REFERENCES payroll_grades(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS payroll_grades_org_idx
  ON payroll_grades(organisation_id,is_active,code);
CREATE INDEX IF NOT EXISTS payroll_grade_components_grade_idx
  ON payroll_grade_components(organisation_id,grade_id,is_active);
CREATE INDEX IF NOT EXISTS staff_payroll_profiles_grade_idx
  ON staff_payroll_profiles(organisation_id,grade_id);
