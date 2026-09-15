-- Migration 067 seeded review lanes from the unified timeline before background review was narrowed
-- to registered groups. One personal lane later accumulated enough messages for an unclaimable
-- background batch. Remove only the exact operator-inspected batch and both legacy personal lanes.
DO $$
DECLARE
  expected_family_id constant uuid := '13a6d926-5c7d-4dee-8b3b-a8d5762a760e';
  first_owner_id constant uuid := 'd09d5ffa-c516-4d38-bde5-28f6b63e193c';
  second_owner_id constant uuid := 'd7d05997-b2b5-4198-a60c-61e999b947c6';
  first_conversation_id constant uuid := 'dd1ac651-2842-4914-b429-a32e04fec7fe';
  second_conversation_id constant uuid := '3b36f261-619a-4ca3-a38d-14cce824be59';
  first_lane_id constant uuid := '5417e534-12cb-466b-b7d0-193c97337307';
  incident_lane_id constant uuid := 'b6ccb4e0-926b-43c8-8789-fdc8b0a274ad';
  incident_batch_id constant uuid := '173c6d02-b781-4515-9c1f-562c9b1ee415';
  expected_source_sequences constant bigint[] := ARRAY[
    87, 89, 91, 93, 95, 97, 99, 101, 102, 104, 106, 108, 110, 112, 114, 116, 118,
    120, 122, 123, 125, 127, 129, 131, 132, 133, 134, 136, 138, 140, 142, 144, 146,
    147, 149, 151, 153, 155, 157, 158, 159, 161, 163, 165, 166, 168, 170, 172, 174,
    176
  ]::bigint[];
  incident memory_review_batches%ROWTYPE;
  personal_lane_count integer;
  batch_count integer;
  retained_sequences bigint[];
  deleted_count integer;
