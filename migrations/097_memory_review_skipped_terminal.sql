-- `skipped` joins the terminal states, so it carries `completed_at` and may outlive the application
-- session of the turn that abandoned it. The two original constraints were created inline and hold
-- generated names, so they are located by definition and their absence is an error rather than a
-- silent no-op: a surviving constraint would reject every skipped batch at runtime.
DO $$
DECLARE
  located text;
  dropped integer := 0;
BEGIN
  FOR located IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'memory_review_batches'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%completed_at IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE memory_review_batches DROP CONSTRAINT %I', located);
    dropped := dropped + 1;
  END LOOP;
  IF dropped <> 1 THEN
    RAISE EXCEPTION 'expected one terminal completed_at constraint, dropped %', dropped;
  END IF;

  dropped := 0;
  FOR located IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'memory_review_batches'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%application_session_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE memory_review_batches DROP CONSTRAINT %I', located);
    dropped := dropped + 1;
  END LOOP;
  IF dropped <> 1 THEN
    RAISE EXCEPTION 'expected one interactive session constraint, dropped %', dropped;
  END IF;
END $$;

ALTER TABLE memory_review_batches
  ADD CONSTRAINT memory_review_batches_terminal_completion CHECK (
    (status IN ('completed', 'failed', 'ambiguous', 'skipped')) = (completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT memory_review_batches_interactive_session CHECK (
    batch_kind <> 'interactive' OR
    status IN ('completed', 'failed', 'ambiguous', 'skipped') OR
    application_session_id IS NOT NULL
  );

-- One Eve turn reviews at most one batch. Terminal handling now resolves the batch from this pair,
-- so the contract that made a single result well defined becomes an enforced invariant.
CREATE UNIQUE INDEX memory_review_batches_eve_turn
  ON memory_review_batches (eve_session_id, eve_turn_id)
  WHERE eve_turn_id IS NOT NULL;
