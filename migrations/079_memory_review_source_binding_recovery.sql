-- Migration 075 made the verified Telegram actor kind mandatory, but the background review auth
-- omitted that actor identity. Eve therefore ran these two turns without durable source bindings,
-- while the old terminal path still marked both batches complete. Requeue only the exact inspected
-- side-effect-free chain and rebuild its retained source ownership from the immutable group journal.
DO $$
DECLARE
  first_batch_id constant uuid := '90619ff3-137e-423e-9615-4e436e3a52b1';
  second_batch_id constant uuid := 'e19dc521-5a31-4d2f-b6ea-2baa6639ee10';
  predecessor_batch_id constant uuid := 'f69985eb-eafd-472b-84f6-df87ae44ea3e';
  incident_lane_id constant uuid := '31da105f-108e-445f-b20d-be5154ecd11a';
  first_eve_session_id constant text := 'wrun_01M15ZW7PGDEHMF3VD5RRTW1W7';
  second_eve_session_id constant text := 'wrun_01M16T2VN126WQNZWJB2C0VRK2';
  recovery_diagnostic_code constant text := 'AGENT_MEMORY_REVIEW_SOURCE_BINDING_REGRESSION';
  first_batch memory_review_batches%ROWTYPE;
  second_batch memory_review_batches%ROWTYPE;
  predecessor_batch memory_review_batches%ROWTYPE;
  lane_cursor bigint;
  lane_thread_id bigint;
  lane_conversation_id uuid;
  incident_chain_count integer;
  all_message_count integer;
  candidate_count integer;
  candidate_first bigint;
  candidate_last bigint;
