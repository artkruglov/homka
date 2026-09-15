-- DeepSeek returned an explicit empty response before producing text or a tool call. Requeue only
-- the exact operator-inspected batch after proving that its failed Eve turn had no memory side effect.
DO $$
DECLARE
  incident_batch_id constant uuid := '287620e6-a391-40ff-bfc1-a0aeb628e819';
  failed_application_session_id constant uuid := 'e49ef485-3521-4df3-bc18-85f7efc62e91';
  failed_eve_session_id constant text := 'wrun_01M05TN1SQZJM2ZPKGVE50NHH3';
  recovery_diagnostic_code constant text := 'AGENT_MEMORY_REVIEW_EMPTY_MODEL_RESPONSE';
  incident memory_review_batches%ROWTYPE;
  review_conversation application_conversations%ROWTYPE;
  lane_cursor bigint;
  retained_count integer;
  retained_first bigint;
  retained_last bigint;
  alert_count integer;
BEGIN
  SELECT * INTO incident FROM memory_review_batches WHERE id = incident_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Every mutable field is pinned to the terminal empty-response event inspected by the operator.
  IF incident.batch_kind IS DISTINCT FROM 'background'
    OR incident.status IS DISTINCT FROM 'failed'
    OR incident.predecessor_sequence IS DISTINCT FROM 7659
    OR incident.from_sequence IS DISTINCT FROM 7660
    OR incident.through_sequence IS DISTINCT FROM 7709
    OR incident.source_count IS DISTINCT FROM 50
    OR incident.recovery_attempts IS DISTINCT FROM 0
    OR incident.last_recovery_diagnostic_code IS NOT NULL
    OR incident.last_recovered_at IS NOT NULL
    OR incident.diagnostic_code IS DISTINCT FROM 'MODEL_CALL_FAILED'
    OR incident.application_session_id IS DISTINCT FROM failed_application_session_id
    OR incident.eve_session_id IS DISTINCT FROM failed_eve_session_id
    OR incident.eve_turn_id IS DISTINCT FROM 'turn_0'
    OR incident.started_at IS NULL
    OR incident.completed_at IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_STATE_INVALID: Incident batch state changed';
  END IF;

  -- The unresolved batch must still be the exact head of its review lane and trust zone.
  SELECT processed_through_sequence INTO lane_cursor
    FROM memory_review_lanes WHERE id = incident.lane_id FOR UPDATE;
  IF lane_cursor IS DISTINCT FROM 7659 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_LANE_INVALID: Review lane advanced';
  END IF;
  SELECT * INTO STRICT review_conversation
    FROM application_conversations WHERE id = incident.conversation_id;

  -- Lock and validate the retired application root before detaching its batch continuation.
  PERFORM 1 FROM conversation_sessions
   WHERE id = failed_application_session_id
     AND generation = 0
     AND family_id = review_conversation.family_id
     AND group_id IS NOT DISTINCT FROM review_conversation.telegram_group_id
     AND owner_user_id IS NOT DISTINCT FROM review_conversation.owner_user_id
     AND scope = review_conversation.scope
     AND kind = 'proactive'
     AND task_state = 'failed'
     AND conversation_key = 'memory-review:' || incident_batch_id
     AND continuation_token = 'memory-review:' || incident_batch_id
     AND eve_session_id = failed_eve_session_id
     AND pending_operation = false
     AND memory_review_batch_id = incident_batch_id
     AND retired_at IS NOT NULL
     AND delete_after IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_SESSION_INVALID: Incident session changed';
  END IF;

  -- Any turn binding, mutation operation, or range evidence means the model crossed a side-effect
  -- boundary despite its empty terminal response, so replay must remain blocked.
  IF EXISTS (
    SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id
  ) OR EXISTS (
    SELECT 1 FROM memory_mutation_operations
     WHERE family_id = review_conversation.family_id
       AND eve_session_id = failed_eve_session_id
       AND eve_turn_id = 'turn_0'
  ) OR EXISTS (
    SELECT 1 FROM claim_evidence
     WHERE origin_conversation_id = incident.conversation_id
       AND timeline_sequence BETWEEN 7660 AND 7709
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_SIDE_EFFECT_FOUND: Recovery is not safe';
  END IF;

  -- Retained ownership must still contain the exact 50 user messages materialized for this batch.
  SELECT count(*)::integer, min(timeline_sequence), max(timeline_sequence)
    INTO retained_count, retained_first, retained_last
    FROM memory_review_batch_sources WHERE batch_id = incident_batch_id;
  IF retained_count <> 50 OR retained_first <> 7660 OR retained_last <> 7709 OR EXISTS (
    SELECT 1 FROM memory_review_batch_sources AS source
    JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
    WHERE source.batch_id = incident_batch_id
      AND (
        source.conversation_id IS DISTINCT FROM incident.conversation_id
        OR message.conversation_id IS DISTINCT FROM incident.conversation_id
        OR message.sequence_id IS DISTINCT FROM source.timeline_sequence
        OR message.actor_kind IS DISTINCT FROM 'user'
      )
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_SOURCES_INVALID: Source evidence changed';
  END IF;

  -- The delivered generation-zero warning remains immutable and proves the owner saw the failure.
  SELECT count(*)::integer INTO alert_count
    FROM memory_review_owner_alerts WHERE batch_id = incident_batch_id;
  IF alert_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM memory_review_owner_alerts
     WHERE batch_id = incident_batch_id AND recovery_generation = 0
       AND status = 'delivered' AND batch_diagnostic_code = 'MODEL_CALL_FAILED'
       AND from_sequence = 7660 AND through_sequence = 7709
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_ALERT_INVALID: Owner alert changed';
  END IF;

  -- Preserve the failed root as retired audit history and open a fresh background root for replay.
  UPDATE conversation_sessions
     SET continuation_token = 'retired-memory-review:' || id,
         memory_review_batch_id = NULL,
         pending_operation = false
   WHERE id = failed_application_session_id;

  UPDATE memory_review_batches
     SET status = 'pending', application_session_id = NULL, eve_session_id = NULL,
         eve_turn_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         diagnostic_code = NULL, started_at = NULL, completed_at = NULL,
         recovery_attempts = 1,
         last_recovery_diagnostic_code = recovery_diagnostic_code,
         last_recovered_at = now(), updated_at = now()
   WHERE id = incident_batch_id;

  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  VALUES (
    review_conversation.family_id,
    'memory_review.operator_recovered',
    incident_batch_id,
    jsonb_build_object(
      'diagnosticCode', recovery_diagnostic_code,
      'fromSequence', 7660,
      'throughSequence', 7709,
      'recoveryAttempt', 1,
      'failedEveSessionId', failed_eve_session_id,
      'retiredApplicationSessionId', failed_application_session_id
    )
  );
END;
$$;
