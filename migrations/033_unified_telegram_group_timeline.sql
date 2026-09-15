-- Evolve the existing journal in place: persisted rows and lazy attachment columns remain on the
-- same logical entries, while a group-owned counter becomes the durable ordering authority.
ALTER TABLE telegram_groups
  ADD COLUMN next_timeline_sequence bigint NOT NULL DEFAULT 0
    CHECK (next_timeline_sequence >= 0);

-- Scheduled delivery keeps Telegram routing separate from verified forum-topic isolation.
ALTER TABLE agent_schedules
  ADD COLUMN forum_topic_id bigint CHECK (forum_topic_id > 0);

ALTER TABLE reminders
  ADD COLUMN forum_topic_id bigint CHECK (forum_topic_id > 0);

-- Backfill only where durable Telegram ingress proves that the routing thread is a forum topic.
UPDATE agent_schedules AS schedule
SET forum_topic_id = schedule.message_thread_id
WHERE schedule.message_thread_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM telegram_ingress_updates ingress
    WHERE ingress.payload #>> '{message,chat,id}' = schedule.telegram_chat_id
      AND ingress.payload #>> '{message,message_thread_id}' = schedule.message_thread_id::text
      AND ingress.payload #>> '{message,is_topic_message}' = 'true'
  );

UPDATE reminders AS reminder
SET forum_topic_id = reminder.message_thread_id
WHERE reminder.message_thread_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM telegram_ingress_updates ingress
    WHERE ingress.payload #>> '{message,chat,id}' = reminder.telegram_chat_id
      AND ingress.payload #>> '{message,message_thread_id}' = reminder.message_thread_id::text
      AND ingress.payload #>> '{message,is_topic_message}' = 'true'
  );

ALTER TABLE telegram_group_messages
  ADD COLUMN sequence_id bigint,
  ADD COLUMN actor_kind text,
  ADD COLUMN actor_id text,
  ADD COLUMN reply_to_entry_id uuid REFERENCES telegram_group_messages(id) ON DELETE SET NULL,
  ADD COLUMN reply_to_sequence_id bigint CHECK (reply_to_sequence_id > 0);

WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY group_id ORDER BY sent_at, telegram_message_id, id
         ) AS sequence_id
  FROM telegram_group_messages
)
UPDATE telegram_group_messages AS message
SET sequence_id = numbered.sequence_id,
    actor_kind = CASE WHEN message.sender_is_bot THEN 'agent_self' ELSE 'user' END,
    actor_id = CASE
      WHEN message.sender_is_bot THEN 'agent:osinara'
      ELSE coalesce(
        'telegram:' || message.telegram_user_id,
        'telegram:legacy-message:' || message.telegram_message_id::text
      )
    END
FROM numbered
WHERE numbered.id = message.id;

UPDATE telegram_group_messages AS message
SET reply_to_entry_id = target.id,
    reply_to_sequence_id = target.sequence_id
FROM telegram_group_messages AS target
WHERE target.group_id = message.group_id
  AND target.telegram_message_id = message.reply_to_message_id;

UPDATE telegram_groups AS telegram_group
SET next_timeline_sequence = existing.maximum
FROM (
  SELECT group_id, max(sequence_id) AS maximum
  FROM telegram_group_messages
  GROUP BY group_id
) AS existing
WHERE telegram_group.id = existing.group_id;

ALTER TABLE telegram_group_messages
  ALTER COLUMN sequence_id SET NOT NULL,
  ALTER COLUMN actor_kind SET NOT NULL,
  ALTER COLUMN actor_id SET NOT NULL,
  ADD CONSTRAINT telegram_group_messages_sequence_positive CHECK (sequence_id > 0),
  ADD CONSTRAINT telegram_group_messages_actor_kind CHECK (actor_kind IN ('user', 'agent_self')),
  ADD CONSTRAINT telegram_group_messages_actor_id_nonempty CHECK (char_length(actor_id) > 0),
  ADD CONSTRAINT telegram_group_messages_group_sequence_unique UNIQUE (group_id, sequence_id);

-- Telegram transport IDs are aliases of a logical entry. Agent chunking therefore never creates
-- duplicate conversational entries, and replies to any chunk resolve through the same mapping.
CREATE TABLE telegram_group_message_ids (
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  entry_id uuid NOT NULL REFERENCES telegram_group_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, telegram_message_id)
);

INSERT INTO telegram_group_message_ids (group_id, telegram_message_id, entry_id)
SELECT group_id, telegram_message_id, id
FROM telegram_group_messages;

DROP INDEX telegram_group_messages_context;
DROP INDEX telegram_group_messages_retention;
CREATE INDEX telegram_group_messages_context
  ON telegram_group_messages (group_id, message_thread_id, sequence_id DESC);
CREATE INDEX telegram_group_messages_retention
  ON telegram_group_messages (group_id, sequence_id DESC);