BEGIN
  SELECT * INTO first_batch
    FROM memory_review_batches WHERE id = first_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM memory_review_batches WHERE id = second_batch_id) THEN
      RAISE EXCEPTION
        'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_CHAIN_INVALID: First incident batch is missing';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO second_batch
    FROM memory_review_batches WHERE id = second_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_CHAIN_INVALID: Second incident batch is missing';
  END IF;
  SELECT * INTO predecessor_batch
    FROM memory_review_batches WHERE id = predecessor_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_PREDECESSOR_INVALID: Predecessor batch is missing';
  END IF;

  -- Every mutable field is pinned to the two false-success terminal events inspected in production.
  IF first_batch.lane_id IS DISTINCT FROM incident_lane_id
    OR first_batch.conversation_id IS DISTINCT FROM second_batch.conversation_id
    OR first_batch.batch_kind IS DISTINCT FROM 'background'
    OR first_batch.status IS DISTINCT FROM 'completed'
    OR first_batch.predecessor_sequence IS DISTINCT FROM 458
    OR first_batch.from_sequence IS DISTINCT FROM 459
    OR first_batch.through_sequence IS DISTINCT FROM 508
    OR first_batch.source_count IS DISTINCT FROM 50
    OR first_batch.application_session_id IS NOT NULL
    OR first_batch.eve_session_id IS DISTINCT FROM first_eve_session_id
    OR first_batch.eve_turn_id IS DISTINCT FROM 'turn_0'
    OR first_batch.diagnostic_code IS NOT NULL
    OR first_batch.recovery_attempts IS DISTINCT FROM 0
    OR first_batch.last_recovery_diagnostic_code IS NOT NULL
    OR first_batch.last_recovered_at IS NOT NULL
    OR first_batch.started_at IS NULL
    OR first_batch.completed_at IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_FIRST_STATE_INVALID: First incident batch changed';
  END IF;
  IF second_batch.lane_id IS DISTINCT FROM incident_lane_id
    OR second_batch.conversation_id IS DISTINCT FROM first_batch.conversation_id
    OR second_batch.batch_kind IS DISTINCT FROM 'background'
    OR second_batch.status IS DISTINCT FROM 'completed'
    OR second_batch.predecessor_sequence IS DISTINCT FROM 508
    OR second_batch.from_sequence IS DISTINCT FROM 509
    OR second_batch.through_sequence IS DISTINCT FROM 558
    OR second_batch.source_count IS DISTINCT FROM 50
    OR second_batch.application_session_id IS NOT NULL
    OR second_batch.eve_session_id IS DISTINCT FROM second_eve_session_id
    OR second_batch.eve_turn_id IS DISTINCT FROM 'turn_0'
    OR second_batch.diagnostic_code IS NOT NULL
    OR second_batch.recovery_attempts IS DISTINCT FROM 0
    OR second_batch.last_recovery_diagnostic_code IS NOT NULL
    OR second_batch.last_recovered_at IS NOT NULL
    OR second_batch.started_at IS NULL
    OR second_batch.completed_at IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_SECOND_STATE_INVALID: Second incident batch changed';
  END IF;

  -- The previous successful batch anchors the rewind point. A newly materialized successor means
  -- production moved since inspection and must be reviewed again instead of being rewritten here.
  IF predecessor_batch.lane_id IS DISTINCT FROM incident_lane_id
    OR predecessor_batch.conversation_id IS DISTINCT FROM first_batch.conversation_id
    OR predecessor_batch.batch_kind IS DISTINCT FROM 'background'
    OR predecessor_batch.status IS DISTINCT FROM 'completed'
    OR predecessor_batch.predecessor_sequence IS DISTINCT FROM 408
    OR predecessor_batch.from_sequence IS DISTINCT FROM 409
    OR predecessor_batch.through_sequence IS DISTINCT FROM 458
    OR predecessor_batch.source_count IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_PREDECESSOR_INVALID: Rewind anchor changed';
  END IF;
  SELECT processed_through_sequence, message_thread_id, conversation_id
    INTO lane_cursor, lane_thread_id, lane_conversation_id
    FROM memory_review_lanes WHERE id = incident_lane_id FOR UPDATE;
  IF lane_cursor IS DISTINCT FROM 558
    OR lane_thread_id IS NOT NULL
    OR lane_conversation_id IS DISTINCT FROM first_batch.conversation_id THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_LANE_INVALID: Review lane changed';
  END IF;
  SELECT count(*)::integer INTO incident_chain_count
    FROM memory_review_batches
   WHERE lane_id = incident_lane_id AND predecessor_sequence >= 458;
  IF incident_chain_count <> 2 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_CHAIN_INVALID: Review chain advanced';
  END IF;

  -- A binding, memory operation, evidence row, or owner alert would contradict the inspected failure
  -- and make replay unsafe. Keep the original Eve roots as immutable external audit provenance.
  IF EXISTS (
    SELECT 1 FROM memory_turn_source_sets
     WHERE memory_review_batch_id IN (first_batch_id, second_batch_id)
  ) OR EXISTS (
    SELECT 1 FROM memory_mutation_operations
     WHERE eve_session_id IN (first_eve_session_id, second_eve_session_id)
       AND eve_turn_id = 'turn_0'
  ) OR EXISTS (
    SELECT 1 FROM claim_evidence
     WHERE origin_conversation_id = first_batch.conversation_id
       AND timeline_sequence BETWEEN 459 AND 558
  ) OR EXISTS (
    SELECT 1 FROM memory_review_owner_alerts
     WHERE batch_id IN (first_batch_id, second_batch_id)
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_SIDE_EFFECT_FOUND: Recovery is not safe';
  END IF;

  -- Both terminal paths already released their batch-source rows. Recreate ownership only when the
  -- journal still contains exactly the inspected 100 user messages and none belongs to another batch.
  PERFORM id FROM telegram_group_messages
   WHERE conversation_id = first_batch.conversation_id
     AND sequence_id BETWEEN 459 AND 558
   ORDER BY sequence_id FOR SHARE;
  SELECT count(*)::integer INTO all_message_count
    FROM telegram_group_messages
   WHERE conversation_id = first_batch.conversation_id
     AND sequence_id BETWEEN 459 AND 558;
  SELECT count(*)::integer, min(sequence_id), max(sequence_id)
    INTO candidate_count, candidate_first, candidate_last
    FROM telegram_group_messages
   WHERE conversation_id = first_batch.conversation_id
     AND actor_kind = 'user' AND message_thread_id IS NULL
     AND sequence_id BETWEEN 459 AND 558;
  IF all_message_count <> 100 OR candidate_count <> 100
    OR candidate_first <> 459 OR candidate_last <> 558 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_SOURCES_INVALID: Journal source range changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memory_review_batch_sources AS source
    JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
    WHERE message.conversation_id = first_batch.conversation_id
      AND message.sequence_id BETWEEN 459 AND 558
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_SOURCE_OWNED: Journal source is already retained';
  END IF;

  UPDATE memory_review_lanes
     SET processed_through_sequence = 458, updated_at = now()
   WHERE id = incident_lane_id;
  INSERT INTO memory_review_batch_sources
    (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
  SELECT CASE WHEN message.sequence_id <= 508 THEN first_batch_id ELSE second_batch_id END,
         first_batch.conversation_id, message.id, message.sequence_id
    FROM telegram_group_messages AS message
   WHERE message.conversation_id = first_batch.conversation_id
     AND message.actor_kind = 'user' AND message.message_thread_id IS NULL
     AND message.sequence_id BETWEEN 459 AND 558;

  UPDATE memory_review_batches
     SET status = 'pending', application_session_id = NULL, eve_session_id = NULL,
         eve_turn_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         diagnostic_code = NULL, started_at = NULL, completed_at = NULL,
         recovery_attempts = 1, last_recovery_diagnostic_code = recovery_diagnostic_code,
         last_recovered_at = now(), updated_at = now()
   WHERE id IN (first_batch_id, second_batch_id);

  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  SELECT conversation.family_id, 'memory_review.operator_recovered', batch.id,
         jsonb_build_object(
           'diagnosticCode', recovery_diagnostic_code,
           'fromSequence', batch.from_sequence,
           'throughSequence', batch.through_sequence,
           'recoveryAttempt', 1,
           'originalEveSessionId', CASE
             WHEN batch.id = first_batch_id THEN first_eve_session_id
             ELSE second_eve_session_id
           END,
           'rewoundLaneSequence', 458
         )
    FROM memory_review_batches AS batch
    JOIN application_conversations AS conversation ON conversation.id = batch.conversation_id
   WHERE batch.id IN (first_batch_id, second_batch_id);
END;
$$;
