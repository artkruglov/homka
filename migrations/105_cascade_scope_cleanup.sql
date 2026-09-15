-- A group deletion retires its sessions and removes its review batches in the same cascade.
-- Validate the optional backlink after both sides have received ON DELETE SET NULL.
ALTER TABLE conversation_sessions
  ALTER CONSTRAINT conversation_sessions_memory_review_batch_id_fkey
  DEFERRABLE INITIALLY DEFERRED;

-- Restoring a dump can change FK trigger creation order. These redundant integrity checks must
-- wait for the existing conversation/group cascades to remove timeline entries and aliases.
ALTER TABLE telegram_group_messages
  ALTER CONSTRAINT telegram_group_messages_conversation_group_fk
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE telegram_group_message_ids
  ALTER CONSTRAINT telegram_group_message_ids_conversation_group_fk
  DEFERRABLE INITIALLY DEFERRED;

-- During family deletion a thread may still be waiting for its own cascade when a source is
-- deleted. Updating that doomed row rechecks its already-removed family FK. Live source changes
-- must still invalidate the brief and generation synchronously; only absent roots are skipped.
CREATE OR REPLACE FUNCTION invalidate_memory_threads_for_claim(claim_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[];
BEGIN
  SELECT array_agg(DISTINCT thread_id) INTO affected
  FROM memory_thread_entries WHERE source_claim_id = claim_id;
  IF affected IS NULL THEN RETURN; END IF;
  DELETE FROM memory_thread_briefs WHERE thread_id = ANY(affected);
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = ANY(affected)
    AND EXISTS (SELECT 1 FROM families WHERE id = thread.family_id)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
END
$$;

CREATE OR REPLACE FUNCTION invalidate_memory_threads_for_outcome(outcome_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[];
BEGIN
  SELECT array_agg(DISTINCT thread_id) INTO affected
  FROM memory_thread_entries WHERE source_outcome_id = outcome_id;
  IF affected IS NULL THEN RETURN; END IF;
  DELETE FROM memory_thread_briefs WHERE thread_id = ANY(affected);
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = ANY(affected)
    AND EXISTS (SELECT 1 FROM families WHERE id = thread.family_id)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
END
$$;

CREATE OR REPLACE FUNCTION invalidate_memory_thread_entry_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
BEGIN
  affected := CASE WHEN TG_OP = 'DELETE' THEN OLD.thread_id ELSE NEW.thread_id END;
  DELETE FROM memory_thread_briefs WHERE thread_id = affected;
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = affected
    AND EXISTS (SELECT 1 FROM families WHERE id = thread.family_id)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
