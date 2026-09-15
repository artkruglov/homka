-- Eve turn ids restart inside each framework session. Backfill the stable session component from
-- the application session before replacing the incorrect globally unique turn-only identities.
ALTER TABLE memory_extraction_batches
  ADD COLUMN batch_kind text,
  ADD COLUMN eve_session_id text CHECK (
    eve_session_id IS NULL OR char_length(eve_session_id) > 0
  );

UPDATE memory_extraction_batches AS batch
SET batch_kind = CASE
      WHEN batch.application_session_id IS NULL THEN 'catchup'
      ELSE 'turn'
    END,
    eve_session_id = session.eve_session_id
FROM conversation_sessions AS session
WHERE session.id = batch.application_session_id;

UPDATE memory_extraction_batches
SET batch_kind = 'catchup'
WHERE application_session_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM memory_extraction_batches
    WHERE batch_kind IS NULL OR (batch_kind = 'turn' AND eve_session_id IS NULL)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'AGENT_EVE_TURN_IDENTITY_BACKFILL_FAILED: Extraction batch has no verified Eve session';
  END IF;
END
$$;

ALTER TABLE memory_extraction_batches
  ALTER COLUMN batch_kind SET NOT NULL,
  ADD CONSTRAINT memory_extraction_batches_execution_shape CHECK (
    (batch_kind = 'turn' AND eve_session_id IS NOT NULL) OR
    (batch_kind = 'catchup' AND application_session_id IS NULL AND eve_session_id IS NULL)
  ),
  DROP CONSTRAINT memory_extraction_batches_conversation_id_turn_id_extractor_key;

CREATE UNIQUE INDEX memory_extraction_batches_turn_identity
  ON memory_extraction_batches
    (conversation_id, eve_session_id, turn_id, extractor_version, schema_version)
  WHERE batch_kind = 'turn';

CREATE UNIQUE INDEX memory_extraction_batches_catchup_identity
  ON memory_extraction_batches
    (conversation_id, turn_id, extractor_version, schema_version)
  WHERE batch_kind = 'catchup';

ALTER TABLE telegram_final_deliveries
  ADD COLUMN eve_session_id text CHECK (char_length(eve_session_id) > 0);

UPDATE telegram_final_deliveries AS delivery
SET eve_session_id = session.eve_session_id
FROM conversation_sessions AS session
WHERE session.id = delivery.application_session_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM telegram_final_deliveries WHERE eve_session_id IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'AGENT_EVE_TURN_IDENTITY_BACKFILL_FAILED: Telegram delivery has no verified Eve session';
  END IF;
END
$$;

ALTER TABLE telegram_final_deliveries
  ALTER COLUMN eve_session_id SET NOT NULL,
  DROP CONSTRAINT telegram_final_deliveries_eve_turn_id_key,
  ADD CONSTRAINT telegram_final_deliveries_eve_session_turn_key
    UNIQUE (eve_session_id, eve_turn_id);
