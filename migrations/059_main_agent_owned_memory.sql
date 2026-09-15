-- The main chat agent now owns semantic save/thread decisions. Retire automatic timeline extraction
-- before releasing retention holds so future conversation pruning cannot leak behind a dead worker.
DROP TRIGGER IF EXISTS telegram_group_messages_hold_for_memory_extraction
  ON telegram_group_messages;
DROP FUNCTION IF EXISTS hold_timeline_entry_for_memory_extraction();
DROP TRIGGER IF EXISTS memory_extraction_batches_create_job ON memory_extraction_batches;
DROP FUNCTION IF EXISTS create_memory_extraction_job();
DELETE FROM memory_extraction_retention_holds;

-- Every unfinished provider workflow becomes an explicit terminal historical record. Existing claims,
-- evidence, profiles, projects, threads, outcomes, and thread entries remain untouched.
UPDATE memory_thread_brief_jobs
SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
    diagnostic_code = 'AGENT_MEMORY_BACKGROUND_PIPELINE_RETIRED', completed_at = now(), updated_at = now()
WHERE status IN ('pending', 'leased');

UPDATE memory_thread_discovery_jobs
SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
    diagnostic_code = 'AGENT_MEMORY_BACKGROUND_PIPELINE_RETIRED', completed_at = now(), updated_at = now()
WHERE status IN ('pending', 'leased');

UPDATE memory_consolidation_jobs
SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
    diagnostic_code = 'AGENT_MEMORY_BACKGROUND_PIPELINE_RETIRED', completed_at = now(), updated_at = now()
WHERE status IN ('pending', 'leased');

DELETE FROM memory_extraction_approval_notices WHERE status = 'pending';

UPDATE memory_extraction_candidates
SET resolution_status = 'resolution_failed',
    resolution_diagnostic_code = 'AGENT_MEMORY_BACKGROUND_PIPELINE_RETIRED',
    resolution_lease_token = NULL, resolution_lease_expires_at = NULL,
    resolved_at = now(), content = NULL,
    content_erased_at = coalesce(content_erased_at, now()),
    plaintext_erased_at = coalesce(plaintext_erased_at, now())
WHERE resolution_status IN (
  'pending', 'resolution_processing', 'approval_pending', 'consolidation_pending'
);

UPDATE memory_extraction_jobs
SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
    diagnostic_code = 'AGENT_MEMORY_BACKGROUND_PIPELINE_RETIRED', partial_results = false,
    candidate_count = NULL, output_payload_hash = NULL, completed_at = now(), updated_at = now()
WHERE status IN ('pending', 'leased');

UPDATE memory_extraction_snapshot_entries
SET content_text = NULL, erased_at = coalesce(erased_at, now())
WHERE content_text IS NOT NULL;
UPDATE memory_extraction_ranges SET status = 'failed', updated_at = now()
WHERE status IN ('pending', 'leased');
UPDATE memory_extraction_batches
SET status = 'failed', snapshot_erased_at = coalesce(snapshot_erased_at, now()), updated_at = now()
WHERE status IN ('pending', 'leased');

-- Replay metadata records the exact atomic thread side effect. Nullable columns preserve all
-- historical mutation operations without inventing a thread result for them.
ALTER TABLE memory_mutation_operations
  ADD COLUMN thread_id uuid REFERENCES memory_threads(id) ON DELETE CASCADE,
  ADD COLUMN thread_action text CHECK (thread_action IN ('attached', 'created')),
  ADD CONSTRAINT memory_mutation_operation_thread_shape CHECK (
    (thread_id IS NULL) = (thread_action IS NULL)
  );

CREATE INDEX memory_mutation_operations_thread
  ON memory_mutation_operations(thread_id) WHERE thread_id IS NOT NULL;
