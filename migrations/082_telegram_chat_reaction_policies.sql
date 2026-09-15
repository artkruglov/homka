-- Telegram accepts only the reactions a chat allows. The prompt must name the live set, so the
-- verified per-chat answer of getChat is cached here instead of being requested on every turn.
CREATE TABLE telegram_chat_reaction_policies (
  telegram_chat_id text PRIMARY KEY CHECK (char_length(telegram_chat_id) > 0),
  allows_all boolean NOT NULL,
  emoji text[] NOT NULL DEFAULT '{}'::text[],
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_chat_reaction_policies_shape CHECK (
    NOT allows_all OR cardinality(emoji) = 0
  )
);
