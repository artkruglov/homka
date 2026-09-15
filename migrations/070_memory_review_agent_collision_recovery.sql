-- Eve 0.32 exposed its implicit root delegation tool before applying the dynamic review denial,
-- causing a proven pre-model collision. Widen recovery by one audited generation, then requeue only
-- the exact side-effect-free production root authorized by the operator.
ALTER TABLE memory_review_batches
  DROP CONSTRAINT memory_review_batches_recovery_attempts_check,
  DROP CONSTRAINT memory_review_batches_recovery_audit,
  ADD CONSTRAINT memory_review_batches_recovery_attempts_check
    CHECK (recovery_attempts BETWEEN 0 AND 3),
  ADD CONSTRAINT memory_review_batches_recovery_audit CHECK (
    (recovery_attempts = 0 AND last_recovery_diagnostic_code IS NULL
      AND last_recovered_at IS NULL) OR
    (recovery_attempts BETWEEN 1 AND 3 AND last_recovery_diagnostic_code IS NOT NULL
      AND last_recovered_at IS NOT NULL)
  );

DO $$
DECLARE
  incident_batch_id constant uuid := '18329b3e-9563-4762-bc77-11641e8cbac1';
  original_application_session_id constant uuid := '61b08325-2147-4047-9cb1-01d8210b89b4';
  sandbox_application_session_id constant uuid := '26942f0e-76a7-4240-b241-ff866fc084b4';
  collision_application_session_id constant uuid := 'ced56a9b-e788-41e5-82fb-ac46e8b20168';
  original_eve_session_id constant text := 'wrun_01KZWTTV5XAJY71V8DW3E7EM4X';
  sandbox_eve_session_id constant text := 'wrun_01KZZN63ATNDJSP336AVRKE1XW';
  collision_eve_session_id constant text := 'wrun_01KZZW3MVCRG9D57A0TWQ06M8D';
  recovery_diagnostic_code constant text := 'AGENT_MEMORY_REVIEW_IMPLICIT_AGENT_COLLISION';
  incident memory_review_batches%ROWTYPE;
  retained_count integer;
  retained_first bigint;
  retained_last bigint;
  alert_count integer;
  alert_first_generation integer;
  alert_last_generation integer;
  bound_count integer;
  bound_first bigint;
  bound_last bigint;
  locked_session_count integer;
  lane_cursor bigint;
  review_conversation application_conversations%ROWTYPE;