BEGIN
  SELECT * INTO incident
    FROM memory_review_batches WHERE id = incident_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM memory_review_lanes WHERE id IN (first_lane_id, incident_lane_id)
    ) THEN
      RAISE EXCEPTION
        'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_PARTIAL_STATE: Incident batch is missing while a legacy lane remains';
    END IF;
    IF (
      EXISTS (SELECT 1 FROM families WHERE id = expected_family_id)
      OR EXISTS (SELECT 1 FROM users WHERE id IN (first_owner_id, second_owner_id))
      OR EXISTS (
        SELECT 1 FROM application_conversations
         WHERE id IN (first_conversation_id, second_conversation_id)
      )
    ) AND NOT (
      EXISTS (
        SELECT 1 FROM audit_events
         WHERE family_id = expected_family_id
           AND event_type = 'memory_review.personal_artifact_removed'
           AND subject_id = first_lane_id
           AND metadata->>'diagnosticCode' = 'AGENT_MEMORY_REVIEW_PERSONAL_LANE_INVALID'
           AND metadata->>'conversationId' = first_conversation_id::text
           AND metadata->>'processedThroughSequence' = '19'
      ) AND EXISTS (
        SELECT 1 FROM audit_events
         WHERE family_id = expected_family_id
           AND event_type = 'memory_review.personal_artifact_removed'
           AND subject_id = incident_lane_id
           AND metadata->>'diagnosticCode' = 'AGENT_MEMORY_REVIEW_PERSONAL_BATCH_INVALID'
           AND metadata->>'conversationId' = second_conversation_id::text
           AND metadata->>'processedThroughSequence' = '85'
           AND metadata->>'removedBatchId' = incident_batch_id::text
           AND metadata->>'sourceCount' = '50'
           AND metadata->>'throughSequence' = '176'
      )
    ) THEN
      RAISE EXCEPTION
        'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_ARTIFACTS_MISSING: Production identities exist without cleanup evidence';
    END IF;
    RETURN;
  END IF;

  PERFORM lane.id
    FROM memory_review_lanes AS lane
    JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
   WHERE lane.id IN (first_lane_id, incident_lane_id)
   ORDER BY lane.id
   FOR UPDATE OF lane, conversation;

  SELECT count(*)::integer INTO personal_lane_count
    FROM memory_review_lanes AS lane
    JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
   WHERE conversation.scope = 'personal';
  IF personal_lane_count <> 2 OR EXISTS (
    SELECT 1
      FROM memory_review_lanes AS lane
      JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
     WHERE conversation.scope = 'personal'
       AND lane.id NOT IN (first_lane_id, incident_lane_id)
  ) OR NOT EXISTS (
    SELECT 1
      FROM memory_review_lanes AS lane
      JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
     WHERE lane.id = first_lane_id
       AND lane.conversation_id = first_conversation_id
       AND lane.message_thread_id IS NULL
       AND lane.processed_through_sequence = 19
       AND conversation.family_id = expected_family_id
       AND conversation.owner_user_id = first_owner_id
       AND conversation.scope = 'personal'
       AND conversation.telegram_group_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1
      FROM memory_review_lanes AS lane
      JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
     WHERE lane.id = incident_lane_id
       AND lane.conversation_id = second_conversation_id
       AND lane.message_thread_id IS NULL
       AND lane.processed_through_sequence = 85
       AND conversation.family_id = expected_family_id
       AND conversation.owner_user_id = second_owner_id
       AND conversation.scope = 'personal'
       AND conversation.telegram_group_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_LANES_INVALID: Personal review lanes changed';
  END IF;

  SELECT count(*)::integer INTO batch_count
    FROM memory_review_batches WHERE lane_id IN (first_lane_id, incident_lane_id);
  IF batch_count <> 1
    OR incident.lane_id IS DISTINCT FROM incident_lane_id
    OR incident.conversation_id IS DISTINCT FROM second_conversation_id
    OR incident.batch_kind IS DISTINCT FROM 'background'
    OR incident.status IS DISTINCT FROM 'pending'
    OR incident.predecessor_sequence IS DISTINCT FROM 85
    OR incident.from_sequence IS DISTINCT FROM 87
    OR incident.through_sequence IS DISTINCT FROM 176
    OR incident.source_count IS DISTINCT FROM 50
    OR incident.application_session_id IS NOT NULL
    OR incident.eve_session_id IS NOT NULL
    OR incident.eve_turn_id IS NOT NULL
    OR incident.lease_token IS NOT NULL
    OR incident.lease_expires_at IS NOT NULL
    OR incident.diagnostic_code IS NOT NULL
    OR incident.started_at IS NOT NULL
    OR incident.completed_at IS NOT NULL
    OR incident.recovery_attempts IS DISTINCT FROM 0
    OR incident.last_recovery_diagnostic_code IS NOT NULL
    OR incident.last_recovered_at IS NOT NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_BATCH_INVALID: Incident batch changed';
  END IF;

  SELECT array_agg(timeline_sequence ORDER BY timeline_sequence)
    INTO retained_sequences
    FROM memory_review_batch_sources WHERE batch_id = incident_batch_id;
  IF retained_sequences IS DISTINCT FROM expected_source_sequences OR EXISTS (
    SELECT 1
      FROM memory_review_batch_sources AS source
      JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
     WHERE source.batch_id = incident_batch_id
       AND (
         source.conversation_id IS DISTINCT FROM second_conversation_id
         OR message.conversation_id IS DISTINCT FROM second_conversation_id
         OR message.group_id IS NOT NULL
         OR message.message_thread_id IS NOT NULL
         OR message.actor_kind IS DISTINCT FROM 'user'
         OR message.sequence_id IS DISTINCT FROM source.timeline_sequence
       )
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_SOURCES_INVALID: Incident sources changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM conversation_sessions WHERE memory_review_batch_id = incident_batch_id
  ) OR EXISTS (
    SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id
  ) OR EXISTS (
    SELECT 1 FROM memory_review_owner_alerts WHERE batch_id = incident_batch_id
  ) OR EXISTS (
    SELECT 1 FROM audit_events WHERE subject_id = incident_batch_id
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_EXECUTION_FOUND: Incident batch crossed an execution boundary';
  END IF;

  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  VALUES
    (expected_family_id, 'memory_review.personal_artifact_removed', first_lane_id,
     jsonb_build_object(
       'diagnosticCode', 'AGENT_MEMORY_REVIEW_PERSONAL_LANE_INVALID',
       'conversationId', first_conversation_id,
       'processedThroughSequence', 19
     )),
    (expected_family_id, 'memory_review.personal_artifact_removed', incident_lane_id,
     jsonb_build_object(
       'diagnosticCode', 'AGENT_MEMORY_REVIEW_PERSONAL_BATCH_INVALID',
       'conversationId', second_conversation_id,
       'processedThroughSequence', 85,
       'removedBatchId', incident_batch_id,
       'sourceCount', 50,
       'throughSequence', 176
     ));

  DELETE FROM memory_review_batches WHERE id = incident_batch_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> 1 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_DELETE_FAILED: Incident batch was not removed';
  END IF;
  DELETE FROM memory_review_lanes WHERE id IN (first_lane_id, incident_lane_id);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> 2 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_DELETE_FAILED: Legacy lanes were not removed';
  END IF;
END;
$$;
