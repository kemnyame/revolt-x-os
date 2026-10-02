-- Backfill lesson-note review access for existing School tenants after the workflow upgrade.
-- School Administrators receive all capabilities implicitly in auth; Headteachers are explicit reviewers.

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed,updated_at)
SELECT sp.organisation_id,'headteacher','lesson_notes.review',true,now()
FROM school_profiles sp
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed,updated_at)
SELECT sp.organisation_id,'teacher','lesson_notes.review',false,now()
FROM school_profiles sp
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=false,updated_at=now();
