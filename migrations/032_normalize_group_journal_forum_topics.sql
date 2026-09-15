-- Telegram may assign message_thread_id to an ordinary supergroup reply branch. Historical
-- journal rows are safe to normalize only when the original durable payload proves that Telegram
-- did not mark the message as a forum-topic message.
UPDATE telegram_group_messages AS journal
SET message_thread_id = NULL
FROM telegram_groups AS telegram_group
WHERE telegram_group.id = journal.group_id
  AND journal.message_thread_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM telegram_ingress_updates AS ingress
    WHERE ingress.payload #>> '{message,chat,id}' = telegram_group.telegram_chat_id
      AND ingress.payload #>> '{message,message_id}' = journal.telegram_message_id::text
      AND ingress.payload #>> '{message,is_topic_message}' IS DISTINCT FROM 'true'
  );
