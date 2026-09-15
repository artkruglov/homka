-- Bot API 10.2 (14 июля 2026) отдаёт сообщения других ботов в группе, если у бота включён
-- Bot-to-Bot Communication Mode, он администратор и приватность в группах выключена.
-- Такое сообщение — обычная недоверенная запись ленты: участник виден, прав он не получает.
ALTER TABLE telegram_group_messages
  DROP CONSTRAINT telegram_group_messages_actor_kind,
  ADD CONSTRAINT telegram_group_messages_actor_kind
    CHECK (actor_kind IN ('agent_self', 'telegram_bot', 'telegram_channel', 'user')),
  ADD CONSTRAINT telegram_group_messages_bot_actor_shape CHECK (
    actor_kind <> 'telegram_bot' OR (
      telegram_user_id ~ '^[0-9]+$'
      AND actor_id = 'telegram-bot:' || telegram_user_id
      AND telegram_sender_chat_id IS NULL
      AND sender_is_bot = true
    )
  );

-- Ход, начатый сообщением другого бота, тоже связывает источники памяти: вид участника расширяем,
-- а форма идентификатора остаётся проверяемой.
ALTER TABLE memory_turn_source_sets
  DROP CONSTRAINT memory_turn_source_sets_actor_kind,
  ADD CONSTRAINT memory_turn_source_sets_actor_kind CHECK (
    invoking_actor_kind IN ('telegram_bot', 'telegram_channel', 'telegram_user')
  );

-- Сообщения бота проходят тихую проверку памяти наравне с сообщениями людей.
ALTER TABLE memory_extraction_snapshot_entries
  DROP CONSTRAINT IF EXISTS memory_extraction_snapshot_entries_actor_kind_check;
ALTER TABLE memory_extraction_snapshot_entries
  ADD CONSTRAINT memory_extraction_snapshot_entries_actor_kind_check
    CHECK (actor_kind IN ('user', 'telegram_bot', 'agent_self'));
