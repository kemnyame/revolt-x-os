-- Harden sensitive student access and backfill the durable School staff directory.

-- Ordinary teachers and finance-only roles must not inherit Student 360/full-profile
-- merely because an internal workflow needs students.view reference data.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,false
FROM school_roles sr
CROSS JOIN (VALUES('students.360.view'),('students.profile.view')) c(key)
WHERE sr.key IN('teacher','accountant','bursar')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=false,updated_at=now();

-- Leadership/records roles may retain the sensitive student views by default.
INSERT INTO school_role_capabilities(organisation_id,role,capability_key,allowed)
SELECT sr.organisation_id,sr.key,c.key,true
FROM school_roles sr
CROSS JOIN (VALUES('students.360.view'),('students.profile.view')) c(key)
WHERE sr.key IN('headteacher','registrar')
ON CONFLICT(organisation_id,role,capability_key)
DO UPDATE SET allowed=true,updated_at=now();

-- Recover the most recent known staff identity from School sessions.
WITH latest_session AS (
  SELECT DISTINCT ON (organisation_id,os_user_id)
    organisation_id,os_user_id,core_context,created_at
  FROM school_sessions
  ORDER BY organisation_id,os_user_id,created_at DESC
)
INSERT INTO school_user_directory(
  organisation_id,os_user_id,core_membership_id,first_name,last_name,email,
  job_title,employee_number,user_status,membership_status,roles,synced_at
)
SELECT
  ls.organisation_id,ls.os_user_id,
  CASE WHEN COALESCE(ls.core_context->>'membership_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN (ls.core_context->>'membership_id')::uuid ELSE NULL END,
  COALESCE(NULLIF(trim(ls.core_context->>'first_name'),''),'Staff'),
  COALESCE(NULLIF(trim(ls.core_context->>'last_name'),''),
           upper(right(replace(ls.os_user_id::text,'-',''),6))),
  CASE WHEN COALESCE(ls.core_context->>'email','') LIKE '%@revolt-x.local' THEN NULL
       ELSE NULLIF(trim(ls.core_context->>'email'),'') END,
  NULL,NULL,
  NULLIF(ls.core_context->>'status',''),
  NULLIF(ls.core_context->>'membership_status',''),
  COALESCE(ls.core_context->'roles','[]'::jsonb),
  ls.created_at
FROM latest_session ls
ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET
  core_membership_id=COALESCE(EXCLUDED.core_membership_id,school_user_directory.core_membership_id),
  first_name=CASE WHEN EXCLUDED.first_name<>'Staff' THEN EXCLUDED.first_name ELSE school_user_directory.first_name END,
  last_name=EXCLUDED.last_name,
  email=COALESCE(EXCLUDED.email,school_user_directory.email),
  user_status=COALESCE(EXCLUDED.user_status,school_user_directory.user_status),
  membership_status=COALESCE(EXCLUDED.membership_status,school_user_directory.membership_status),
  roles=CASE WHEN EXCLUDED.roles<>'[]'::jsonb THEN EXCLUDED.roles ELSE school_user_directory.roles END,
  synced_at=GREATEST(school_user_directory.synced_at,EXCLUDED.synced_at);

-- Creation/change history often knows the friendly name, job title and staff number.
WITH latest_change AS (
  SELECT DISTINCT ON (organisation_id,resource_id)
    organisation_id,resource_id,performed_on,new_value,created_at
  FROM school_change_logs
  WHERE resource_type IN('school_user','teacher')
    AND resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ORDER BY organisation_id,resource_id,created_at DESC
)
INSERT INTO school_user_directory(
  organisation_id,os_user_id,first_name,last_name,job_title,employee_number,roles,synced_at
)
SELECT
  lc.organisation_id,lc.resource_id::uuid,
  COALESCE(NULLIF(split_part(trim(lc.performed_on),' ',1),''),'Staff'),
  COALESCE(NULLIF(trim(regexp_replace(trim(lc.performed_on),'^[^ ]+\\s*','')),''),
           upper(right(replace(lc.resource_id,'-',''),6))),
  NULLIF(lc.new_value->>'jobTitle',''),
  NULLIF(lc.new_value->>'employeeNumber',''),
  '[]'::jsonb,
  lc.created_at
FROM latest_change lc
ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET
  first_name=CASE WHEN EXCLUDED.first_name<>'Staff' THEN EXCLUDED.first_name ELSE school_user_directory.first_name END,
  last_name=EXCLUDED.last_name,
  job_title=COALESCE(EXCLUDED.job_title,school_user_directory.job_title),
  employee_number=COALESCE(EXCLUDED.employee_number,school_user_directory.employee_number),
  synced_at=GREATEST(school_user_directory.synced_at,EXCLUDED.synced_at);

-- Guarantee that every School membership has a directory row even if Core is unavailable.
INSERT INTO school_user_directory(
  organisation_id,os_user_id,first_name,last_name,membership_status,roles,synced_at
)
SELECT sm.organisation_id,sm.os_user_id,
       COALESCE(sr.name,'School Staff'),
       upper(right(replace(sm.os_user_id::text,'-',''),6)),
       sm.status,'[]'::jsonb,sm.updated_at
FROM school_memberships sm
LEFT JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role
ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET
  membership_status=COALESCE(school_user_directory.membership_status,EXCLUDED.membership_status),
  synced_at=GREATEST(school_user_directory.synced_at,EXCLUDED.synced_at);
