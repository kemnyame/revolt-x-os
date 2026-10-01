-- Grade level create/edit support.
-- Existing grade_levels already enforces unique code and promotion/display order per school.
-- This migration adds lookup indexes used by setup, admissions, class creation and promotion flows.

CREATE INDEX IF NOT EXISTS school_grade_levels_active_order_idx
  ON grade_levels(organisation_id,is_active,level_order);

CREATE INDEX IF NOT EXISTS school_grade_levels_stage_idx
  ON grade_levels(organisation_id,stage,is_active);
