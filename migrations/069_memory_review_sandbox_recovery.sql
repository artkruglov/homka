-- Background review previously initialized a workspace sandbox before the model call even though
-- its tool surface denies every file capability. Preserve alert history by recovery generation,
-- then requeue only the exact twice-observed pre-model production incident authorized by operator.
ALTER TABLE memory_review_batches
  DROP CONSTRAINT memory_review_batches_recovery_attempts_check,
  DROP CONSTRAINT memory_review_batches_recovery_audit,
  ADD CONSTRAINT memory_review_batches_recovery_attempts_check
    CHECK (recovery_attempts BETWEEN 0 AND 2),
  ADD CONSTRAINT memory_review_batches_recovery_audit CHECK (
    (recovery_attempts = 0 AND last_recovery_diagnostic_code IS NULL
      AND last_recovered_at IS NULL) OR
    (recovery_attempts BETWEEN 1 AND 2 AND last_recovery_diagnostic_code IS NOT NULL
      AND last_recovered_at IS NOT NULL)
  );

ALTER TABLE memory_review_owner_alerts
  ADD COLUMN recovery_generation integer NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0);

UPDATE memory_review_owner_alerts AS alert
   SET recovery_generation = batch.recovery_attempts
  FROM memory_review_batches AS batch
 WHERE batch.id = alert.batch_id;

ALTER TABLE memory_review_owner_alerts
  DROP CONSTRAINT memory_review_owner_alerts_batch_id_key,
  ADD CONSTRAINT memory_review_owner_alerts_batch_generation_key
    UNIQUE (batch_id, recovery_generation);

DO $$
DECLARE
  incident_batch_id constant uuid := '18329b3e-9563-4762-bc77-11641e8cbac1';
  original_application_session_id constant uuid := '61b08325-2147-4047-9cb1-01d8210b89b4';
  recovery_application_session_id constant uuid := '26942f0e-76a7-4240-b241-ff866fc084b4';
  original_eve_session_id constant text := 'wrun_01KZWTTV5XAJY71V8DW3E7EM4X';
  recovery_eve_session_id constant text := 'wrun_01KZZN63ATNDJSP336AVRKE1XW';
  incident memory_review_batches%ROWTYPE;
  retained_count integer;
  retained_first bigint;
  retained_last bigint;
BEGIN
  SELECT * INTO incident FROM memory_review_batches WHERE id = incident_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Every durable identity must match the operator-inspected Eve traces before state is reopened.
  IF incident.batch_kind IS DISTINCT FROM 'background'
    OR incident.status IS DISTINCT FROM 'ambiguous'
    OR incident.predecessor_sequence IS DISTINCT FROM 5539
    OR incident.from_sequence IS DISTINCT FROM 5540
    OR incident.through_sequence IS DISTINCT FROM 5589
    OR incident.source_count IS DISTINCT FROM 50
    OR incident.recovery_attempts IS DISTINCT FROM 1
    OR incident.diagnostic_code
      IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS'
    OR incident.last_recovery_diagnostic_code
      IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS'
    OR incident.application_session_id IS DISTINCT FROM recovery_application_session_id
    OR incident.eve_session_id IS DISTINCT FROM recovery_eve_session_id
    OR incident.eve_turn_id IS DISTINCT FROM 'turn_0' THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SANDBOX_RECOVERY_STATE_INVALID: Incident batch state changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM conversation_sessions
     WHERE id = original_application_session_id AND eve_session_id = original_eve_session_id
       AND kind = 'proactive' AND task_state = 'failed' AND retired_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM conversation_sessions
     WHERE id = recovery_application_session_id AND eve_session_id = recovery_eve_session_id
       AND memory_review_batch_id = incident_batch_id
       AND kind = 'proactive' AND task_state = 'failed' AND retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SANDBOX_RECOVERY_SESSION_INVALID: Incident sessions changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM memory_mutation_operations
     WHERE eve_session_id IN (original_eve_session_id, recovery_eve_session_id)
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SANDBOX_RECOVERY_SIDE_EFFECT_FOUND: Recovery is not safe';
  END IF;

  SELECT count(*)::integer, min(timeline_sequence), max(timeline_sequence)
    INTO retained_count, retained_first, retained_last
    FROM memory_review_batch_sources WHERE batch_id = incident_batch_id;
  IF retained_count <> 50 OR retained_first <> 5540 OR retained_last <> 5589 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SANDBOX_RECOVERY_SOURCES_INVALID: Source evidence changed';
  END IF;

  -- The failed root remains retired audit history and can no longer own the batch continuation.
  DELETE FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id;
  UPDATE conversation_sessions
     SET continuation_token = 'retired-memory-review:' || id,
         memory_review_batch_id = NULL,
         pending_operation = false,
         task_state = 'failed',
         retired_at = coalesce(retired_at, now()),
         delete_after = coalesce(delete_after, now() + interval '90 days')
   WHERE id = recovery_application_session_id;

  UPDATE memory_review_batches
     SET status = 'pending', application_session_id = NULL, eve_session_id = NULL,
         eve_turn_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         diagnostic_code = NULL, started_at = NULL, completed_at = NULL,
         recovery_attempts = 2,
         last_recovery_diagnostic_code = 'AGENT_MEMORY_REVIEW_SANDBOX_CONTEXT_INVALID',
         last_recovered_at = now(), updated_at = now()
   WHERE id = incident_batch_id;

  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  SELECT conversation.family_id, 'memory_review.operator_recovered', incident_batch_id,
         jsonb_build_object(
           'diagnosticCode', 'AGENT_MEMORY_REVIEW_SANDBOX_CONTEXT_INVALID',
           'fromSequence', 5540,
           'throughSequence', 5589,
           'recoveryAttempt', 2,
           'originalEveSessionId', original_eve_session_id,
           'recoveryEveSessionId', recovery_eve_session_id,
           'retiredApplicationSessionId', recovery_application_session_id
         )
    FROM application_conversations AS conversation
   WHERE conversation.id = incident.conversation_id;
END;
$$;
