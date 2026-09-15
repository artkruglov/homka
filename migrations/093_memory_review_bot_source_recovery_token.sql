-- Продолжение 092. Повтор батча 72–87 (группа ботов) упал на уникальном continuation_token:
-- закрытая сессия батча держит канонический токен `memory-review:<batch>`, а `prepare` вставляет
-- новую сессию с тем же токеном. Переименовываем токен закрытой сессии и возвращаем батч в
-- очередь, при тех же проверках, что и раньше: без привязок источников и без записей в память.
DO $$
DECLARE
  incident_batch_id constant uuid := '155545ea-dc31-4b73-8682-b9f313a20fe7';
  incident_lane_id constant uuid := '983c5e9b-7e5d-465b-8336-d7fd85efd3d9';
  canonical_token constant text := 'memory-review:155545ea-dc31-4b73-8682-b9f313a20fe7';
  recovery_diagnostic_code constant text := 'AGENT_MEMORY_REVIEW_BOT_SOURCE_TOKEN_RECOVERY';
  incident memory_review_batches%ROWTYPE;
  lane_cursor bigint;
BEGIN
  SELECT * INTO incident FROM memory_review_batches WHERE id = incident_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF incident.lane_id IS DISTINCT FROM incident_lane_id
    OR incident.batch_kind IS DISTINCT FROM 'background'
    OR incident.status IS DISTINCT FROM 'failed'
    OR incident.predecessor_sequence IS DISTINCT FROM 71
    OR incident.from_sequence IS DISTINCT FROM 72
    OR incident.through_sequence IS DISTINCT FROM 87
    OR incident.source_count IS DISTINCT FROM 13
    OR incident.diagnostic_code IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED'
    OR incident.lease_token IS NOT NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_BOT_SOURCE_TOKEN_RECOVERY_STATE_INVALID: Incident batch changed since inspection';
  END IF;
  SELECT processed_through_sequence INTO lane_cursor
    FROM memory_review_lanes WHERE id = incident_lane_id FOR UPDATE;
  IF lane_cursor IS DISTINCT FROM 71 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_BOT_SOURCE_TOKEN_RECOVERY_LANE_INVALID: Review lane moved past the incident';
  END IF;
  IF EXISTS (SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id)
    OR EXISTS (
      SELECT 1 FROM memory_mutation_operations AS operation
       WHERE operation.eve_session_id IN (
         SELECT eve_session_id FROM conversation_sessions
          WHERE (memory_review_batch_id = incident_batch_id OR continuation_token = canonical_token)
            AND eve_session_id IS NOT NULL
       )
    ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_BOT_SOURCE_TOKEN_RECOVERY_SIDE_EFFECT: Incident batch already wrote memory';
  END IF;

  -- The closed session keeps its history under a token that no new session will claim.
  UPDATE conversation_sessions
     SET continuation_token = canonical_token || ':retired:' || id::text,
         memory_review_batch_id = NULL
   WHERE continuation_token = canonical_token AND retired_at IS NOT NULL;

  UPDATE memory_review_batches
     SET status = 'pending',
         application_session_id = NULL,
         eve_session_id = NULL,
         eve_turn_id = NULL,
         last_recovery_diagnostic_code = recovery_diagnostic_code,
         last_recovered_at = now(),
         diagnostic_code = NULL,
         completed_at = NULL,
         started_at = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
   WHERE id = incident_batch_id;
END
$$;
