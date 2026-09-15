-- Telegram represents channel-authored supergroup posts as Channel_Bot plus sender_chat. Preserve
-- the visible channel as a distinct actor without manufacturing a human Telegram user identity.
ALTER TABLE telegram_group_messages
  ADD COLUMN telegram_sender_chat_id text;

ALTER TABLE telegram_group_messages
  DROP CONSTRAINT telegram_group_messages_actor_kind,
  ADD CONSTRAINT telegram_group_messages_actor_kind
    CHECK (actor_kind IN ('user', 'telegram_channel', 'agent_self')),
  ADD CONSTRAINT telegram_group_messages_channel_actor_shape CHECK (
    (
      actor_kind = 'telegram_channel'
      AND telegram_sender_chat_id ~ '^-[0-9]+$'
      AND telegram_user_id IS NULL
      AND sender_is_bot = false
      AND actor_id = 'telegram-channel:' || telegram_sender_chat_id
    ) OR (
      actor_kind <> 'telegram_channel'
      AND telegram_sender_chat_id IS NULL
    )
  );

-- Existing source sets belong to verified Telegram users. Generalize the immutable turn binding so
-- a channel-authored turn can prove its current timeline entry without reusing a user-only field.
ALTER TABLE memory_turn_source_sets
  RENAME COLUMN invoking_telegram_user_id TO invoking_actor_id;

ALTER TABLE memory_turn_source_sets
  ADD COLUMN invoking_actor_kind text;

UPDATE memory_turn_source_sets
   SET invoking_actor_kind = 'telegram_user';

ALTER TABLE memory_turn_source_sets
  ALTER COLUMN invoking_actor_kind SET NOT NULL,
  ADD CONSTRAINT memory_turn_source_sets_actor_kind CHECK (
    invoking_actor_kind IN ('telegram_user', 'telegram_channel')
  ),
  ADD CONSTRAINT memory_turn_source_sets_actor_shape CHECK (
    char_length(invoking_actor_id) > 0
    AND (
      invoking_actor_kind <> 'telegram_channel'
      OR invoking_actor_id ~ '^-[0-9]+$'
    )
  );
