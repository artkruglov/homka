-- The fixed 104 data hook in scripts/migrate.ts adds/backfills the space_id columns in this
-- same transaction before the migration ledger is written. This is not the runtime cutover.
-- Columns remain nullable during the staged conversion; new readers must never accept NULL.
CREATE TABLE space_record_migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration integer NOT NULL CHECK (migration=104),
  completed_at timestamptz NOT NULL DEFAULT now(),
  table_counts jsonb NOT NULL CHECK (jsonb_typeof(table_counts)='object'),
  total_rows bigint NOT NULL CHECK (total_rows>=0),
  updated_rows bigint NOT NULL CHECK (updated_rows>=0 AND updated_rows<=total_rows)
);

CREATE FUNCTION guard_space_record_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.space_id IS NOT NULL AND NEW.space_id IS DISTINCT FROM OLD.space_id AND NOT (
    NEW.space_id IS NULL AND NOT EXISTS(SELECT 1 FROM spaces WHERE id=OLD.space_id)
  ) THEN RAISE EXCEPTION 'AGENT_SPACE_RECORD_BOUNDARY_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
