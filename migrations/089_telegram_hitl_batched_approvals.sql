-- Несколько запросов подтверждения одного шага показываются одним сообщением Telegram, поэтому
-- на одно сообщение приходится несколько строк: по одной на каждый Eve request_id.
-- Eve 0.40.0 собирает ответы шага только из одной доставки; ответы по одному теряются в
-- отложенном вводе, и припаркованный ход не возобновляется до следующего сообщения.
DO $$
DECLARE
  message_unique text;
BEGIN
  -- Имя автоматического ограничения усечено Postgres до 63 символов, поэтому ищем его по колонкам.
  SELECT con.conname INTO message_unique
    FROM pg_constraint con
   WHERE con.conrelid = 'telegram_hitl_approvals'::regclass
     AND con.contype = 'u'
     AND con.conkey = (
       SELECT array_agg(att.attnum ORDER BY att.attnum)
         FROM pg_attribute att
        WHERE att.attrelid = 'telegram_hitl_approvals'::regclass
          AND att.attname IN ('telegram_chat_id', 'telegram_message_id')
     );
  IF message_unique IS NOT NULL THEN
    EXECUTE format('ALTER TABLE telegram_hitl_approvals DROP CONSTRAINT %I', message_unique);
  END IF;
END
$$;

ALTER TABLE telegram_hitl_approvals
  ADD CONSTRAINT telegram_hitl_approvals_message_request_key
    UNIQUE (telegram_chat_id, telegram_message_id, request_id);
