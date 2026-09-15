-- Replace scoped typed preferences with one editable operational prompt per exact Telegram chat.
ALTER TABLE behavior_preferences RENAME TO behavior_preferences_legacy_071;

ALTER TABLE telegram_group_messages
  ADD CONSTRAINT telegram_group_messages_preference_source_unique
  UNIQUE (id, conversation_id, sequence_id);

CREATE TABLE behavior_preferences (
  conversation_id uuid PRIMARY KEY REFERENCES application_conversations(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) <= 8000),
  revision integer NOT NULL CHECK (revision > 0),
  last_source_timeline_entry_id uuid,
  last_source_sequence bigint NOT NULL,
  last_updated_by_telegram_user_id text,
  last_operation_hash text NOT NULL CHECK (last_operation_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (last_source_sequence = -1 AND last_source_timeline_entry_id IS NULL
      AND last_updated_by_telegram_user_id IS NULL) OR
    (last_source_sequence >= 0 AND last_updated_by_telegram_user_id IS NOT NULL)
  ),
  FOREIGN KEY (last_source_timeline_entry_id, conversation_id, last_source_sequence)
    REFERENCES telegram_group_messages(id, conversation_id, sequence_id)
    ON DELETE SET NULL (last_source_timeline_entry_id)
);

-- Old rows are projected once into the chats where they previously applied, then rendered as one
-- plain prompt. This compatibility exists only in the migration; runtime has no typed preference path.
WITH projected AS (
  SELECT conversation.id AS conversation_id,
         legacy.preference,
         legacy.value,
         legacy.updated_at,
         CASE legacy.scope WHEN 'personal' THEN 3 WHEN 'group' THEN 2 ELSE 1 END AS priority
  FROM behavior_preferences_legacy_071 AS legacy
  JOIN application_conversations AS conversation
    ON conversation.family_id = legacy.family_id
   AND (
     (legacy.scope = 'personal' AND conversation.scope = 'personal'
       AND conversation.owner_user_id = legacy.owner_user_id) OR
     (legacy.scope = 'family' AND conversation.scope IN ('personal', 'family')) OR
     (legacy.scope = 'group' AND conversation.scope = 'group'
       AND conversation.telegram_group_id = legacy.group_id)
   )
), selected AS (
  SELECT *, row_number() OVER (
    PARTITION BY conversation_id, preference ORDER BY priority DESC, updated_at DESC
  ) AS precedence
  FROM projected
), rendered AS (
  SELECT conversation_id,
         string_agg(
           CASE
             WHEN preference = 'answer_structure' AND value = 'prose'
               THEN 'По умолчанию отвечай связным текстом; списки используй только для ясности.'
             WHEN preference = 'answer_structure' AND value = 'structured'
               THEN 'Структурируй содержательные ответы короткими разделами и списками.'
             WHEN preference = 'language' AND value = 'match_user'
               THEN 'Отвечай на языке последнего сообщения пользователя.'
             WHEN preference = 'language' AND value = 'russian'
               THEN 'Отвечай по-русски, если пользователь прямо не попросил другой язык.'
             WHEN preference = 'response_length' AND value = 'balanced'
               THEN 'Выбирай умеренную подробность без лишних отступлений.'
             WHEN preference = 'response_length' AND value = 'concise'
               THEN 'Отвечай кратко и переходи сразу к результату.'
             WHEN preference = 'response_length' AND value = 'detailed'
               THEN 'Для содержательных вопросов давай подробные объяснения и важные оговорки.'
             WHEN preference = 'status_updates' AND value = 'milestones'
               THEN 'Для долгих задач сообщай только о начале, важных этапах и результате.'
             WHEN preference = 'status_updates' AND value = 'minimal'
               THEN 'Не отправляй промежуточные статусы, кроме реальной задержки или блокировки.'
             WHEN preference = 'tone' AND value = 'formal'
               THEN 'Используй деловой и вежливый тон.'
             WHEN preference = 'tone' AND value = 'neutral'
               THEN 'Используй спокойный нейтральный тон.'
             WHEN preference = 'tone' AND value = 'warm'
               THEN 'Используй тёплый и доброжелательный тон без навязчивости.'
           END,
           E'\n' ORDER BY preference
         ) AS content,
         max(updated_at) AS updated_at
  FROM selected
  WHERE precedence = 1
  GROUP BY conversation_id
)
INSERT INTO behavior_preferences
  (conversation_id, content, revision, last_source_sequence, last_operation_hash, updated_at)
SELECT conversation_id, content, 1, -1,
       encode(digest(content, 'sha256'), 'hex'), updated_at
FROM rendered
WHERE content IS NOT NULL;

-- Unknown or unmapped old values must stop the migration instead of disappearing silently.
DO $$
DECLARE
  invalid_rows text;
  unmapped_rows text;
BEGIN
  SELECT string_agg(
           format(
             '[family_id=%s scope=%s owner_user_id=%s group_id=%s preference=%s value=%s]',
             legacy.family_id, legacy.scope, coalesce(legacy.owner_user_id::text, '<null>'),
             coalesce(legacy.group_id::text, '<null>'), legacy.preference, legacy.value
           ),
           ', ' ORDER BY legacy.family_id, legacy.scope, legacy.owner_user_id NULLS FIRST,
                          legacy.group_id NULLS FIRST, legacy.preference
         )
    INTO invalid_rows
    FROM behavior_preferences_legacy_071 AS legacy
    WHERE NOT (
      (legacy.preference = 'answer_structure' AND legacy.value IN ('prose', 'structured')) OR
      (legacy.preference = 'language' AND legacy.value IN ('match_user', 'russian')) OR
      (legacy.preference = 'response_length' AND legacy.value IN ('balanced', 'concise', 'detailed')) OR
      (legacy.preference = 'status_updates' AND legacy.value IN ('milestones', 'minimal')) OR
      (legacy.preference = 'tone' AND legacy.value IN ('formal', 'neutral', 'warm'))
    );
  IF invalid_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'AGENT_BEHAVIOR_PREFERENCE_MIGRATION_UNMAPPED: invalid legacy rows: %', invalid_rows;
  END IF;

  SELECT string_agg(
           format(
             '[family_id=%s scope=%s owner_user_id=%s group_id=%s preference=%s value=%s]',
             legacy.family_id, legacy.scope, coalesce(legacy.owner_user_id::text, '<null>'),
             coalesce(legacy.group_id::text, '<null>'), legacy.preference, legacy.value
           ),
           ', ' ORDER BY legacy.family_id, legacy.scope, legacy.owner_user_id NULLS FIRST,
                          legacy.group_id NULLS FIRST, legacy.preference
         )
    INTO unmapped_rows
    FROM behavior_preferences_legacy_071 AS legacy
    WHERE NOT EXISTS (
      SELECT 1 FROM application_conversations AS conversation
      WHERE conversation.family_id = legacy.family_id
        AND (
          (legacy.scope = 'personal' AND conversation.scope = 'personal'
            AND conversation.owner_user_id = legacy.owner_user_id) OR
          (legacy.scope = 'family' AND conversation.scope IN ('personal', 'family')) OR
          (legacy.scope = 'group' AND conversation.scope = 'group'
            AND conversation.telegram_group_id = legacy.group_id)
        )
    );
  IF unmapped_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'AGENT_BEHAVIOR_PREFERENCE_MIGRATION_UNMAPPED: legacy rows have no target conversation: %',
      unmapped_rows;
  END IF;
END
$$;

DROP TABLE behavior_preferences_legacy_071;
