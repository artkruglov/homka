-- The bundled local Workflow HTTP client timed out after 30 seconds while its original Eve handler
-- kept running. Requeue only the exact pre-model interactive incident after proving that neither it
-- nor the completed successor produced a durable memory mutation. The active chat session is not
-- rotated: the repaired batch becomes an isolated background review with 50 retained user sources.
DO $$
DECLARE
  incident_batch_id constant uuid := 'c0cdfedb-2631-44b8-be4f-f1eb0b03b46a';
  successor_batch_id constant uuid := '6e5cf73b-6375-41d9-8bf8-e627c28784c3';
  application_session_id constant uuid := 'bafe368d-04ec-4ec8-ab99-4a6803379f42';
  successor_eve_session_id constant text := 'wrun_01M04ST8SKEVWWK14WRSH1FPYG';
  recovery_diagnostic_code constant text := 'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_TRANSPORT_TIMEOUT';
  incident memory_review_batches%ROWTYPE;
  successor memory_review_batches%ROWTYPE;
  lane_cursor bigint;
  retained_count integer;
  retained_first bigint;
  retained_last bigint;
  candidate_count integer;
  candidate_first bigint;
  candidate_last bigint;
  alert_count integer;
BEGIN
  SELECT * INTO incident FROM memory_review_batches WHERE id = incident_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO successor FROM memory_review_batches WHERE id = successor_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SUCCESSOR_MISSING: Inspected successor batch is missing';
  END IF;

  -- Every incident field is pinned to the production evidence inspected by the operator.
  IF incident.batch_kind IS DISTINCT FROM 'interactive'
    OR incident.status IS DISTINCT FROM 'ambiguous'
    OR incident.predecessor_sequence IS DISTINCT FROM 7607
    OR incident.from_sequence IS DISTINCT FROM 7609
    OR incident.through_sequence IS DISTINCT FROM 7609
    OR incident.source_count IS DISTINCT FROM 1
    OR incident.application_session_id IS DISTINCT FROM application_session_id
    OR incident.eve_session_id IS NOT NULL
    OR incident.eve_turn_id IS NOT NULL
    OR incident.diagnostic_code
      IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS'
    OR incident.recovery_attempts IS DISTINCT FROM 0
    OR incident.last_recovery_diagnostic_code IS NOT NULL
    OR incident.last_recovered_at IS NOT NULL
    OR incident.started_at IS NULL
    OR incident.completed_at IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_STATE_INVALID: Incident batch state changed';
  END IF;

  -- The later turn reviewed 7610-7619 but made no memory mutation. It remains immutable audit history.
  IF successor.lane_id IS DISTINCT FROM incident.lane_id
    OR successor.conversation_id IS DISTINCT FROM incident.conversation_id
    OR successor.batch_kind IS DISTINCT FROM 'interactive'
    OR successor.status IS DISTINCT FROM 'completed'
    OR successor.predecessor_sequence IS DISTINCT FROM 7609
    OR successor.from_sequence IS DISTINCT FROM 7610
    OR successor.through_sequence IS DISTINCT FROM 7619
    OR successor.source_count IS DISTINCT FROM 10
    OR successor.application_session_id IS DISTINCT FROM application_session_id
    OR successor.eve_session_id IS DISTINCT FROM successor_eve_session_id
    OR successor.eve_turn_id IS DISTINCT FROM 'turn_0'
    OR successor.diagnostic_code IS NOT NULL
    OR successor.recovery_attempts IS DISTINCT FROM 0
    OR successor.completed_at IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SUCCESSOR_INVALID: Successor batch state changed';
  END IF;

  SELECT processed_through_sequence INTO lane_cursor
    FROM memory_review_lanes WHERE id = incident.lane_id FOR UPDATE;
  IF lane_cursor IS DISTINCT FROM 7607 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_LANE_INVALID: Review lane advanced';
  END IF;

  -- The incident referenced the live canonical chat but never bound a turn. Recovery must not rotate
  -- or otherwise mutate that session while it may continue serving ordinary Telegram messages.
  PERFORM 1 FROM conversation_sessions
   WHERE id = application_session_id AND kind = 'canonical' AND retired_at IS NULL
     AND memory_review_batch_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SESSION_INVALID: Canonical session changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id
  ) OR EXISTS (
    SELECT 1 FROM memory_mutation_operations
     WHERE family_id = (
             SELECT family_id FROM conversation_sessions WHERE id = application_session_id
           )
       AND eve_session_id = successor_eve_session_id
       AND eve_turn_id = successor.eve_turn_id
  ) OR EXISTS (
    SELECT 1 FROM claim_evidence
     WHERE origin_conversation_id = incident.conversation_id
       AND timeline_sequence BETWEEN 7609 AND 7619
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SIDE_EFFECT_FOUND: Recovery is not safe';
  END IF;

  SELECT count(*)::integer, min(timeline_sequence), max(timeline_sequence)
    INTO retained_count, retained_first, retained_last
    FROM memory_review_batch_sources WHERE batch_id = incident_batch_id;
  IF retained_count <> 1 OR retained_first <> 7609 OR retained_last <> 7609 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_RETAINED_SOURCE_INVALID: Incident source changed';
  END IF;
  SELECT count(*)::integer INTO alert_count
    FROM memory_review_owner_alerts
   WHERE batch_id = incident_batch_id AND recovery_generation = 0
     AND status = 'delivered'
     AND batch_diagnostic_code = 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS'
     AND from_sequence = 7609 AND through_sequence = 7609;
  IF alert_count <> 1 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_ALERT_INVALID: Incident alert changed';
  END IF;

  -- The exact first 50 retained user entries contain one agent response at sequence 7620, so the
  -- reviewed source set ends at 7659. Existing source ownership outside this incident aborts repair.
  PERFORM id FROM telegram_group_messages
   WHERE conversation_id = incident.conversation_id AND actor_kind = 'user'
     AND message_thread_id IS NULL AND sequence_id >= 7609
   ORDER BY sequence_id LIMIT 50 FOR SHARE;
  SELECT count(*)::integer, min(sequence_id), max(sequence_id)
    INTO candidate_count, candidate_first, candidate_last
    FROM (
      SELECT sequence_id FROM telegram_group_messages
       WHERE conversation_id = incident.conversation_id AND actor_kind = 'user'
         AND message_thread_id IS NULL AND sequence_id >= 7609
       ORDER BY sequence_id LIMIT 50
    ) AS candidate;
  IF candidate_count <> 50 OR candidate_first <> 7609 OR candidate_last <> 7659 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_CANDIDATES_INVALID: Exact source range changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memory_review_batch_sources AS source
    JOIN (
      SELECT id FROM telegram_group_messages
       WHERE conversation_id = incident.conversation_id AND actor_kind = 'user'
         AND message_thread_id IS NULL AND sequence_id >= 7609
       ORDER BY sequence_id LIMIT 50
    ) AS candidate ON candidate.id = source.timeline_entry_id
    WHERE source.batch_id <> incident_batch_id
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SOURCE_OWNED: Candidate source belongs to another batch';
  END IF;

  DELETE FROM memory_review_batch_sources WHERE batch_id = incident_batch_id;
  INSERT INTO memory_review_batch_sources
    (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
  SELECT incident_batch_id, incident.conversation_id, id, sequence_id
    FROM telegram_group_messages
   WHERE conversation_id = incident.conversation_id AND actor_kind = 'user'
     AND message_thread_id IS NULL AND sequence_id >= 7609
   ORDER BY sequence_id LIMIT 50;

  UPDATE memory_review_batches
     SET batch_kind = 'background', status = 'pending', through_sequence = 7659,
         source_count = 50, application_session_id = NULL, eve_session_id = NULL,
         eve_turn_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         diagnostic_code = NULL, started_at = NULL, completed_at = NULL,
         recovery_attempts = 1, last_recovery_diagnostic_code = recovery_diagnostic_code,
         last_recovered_at = now(), updated_at = now()
   WHERE id = incident_batch_id;

  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  SELECT conversation.family_id, 'memory_review.operator_recovered', incident_batch_id,
         jsonb_build_object(
           'diagnosticCode', recovery_diagnostic_code,
           'fromSequence', 7609,
           'throughSequence', 7659,
           'recoveryAttempt', 1,
           'applicationSessionId', application_session_id,
           'completedSuccessorBatchId', successor_batch_id,
           'completedSuccessorEveSessionId', successor_eve_session_id
         )
    FROM application_conversations AS conversation
   WHERE conversation.id = incident.conversation_id;
END;
$$;
