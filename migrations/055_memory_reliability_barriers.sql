-- Every newly accepted timeline row is retained until one immutable extraction snapshot owns it.
-- This hold is independent from the ordinary 1000-entry context retention policy.
CREATE TABLE memory_extraction_retention_holds (
  timeline_entry_id uuid PRIMARY KEY REFERENCES telegram_group_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  timeline_sequence bigint NOT NULL CHECK (timeline_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, timeline_sequence)
);

CREATE FUNCTION hold_timeline_entry_for_memory_extraction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO memory_extraction_retention_holds
    (timeline_entry_id, conversation_id, timeline_sequence)
  VALUES (NEW.id, NEW.conversation_id, NEW.sequence_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_group_messages_hold_for_memory_extraction
AFTER INSERT ON telegram_group_messages
FOR EACH ROW EXECUTE FUNCTION hold_timeline_entry_for_memory_extraction();

-- Existing retained entries receive the same protection unless the current extractor already owns
-- an immutable snapshot. Historical rows pruned before this migration are recorded as gaps below.
INSERT INTO memory_extraction_retention_holds
  (timeline_entry_id, conversation_id, timeline_sequence)
SELECT entry.id, entry.conversation_id, entry.sequence_id
FROM telegram_group_messages AS entry
WHERE NOT EXISTS (
  SELECT 1 FROM memory_extraction_entry_coverage AS coverage
  WHERE coverage.conversation_id = entry.conversation_id
    AND coverage.timeline_entry_id_snapshot = entry.id
    AND coverage.extractor_version = 'semantic-extractor-v1'
    AND coverage.schema_version = 'memory-candidate-v2'
);

-- Missing historical ranges are never silently treated as extracted. A gap is terminal evidence
-- that exact source text was already unavailable when catch-up inspected the conversation.
CREATE TABLE memory_extraction_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  first_sequence bigint NOT NULL CHECK (first_sequence > 0),
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  diagnostic_code text NOT NULL CHECK (diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, first_sequence, last_sequence),
  UNIQUE (id, conversation_id)
);

ALTER TABLE conversation_extraction_cursors
  ADD COLUMN last_contiguous_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_contiguous_sequence >= 0);

