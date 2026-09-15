-- Model-authored text that arrives before a tool call is a progress update for a person. Telegram
-- has no idempotency key, so this barrier records the intent once per assistant step and keeps a
-- replayed turn from sending the same notice twice.
CREATE TABLE telegram_progress_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eve_session_id text NOT NULL CHECK (char_length(eve_session_id) > 0),
  eve_turn_id text NOT NULL CHECK (char_length(eve_turn_id) > 0),
  step_index integer NOT NULL CHECK (step_index >= 0),
  application_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  telegram_message_id bigint CHECK (telegram_message_id IS NULL OR telegram_message_id > 0),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (eve_session_id, eve_turn_id, step_index),
  CONSTRAINT telegram_progress_notices_sent_shape CHECK (
    (telegram_message_id IS NULL AND sent_at IS NULL) OR
    (telegram_message_id IS NOT NULL AND sent_at IS NOT NULL)
  )
);

CREATE INDEX telegram_progress_notices_turn_idx
  ON telegram_progress_notices (eve_session_id, eve_turn_id);
