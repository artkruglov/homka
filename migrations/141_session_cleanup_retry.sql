-- A retention deletion that failed used to park its session forever: the claim skipped any row
-- carrying `cleanup_error_code`, and only a manual edit could clear it. The usual cause is an Eve
-- session run parked on a hook that never leaves `running`, so the session and its whole Workflow
-- event log stayed alive and every agent start re-read it (upstream 63d7e65, migration 101). The
-- retry deadline lives in its own column because the lease pair is constrained to be set or
-- cleared together, and a failed row holds no lease.
ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS cleanup_retry_after timestamptz;

-- Rows already parked by the old behaviour become eligible on the next sweep.
UPDATE conversation_sessions
   SET cleanup_retry_after = now()
 WHERE cleanup_error_code IS NOT NULL AND cleanup_retry_after IS NULL;