-- Candidate resolution is a durable local workflow. A crashed or poisoned candidate reaches an
-- explicit terminal state and cannot monopolize the oldest-pending scan forever.
ALTER TABLE memory_extraction_candidates
  DROP CONSTRAINT memory_extraction_candidates_resolution_status_check,
  DROP CONSTRAINT memory_extraction_candidate_resolution_shape,
  ALTER COLUMN content DROP NOT NULL,
  ADD COLUMN resolution_attempts integer NOT NULL DEFAULT 0 CHECK (resolution_attempts >= 0),
  ADD COLUMN resolution_lease_token uuid,
  ADD COLUMN resolution_lease_expires_at timestamptz,
  ADD COLUMN plaintext_erased_at timestamptz,
  ADD CONSTRAINT memory_extraction_candidates_resolution_status_check CHECK (
    resolution_status IN (
      'pending', 'resolution_processing', 'approval_pending', 'consolidation_pending',
      'claim_created', 'reinforced', 'duplicate', 'conflict', 'ambiguous', 'rejected',
      'resolution_failed'
    )
  ),
  ADD CONSTRAINT memory_extraction_candidate_resolution_shape CHECK (
    (resolution_status = 'resolution_processing' AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NULL AND resolved_at IS NULL
      AND resolution_lease_token IS NOT NULL AND resolution_lease_expires_at IS NOT NULL) OR
    (resolution_status IN ('pending', 'approval_pending', 'consolidation_pending')
      AND resolved_claim_id IS NULL AND resolution_diagnostic_code IS NULL AND resolved_at IS NULL
      AND resolution_lease_token IS NULL AND resolution_lease_expires_at IS NULL) OR
    (resolution_status IN ('claim_created', 'reinforced', 'duplicate', 'conflict')
      AND resolved_claim_id IS NOT NULL AND resolution_diagnostic_code IS NULL AND resolved_at IS NOT NULL
      AND resolution_lease_token IS NULL AND resolution_lease_expires_at IS NULL) OR
    (resolution_status = 'ambiguous' AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NULL AND resolved_at IS NOT NULL
      AND resolution_lease_token IS NULL AND resolution_lease_expires_at IS NULL) OR
    (resolution_status IN ('rejected', 'resolution_failed') AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_lease_token IS NULL AND resolution_lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT memory_extraction_candidate_plaintext_erasure_shape CHECK (
    plaintext_erased_at IS NULL OR content IS NULL
  );

CREATE INDEX memory_extraction_candidates_resolution_claim
  ON memory_extraction_candidates(resolution_status, created_at, id)
  WHERE resolution_status IN ('pending', 'resolution_processing');

-- R2's cleanup function predates the local resolution lease. Every state that can still need the
-- immutable plaintext must block whole-batch erasure, including terminal operator recovery.
CREATE OR REPLACE FUNCTION erase_terminal_memory_extraction_plaintext(affected_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memory_extraction_batches
    WHERE id = affected_batch_id AND status IN ('completed', 'completed_empty')
  ) OR EXISTS (
    SELECT 1 FROM memory_extraction_jobs
    WHERE batch_id = affected_batch_id AND status IN ('pending', 'leased')
  ) OR EXISTS (
    SELECT 1 FROM memory_extraction_candidates
    WHERE batch_id = affected_batch_id
      AND resolution_status IN (
        'pending', 'resolution_processing', 'approval_pending',
        'consolidation_pending', 'resolution_failed'
      )
  ) THEN
    RETURN;
  END IF;

  UPDATE memory_extraction_candidates
  SET content = NULL, content_erased_at = coalesce(content_erased_at, now()),
      plaintext_erased_at = coalesce(plaintext_erased_at, now())
  WHERE batch_id = affected_batch_id AND content IS NOT NULL;
  UPDATE memory_extraction_snapshot_entries
  SET content_text = NULL, erased_at = coalesce(erased_at, now())
  WHERE batch_id = affected_batch_id AND content_text IS NOT NULL;
  UPDATE memory_extraction_batches
  SET snapshot_erased_at = coalesce(snapshot_erased_at, now()), updated_at = now()
  WHERE id = affected_batch_id;
END
$$;

-- Approval context is claimed before dispatch and marked presented only by turn.started. An
-- interrupted pre-dispatch claim expires safely because no provider or user-visible side effect ran.
ALTER TABLE memory_extraction_approval_notices
  ADD COLUMN notice_claim_token uuid,
  ADD COLUMN notice_claim_expires_at timestamptz,
  ADD CONSTRAINT memory_extraction_approval_notice_claim_shape CHECK (
    (notice_claim_token IS NULL) = (notice_claim_expires_at IS NULL)
  );

-- Thread notices use an explicit send state instead of marking themselves presented before I/O.
ALTER TABLE memory_thread_creation_notices
  DROP CONSTRAINT memory_thread_creation_notices_status_check,
  DROP CONSTRAINT memory_thread_creation_notices_check,
  ADD COLUMN delivery_token uuid,
  ADD COLUMN delivery_diagnostic_code text CHECK (
    delivery_diagnostic_code IS NULL OR delivery_diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'
  ),
  ADD COLUMN delivery_started_at timestamptz,
  ADD CONSTRAINT memory_thread_creation_notices_status_check CHECK (
    status IN ('pending', 'started', 'presented', 'ambiguous', 'failed')
  ),
  ADD CONSTRAINT memory_thread_creation_notices_state_shape CHECK (
    (status = 'pending' AND presented_at IS NULL AND delivery_token IS NULL
      AND delivery_started_at IS NULL AND delivery_diagnostic_code IS NULL) OR
    (status = 'started' AND presented_at IS NULL AND delivery_token IS NOT NULL
      AND delivery_started_at IS NOT NULL AND delivery_diagnostic_code IS NULL) OR
    (status = 'presented' AND presented_at IS NOT NULL AND delivery_token IS NULL
      AND delivery_started_at IS NOT NULL AND delivery_diagnostic_code IS NULL) OR
    (status IN ('ambiguous', 'failed') AND presented_at IS NULL AND delivery_token IS NULL
      AND delivery_started_at IS NOT NULL AND delivery_diagnostic_code IS NOT NULL)
  );

-- Telegram has no idempotency key. This outbox records intent before the first native channel send;
-- a replay of a started delivery becomes ambiguous and must never send the output again.
CREATE TABLE telegram_final_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eve_turn_id text NOT NULL UNIQUE CHECK (char_length(eve_turn_id) > 0),
  application_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  output_hash text NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  expected_chunk_count integer NOT NULL CHECK (expected_chunk_count > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'started', 'delivered', 'ambiguous', 'failed')),
  delivery_token uuid,
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_final_deliveries_state_shape CHECK (
    (status = 'pending' AND delivery_token IS NULL AND started_at IS NULL
      AND completed_at IS NULL AND diagnostic_code IS NULL) OR
    (status = 'started' AND delivery_token IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NULL AND diagnostic_code IS NULL) OR
    (status = 'delivered' AND delivery_token IS NULL AND started_at IS NOT NULL
      AND completed_at IS NOT NULL AND diagnostic_code IS NULL) OR
    (status IN ('ambiguous', 'failed') AND delivery_token IS NULL AND started_at IS NOT NULL
      AND completed_at IS NOT NULL AND diagnostic_code IS NOT NULL)
  )
);

CREATE TABLE telegram_final_delivery_chunks (
  delivery_id uuid NOT NULL REFERENCES telegram_final_deliveries(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  telegram_chat_type text NOT NULL CHECK (
    telegram_chat_type IN ('private', 'group', 'supergroup', 'channel')
  ),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, ordinal),
  UNIQUE (delivery_id, telegram_message_id)
);

-- Thread briefs use the same terminal-attempt rule as extraction and discovery. The source records
-- remain authoritative; this table only checkpoints one generation/model/schema provider attempt.
CREATE TABLE memory_thread_brief_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES memory_threads(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  model_version text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 200),
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_call_started_at timestamptz,
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  output_payload_hash text CHECK (
    output_payload_hash IS NULL OR output_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT memory_thread_brief_jobs_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT memory_thread_brief_jobs_result_shape CHECK (
    (status IN ('pending', 'leased') AND completed_at IS NULL AND diagnostic_code IS NULL
      AND output_payload_hash IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND diagnostic_code IS NULL
      AND output_payload_hash IS NOT NULL) OR
    (status = 'failed' AND completed_at IS NOT NULL AND diagnostic_code IS NOT NULL
      AND output_payload_hash IS NULL)
  ),
  UNIQUE (thread_id, generation, model_version, schema_version)
);

CREATE INDEX memory_thread_brief_jobs_claim
  ON memory_thread_brief_jobs(status, created_at, id) WHERE status = 'pending';
