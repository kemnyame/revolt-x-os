CREATE OR REPLACE FUNCTION report_delivery_withheld_for_fees(p_organisation_id uuid,p_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT sss.block_report_delivery_when_fees_owed
    FROM school_security_settings sss
    WHERE sss.organisation_id=p_organisation_id
  ),false)
  AND EXISTS(
    SELECT 1
    FROM student_fees sf
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(p.amount),0) paid
      FROM payments p
      WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL
    ) pay ON true
    WHERE sf.organisation_id=p_organisation_id
      AND sf.student_id=p_student_id
    GROUP BY sf.student_id
    HAVING SUM(GREATEST(0,(sf.amount_due-sf.discount)-COALESCE(pay.paid,0)))>0.005
  );
$$;

COMMENT ON FUNCTION report_delivery_withheld_for_fees(uuid,uuid) IS
  'True only when the school report-delivery debt gate is enabled and the learner currently owes fees. Used to keep academic rollover independent from parent report delivery.';
