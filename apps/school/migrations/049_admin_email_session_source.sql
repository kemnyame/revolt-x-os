-- Allow dedicated School Administrator sessions created through Admin Email login.
DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname='school_sessions_source_check'
      AND conrelid='school_sessions'::regclass
  ) THEN
    ALTER TABLE school_sessions DROP CONSTRAINT school_sessions_source_check;
  END IF;

  ALTER TABLE school_sessions
    ADD CONSTRAINT school_sessions_source_check
    CHECK(source IN('core_exchange','preview','quick_login','staff_id','admin_email'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
