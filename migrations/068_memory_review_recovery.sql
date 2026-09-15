-- Memory-review recovery is bounded to one provably pre-handoff attempt. Terminal source sets remain
-- protected for operator repair, and owner alerts use a one-shot outbox with explicit ambiguity.
ALTER TABLE memory_review_batches
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0
    CHECK (recovery_attempts BETWEEN 0 AND 1),
  ADD COLUMN last_recovery_diagnostic_code text,
  ADD COLUMN last_recovered_at timestamptz,
  ADD CONSTRAINT memory_review_batches_recovery_audit CHECK (
    (recovery_attempts = 0 AND last_recovery_diagnostic_code IS NULL AND last_recovered_at IS NULL) OR
    (recovery_attempts = 1 AND last_recovery_diagnostic_code IS NOT NULL AND last_recovered_at IS NOT NULL)
  );

CREATE TYPE memory_review_owner_alert_status AS ENUM (
  'pending', 'delivering', 'delivered', 'failed', 'ambiguous'
);

CREATE TABLE memory_review_owner_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL UNIQUE REFERENCES memory_review_batches(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  group_title_snapshot text NOT NULL CHECK (char_length(group_title_snapshot) > 0),
  from_sequence bigint NOT NULL CHECK (from_sequence > 0),
  through_sequence bigint NOT NULL CHECK (through_sequence >= from_sequence),
  batch_diagnostic_code text NOT NULL CHECK (char_length(batch_diagnostic_code) > 0),
  status memory_review_owner_alert_status NOT NULL DEFAULT 'pending',
  delivery_token uuid,
  delivery_lease_expires_at timestamptz,
  delivery_diagnostic_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery_started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((delivery_token IS NULL) = (delivery_lease_expires_at IS NULL)),
  CHECK ((status = 'delivering') = (delivery_token IS NOT NULL)),
  CHECK ((status IN ('delivered', 'failed', 'ambiguous')) = (completed_at IS NOT NULL)),
  CHECK ((status IN ('failed', 'ambiguous')) = (delivery_diagnostic_code IS NOT NULL))
);

CREATE INDEX memory_review_owner_alerts_dispatch
  ON memory_review_owner_alerts (status, created_at)
  WHERE status IN ('pending', 'delivering');

-- This deployment repair is intentionally narrow: only the known session-failure classification,
-- a complete retained source range, and no durable memory operation from that Eve root are enough.
CREATE TEMP TABLE memory_review_recovery_candidates ON COMMIT DROP AS
SELECT batch.id AS batch_id,
       batch.application_session_id,
       batch.conversation_id,
       batch.diagnostic_code,
       batch.from_sequence,
       batch.through_sequence,
       lane.message_thread_id
  FROM memory_review_batches AS batch
  JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
 WHERE batch.batch_kind = 'background'
   AND batch.status = 'ambiguous'
   AND batch.diagnostic_code = 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS'
   AND batch.recovery_attempts = 0
   AND batch.application_session_id IS NOT NULL
   AND batch.eve_session_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM memory_mutation_operations AS operation
      WHERE operation.eve_session_id = batch.eve_session_id
   )
   AND (
     SELECT count(*)
       FROM telegram_group_messages AS message
      WHERE message.conversation_id = batch.conversation_id
        AND message.actor_kind = 'user'
        AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id
        AND message.sequence_id BETWEEN batch.from_sequence AND batch.through_sequence
   ) = batch.source_count
   AND EXISTS (
     SELECT 1 FROM telegram_group_messages AS message
      WHERE message.conversation_id = batch.conversation_id
        AND message.actor_kind = 'user'
        AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id
        AND message.sequence_id = batch.from_sequence
   )
   AND EXISTS (
     SELECT 1 FROM telegram_group_messages AS message
      WHERE message.conversation_id = batch.conversation_id
        AND message.actor_kind = 'user'
        AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id
        AND message.sequence_id = batch.through_sequence
   );

-- The previous Eve root cannot be resumed. Preserve it as retired audit history while freeing the
-- exact continuation token and one-shot batch link for a fresh application session.
DELETE FROM memory_turn_source_sets AS source_set
USING memory_review_recovery_candidates AS candidate
WHERE source_set.memory_review_batch_id = candidate.batch_id;

UPDATE conversation_sessions AS app_session
   SET continuation_token = 'retired-memory-review:' || app_session.id,
       memory_review_batch_id = NULL,
       pending_operation = false,
       task_state = 'failed',
       retired_at = coalesce(app_session.retired_at, now()),
       delete_after = coalesce(app_session.delete_after, now() + interval '90 days')
  FROM memory_review_recovery_candidates AS candidate
 WHERE app_session.id = candidate.application_session_id;

DELETE FROM memory_review_batch_sources AS source
USING memory_review_recovery_candidates AS candidate
WHERE source.batch_id = candidate.batch_id;

INSERT INTO memory_review_batch_sources
  (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
SELECT candidate.batch_id, candidate.conversation_id, message.id, message.sequence_id
  FROM memory_review_recovery_candidates AS candidate
  JOIN telegram_group_messages AS message
    ON message.conversation_id = candidate.conversation_id
   AND message.actor_kind = 'user'
   AND message.message_thread_id IS NOT DISTINCT FROM candidate.message_thread_id
   AND message.sequence_id BETWEEN candidate.from_sequence AND candidate.through_sequence;

UPDATE memory_review_batches AS batch
   SET status = 'pending',
       application_session_id = NULL,
       eve_session_id = NULL,
       eve_turn_id = NULL,
       lease_token = NULL,
       lease_expires_at = NULL,
       diagnostic_code = NULL,
       started_at = NULL,
       completed_at = NULL,
       recovery_attempts = 1,
       last_recovery_diagnostic_code = candidate.diagnostic_code,
       last_recovered_at = now(),
       updated_at = now()
  FROM memory_review_recovery_candidates AS candidate
 WHERE batch.id = candidate.batch_id;

INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT conversation.family_id,
       'memory_review.recovered',
       candidate.batch_id,
       jsonb_build_object(
         'diagnosticCode', candidate.diagnostic_code,
         'fromSequence', candidate.from_sequence,
         'throughSequence', candidate.through_sequence,
         'recoveryAttempt', 1,
         'retiredApplicationSessionId', candidate.application_session_id
       )
  FROM memory_review_recovery_candidates AS candidate
  JOIN application_conversations AS conversation ON conversation.id = candidate.conversation_id;
