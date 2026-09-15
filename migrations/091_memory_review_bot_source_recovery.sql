-- 4 сентября 2026, 21:17 UTC: первый фоновый батч с сообщениями другого бота (группа ботов,
-- сообщения 72–87, четыре из них от бота). Батч был собран уже с ботами, а привязка источников хода
-- (`bindReview`) всё ещё отбирала только людей: 9 против 13, ход упал с
-- AGENT_MEMORY_TURN_SOURCE_SET_INVALID, батч закрыт как failed, владелец получил оповещение.
-- Код привязки исправлен в этом же релизе; батч возвращается в очередь ровно так, как это делает
-- автоматический повтор, и только если он не сдвинулся с инспектированного состояния.
DO $$
DECLARE
  incident_batch_id constant uuid := '155545ea-dc31-4b73-8682-b9f313a20fe7';
  incident_lane_id constant uuid := '983c5e9b-7e5d-465b-8336-d7fd85efd3d9';
  recovery_diagnostic_code constant text := 'AGENT_MEMORY_REVIEW_BOT_SOURCE_BINDING_RECOVERY';
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
    OR incident.diagnostic_code IS DISTINCT FROM 'AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING'
    OR incident.recovery_attempts IS DISTINCT FROM 0
    OR incident.lease_token IS NOT NULL THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_BOT_SOURCE_RECOVERY_STATE_INVALID: Incident batch changed since inspection';
  END IF;
  SELECT processed_through_sequence INTO lane_cursor
    FROM memory_review_lanes WHERE id = incident_lane_id FOR UPDATE;
  IF lane_cursor IS DISTINCT FROM 71 THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_BOT_SOURCE_RECOVERY_LANE_INVALID: Review lane moved past the incident';
  END IF;
  -- A binding or a memory write would mean the failed turn did produce a side effect.
  IF EXISTS (SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = incident_batch_id)
    OR EXISTS (
      SELECT 1 FROM memory_mutation_operations
       WHERE eve_session_id IS NOT DISTINCT FROM incident.eve_session_id
    ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_REVIEW_BOT_SOURCE_RECOVERY_SIDE_EFFECT: Incident batch already wrote memory';
  END IF;

  UPDATE memory_review_batches
     SET status = 'pending',
         recovery_attempts = 1,
         last_recovery_diagnostic_code = recovery_diagnostic_code,
         last_recovered_at = now(),
         diagnostic_code = NULL,
         completed_at = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
   WHERE id = incident_batch_id;
END
$$;
