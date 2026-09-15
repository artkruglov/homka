-- Memory review uses the existing Telegram timeline as its source of truth. New rows store only
-- durable lane progress, execution state, and protected references to the exact reviewed sources.
CREATE TYPE memory_review_batch_kind AS ENUM ('background', 'interactive');
CREATE TYPE memory_review_batch_status AS ENUM (
  'pending', 'leased', 'dispatching', 'running', 'completed', 'failed', 'ambiguous'
);

CREATE TABLE memory_review_lanes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  message_thread_id bigint CHECK (message_thread_id > 0),
  processed_through_sequence bigint NOT NULL CHECK (processed_through_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (conversation_id, message_thread_id)
);

-- Deployment starts at the existing high-water mark. Only messages arriving after this migration
-- enter the new review lifecycle; the retired provider-extraction records are not reactivated.
INSERT INTO memory_review_lanes
  (conversation_id, message_thread_id, processed_through_sequence)
SELECT conversation_id, message_thread_id, max(sequence_id)
FROM telegram_group_messages
WHERE actor_kind = 'user'
GROUP BY conversation_id, message_thread_id;

CREATE TABLE memory_review_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_id uuid NOT NULL REFERENCES memory_review_lanes(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  batch_kind memory_review_batch_kind NOT NULL,
  status memory_review_batch_status NOT NULL,
  predecessor_sequence bigint NOT NULL CHECK (predecessor_sequence >= 0),
  from_sequence bigint NOT NULL CHECK (from_sequence > predecessor_sequence),
  through_sequence bigint NOT NULL CHECK (through_sequence >= from_sequence),
  source_count integer NOT NULL CHECK (source_count BETWEEN 1 AND 50),
  application_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  eve_session_id text CHECK (eve_session_id IS NULL OR char_length(eve_session_id) > 0),
  eve_turn_id text CHECK (eve_turn_id IS NULL OR char_length(eve_turn_id) > 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  diagnostic_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, conversation_id),
  UNIQUE (lane_id, predecessor_sequence),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (batch_kind <> 'background' OR source_count = 50),
  CHECK (batch_kind <> 'interactive' OR status IN ('completed', 'failed', 'ambiguous') OR
    application_session_id IS NOT NULL),
  CHECK ((status IN ('completed', 'failed', 'ambiguous')) = (completed_at IS NOT NULL)),
  CHECK ((eve_turn_id IS NULL) OR eve_session_id IS NOT NULL)
);

CREATE INDEX memory_review_batches_dispatch
  ON memory_review_batches (status, created_at)
  WHERE status IN ('pending', 'leased');
CREATE INDEX memory_review_batches_lane_progress
  ON memory_review_batches (lane_id, predecessor_sequence, through_sequence);
CREATE INDEX memory_review_batches_conversation
  ON memory_review_batches (conversation_id);
CREATE INDEX memory_review_batches_application_session
  ON memory_review_batches (application_session_id)
  WHERE application_session_id IS NOT NULL;
CREATE INDEX memory_review_batches_eve_session
  ON memory_review_batches (eve_session_id)
  WHERE eve_session_id IS NOT NULL;

CREATE TABLE memory_review_batch_sources (
  batch_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  timeline_entry_id uuid NOT NULL,
  timeline_sequence bigint NOT NULL CHECK (timeline_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, timeline_entry_id),
  UNIQUE (timeline_entry_id),
  UNIQUE (batch_id, timeline_sequence),
  FOREIGN KEY (batch_id, conversation_id)
    REFERENCES memory_review_batches(id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id)
);

CREATE INDEX memory_review_batch_sources_timeline_entry
  ON memory_review_batch_sources (timeline_entry_id, conversation_id);

-- Eve lifecycle classification stays on the existing one-shot `proactive` kind. This explicit FK
-- distinguishes memory review from every other noncanonical application session.
ALTER TABLE conversation_sessions
  ADD COLUMN memory_review_batch_id uuid
    REFERENCES memory_review_batches(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX conversation_sessions_memory_review_batch
  ON conversation_sessions (memory_review_batch_id)
  WHERE memory_review_batch_id IS NOT NULL;

-- A background turn has no invoking Telegram message. Its immutable source set is still bound to
-- one application session and one Eve turn, while every ordinary turn retains one current source.
ALTER TABLE memory_turn_source_sets
  ALTER COLUMN current_timeline_entry_id DROP NOT NULL,
  ADD COLUMN memory_review_batch_id uuid REFERENCES memory_review_batches(id) ON DELETE CASCADE,
  ADD CONSTRAINT memory_turn_source_sets_execution_shape CHECK (
    memory_review_batch_id IS NOT NULL OR current_timeline_entry_id IS NOT NULL
  );

CREATE UNIQUE INDEX memory_turn_source_sets_review_batch
  ON memory_turn_source_sets (memory_review_batch_id)
  WHERE memory_review_batch_id IS NOT NULL;

-- Background review has verifiable Eve provenance but intentionally no human mutation actor. Keep
-- the original all-or-none shape for human operations and add an explicit actorless system shape.
ALTER TABLE memory_mutation_operations
  DROP CONSTRAINT memory_operation_provenance_complete,
  ADD CONSTRAINT memory_operation_provenance_complete CHECK (
    (actor_user_id IS NULL AND actor_telegram_user_id IS NULL AND
      eve_session_id IS NULL AND eve_turn_id IS NULL) OR
    (actor_telegram_user_id IS NOT NULL AND eve_session_id IS NOT NULL AND eve_turn_id IS NOT NULL) OR
    (actor_user_id IS NULL AND actor_telegram_user_id IS NULL AND
      eve_session_id IS NOT NULL AND eve_turn_id IS NOT NULL)
  );
