-- Передача сообщения в другой чат по просьбе человека. Это не «бот пишет от себя»: у сообщения
-- есть автор, точный текст, подтверждённый им до отправки, и адресат, выбранный из его же чатов.
--
-- Строка заявки создаётся до отправки и живёт после неё: повтор того же вызова не отправляет
-- второе сообщение, а неясный исход остаётся неясным и не повторяется автоматически.
CREATE TABLE chat_message_relays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  space_id uuid,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'delivered', 'failed')),
  telegram_message_id text,
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (family_id, operation_key),
  CONSTRAINT chat_message_relays_outcome_shape CHECK (
    (status = 'started' AND telegram_message_id IS NULL AND completed_at IS NULL) OR
    (status = 'delivered' AND telegram_message_id IS NOT NULL AND completed_at IS NOT NULL) OR
    (status = 'failed' AND telegram_message_id IS NULL AND completed_at IS NOT NULL
      AND diagnostic_code IS NOT NULL)
  ),
  CONSTRAINT chat_message_relays_space_id_fkey FOREIGN KEY (space_id, family_id)
    REFERENCES spaces(id, family_id) ON DELETE SET NULL (space_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX chat_message_relays_space_id_idx ON chat_message_relays(space_id, family_id);
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON chat_message_relays
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();