BEGIN
  SELECT * INTO incident FROM memory_review_batches WHERE id = incident_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Every mutable batch field must still match the inspected third pre-model failure.
  IF incident.batch_kind IS DISTINCT FROM 'background'
    OR incident.status IS DISTINCT FROM 'ambiguous'
    OR incident.predecessor_sequence IS DISTINCT FROM 5539
    OR incident.from_sequence IS DISTINCT FROM 5540
    OR incident.through_sequence IS DISTINCT FROM 5589
    OR incident.source_count IS DISTINCT FROM 50
    OR incident.recovery_attempts IS DISTINCT FROM 2
    OR incident.diagnostic_code
      IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS'
    OR incident.last_recovery_diagnostic_code
      IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_SANDBOX_CONTEXT_INVALID'
    OR incident.application_session_id IS DISTINCT FROM collision_application_session_id
    OR incident.eve_session_id IS DISTINCT FROM collision_eve_session_id
    OR incident.eve_turn_id IS DISTINCT FROM 'turn_0'
    OR incident.started_at IS NULL
    OR incident.completed_at IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_STATE_INVALID: Incident batch state changed';
  END IF;

  -- The lane must not have advanced through an unresolved batch, and all three roots remain an
  -- immutable failure chain with only the newest session still linked to the batch.
  SELECT processed_through_sequence INTO lane_cursor
    FROM memory_review_lanes WHERE id = incident.lane_id FOR UPDATE;
  IF lane_cursor IS DISTINCT FROM 5539 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_LANE_INVALID: Review lane advanced';
  END IF;
  SELECT * INTO STRICT review_conversation
    FROM application_conversations WHERE id = incident.conversation_id;

  -- Lock the full session chain before checking trust-zone and lifecycle identity. Each recovery
  -- creates a fresh thread at generation zero while retaining the stable conversation key.
  PERFORM id FROM conversation_sessions
   WHERE id IN (
     original_application_session_id,
     sandbox_application_session_id,
     collision_application_session_id
   )
   ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS locked_session_count = ROW_COUNT;
  IF locked_session_count <> 3 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_SESSION_INVALID: Incident sessions missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM conversation_sessions
     WHERE id = original_application_session_id AND eve_session_id = original_eve_session_id
       AND continuation_token = 'retired-memory-review:' || original_application_session_id
       AND conversation_key = 'memory-review:' || incident_batch_id AND generation = 0
       AND family_id = review_conversation.family_id
       AND group_id IS NOT DISTINCT FROM review_conversation.telegram_group_id
       AND owner_user_id IS NOT DISTINCT FROM review_conversation.owner_user_id
       AND scope = review_conversation.scope AND pending_operation = false
       AND memory_review_batch_id IS NULL AND kind = 'proactive'
       AND task_state = 'failed' AND retired_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM conversation_sessions
     WHERE id = sandbox_application_session_id AND eve_session_id = sandbox_eve_session_id
       AND continuation_token = 'retired-memory-review:' || sandbox_application_session_id
       AND conversation_key = 'memory-review:' || incident_batch_id AND generation = 0
       AND family_id = review_conversation.family_id
       AND group_id IS NOT DISTINCT FROM review_conversation.telegram_group_id
       AND owner_user_id IS NOT DISTINCT FROM review_conversation.owner_user_id
       AND scope = review_conversation.scope AND pending_operation = false
       AND memory_review_batch_id IS NULL AND kind = 'proactive'
       AND task_state = 'failed' AND retired_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM conversation_sessions
     WHERE id = collision_application_session_id AND eve_session_id = collision_eve_session_id
       AND continuation_token = 'memory-review:' || incident_batch_id
       AND conversation_key = 'memory-review:' || incident_batch_id AND generation = 0
       AND family_id = review_conversation.family_id
       AND group_id IS NOT DISTINCT FROM review_conversation.telegram_group_id
       AND owner_user_id IS NOT DISTINCT FROM review_conversation.owner_user_id
       AND scope = review_conversation.scope AND pending_operation = false
       AND memory_review_batch_id = incident_batch_id AND kind = 'proactive'
       AND task_state = 'failed' AND retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_SESSION_INVALID: Incident sessions changed';
  END IF;

  -- Any durable memory mutation would make replay unsafe even if the model trace looked empty.
  IF EXISTS (
    SELECT 1 FROM memory_mutation_operations
     WHERE eve_session_id IN (
       original_eve_session_id,
       sandbox_eve_session_id,
       collision_eve_session_id
     )
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_SIDE_EFFECT_FOUND: Recovery is not safe';
  END IF;

  SELECT count(*)::integer, min(timeline_sequence), max(timeline_sequence)
    INTO retained_count, retained_first, retained_last
    FROM memory_review_batch_sources WHERE batch_id = incident_batch_id;
  IF retained_count <> 50 OR retained_first <> 5540 OR retained_last <> 5589 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_SOURCES_INVALID: Source evidence changed';
  END IF;

  -- The binding to be deleted must be the inspected collision turn and contain exactly the same
  -- immutable source IDs as the retained batch snapshot. No unrelated turn may be erased by repair.
  PERFORM 1 FROM memory_turn_source_sets
   WHERE memory_review_batch_id = incident_batch_id
     AND eve_session_id = collision_eve_session_id AND eve_turn_id = 'turn_0'
     AND application_session_id = collision_application_session_id
     AND conversation_id = incident.conversation_id AND current_timeline_entry_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_BINDING_INVALID: Turn binding changed';
  END IF;
  PERFORM 1 FROM memory_turn_sources
   WHERE eve_session_id = collision_eve_session_id AND eve_turn_id = 'turn_0'
   ORDER BY timeline_sequence FOR UPDATE;
  SELECT count(*)::integer, min(timeline_sequence), max(timeline_sequence)
    INTO bound_count, bound_first, bound_last
    FROM memory_turn_sources
   WHERE eve_session_id = collision_eve_session_id AND eve_turn_id = 'turn_0';
  IF bound_count <> 50 OR bound_first <> 5540 OR bound_last <> 5589 OR EXISTS (
    SELECT timeline_entry_id FROM memory_turn_sources
     WHERE eve_session_id = collision_eve_session_id AND eve_turn_id = 'turn_0'
    EXCEPT
    SELECT timeline_entry_id FROM memory_review_batch_sources
     WHERE batch_id = incident_batch_id
  ) OR EXISTS (
    SELECT timeline_entry_id FROM memory_review_batch_sources
     WHERE batch_id = incident_batch_id
    EXCEPT
    SELECT timeline_entry_id FROM memory_turn_sources
     WHERE eve_session_id = collision_eve_session_id AND eve_turn_id = 'turn_0'
  ) OR EXISTS (
    SELECT 1 FROM memory_turn_sources
     WHERE eve_session_id = collision_eve_session_id AND eve_turn_id = 'turn_0'
       AND is_current
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_BINDING_SOURCES_INVALID: Turn sources changed';
  END IF;

  -- Alert generations prove both earlier operator recoveries and remain untouched by this repair.
  SELECT count(*)::integer, min(recovery_generation), max(recovery_generation)
    INTO alert_count, alert_first_generation, alert_last_generation
    FROM memory_review_owner_alerts WHERE batch_id = incident_batch_id;
  IF alert_count <> 2 OR alert_first_generation <> 1 OR alert_last_generation <> 2 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_ALERTS_INVALID: Alert history changed';
  END IF;

  -- Retire the failed root and clear its turn binding before making the immutable batch claimable.
  DELETE FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id;
  UPDATE conversation_sessions
     SET continuation_token = 'retired-memory-review:' || id,
         memory_review_batch_id = NULL,
         pending_operation = false,
         task_state = 'failed',
         retired_at = coalesce(retired_at, now()),
         delete_after = coalesce(delete_after, now() + interval '90 days')
   WHERE id = collision_application_session_id;

  UPDATE memory_review_batches
     SET status = 'pending', application_session_id = NULL, eve_session_id = NULL,
         eve_turn_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         diagnostic_code = NULL, started_at = NULL, completed_at = NULL,
         recovery_attempts = 3,
         last_recovery_diagnostic_code = recovery_diagnostic_code,
         last_recovered_at = now(), updated_at = now()
   WHERE id = incident_batch_id;

  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  SELECT conversation.family_id, 'memory_review.operator_recovered', incident_batch_id,
         jsonb_build_object(
           'diagnosticCode', recovery_diagnostic_code,
           'fromSequence', 5540,
           'throughSequence', 5589,
           'recoveryAttempt', 3,
           'originalEveSessionId', original_eve_session_id,
           'sandboxEveSessionId', sandbox_eve_session_id,
           'collisionEveSessionId', collision_eve_session_id,
           'retiredApplicationSessionId', collision_application_session_id
         )
    FROM application_conversations AS conversation
   WHERE conversation.id = incident.conversation_id;
END;
$$;
