-- Замкнутая петля авторских навыков (5 сентября 2026).
-- 1. Бэклог улучшений получает категорию skill: авторский навык, загруженный в упавшем или тяжёлом
--    ходе, записывается приложением без вызова модели.
-- 2. Подсказка следующего хода бывает двух видов: repeat (тяжёлый ход, как раньше) и backlog
--    (пункт workflow повторился второй раз); у backlog нет шагов и инструментов, только summary.

ALTER TABLE agent_improvement_items DROP CONSTRAINT agent_improvement_items_category_check;
ALTER TABLE agent_improvement_items ADD CONSTRAINT agent_improvement_items_category_check
  CHECK (category IN ('tool_error', 'prompt', 'memory', 'workflow', 'skill', 'other'));

ALTER TABLE conversation_skill_hints
  ADD COLUMN kind text NOT NULL DEFAULT 'repeat' CHECK (kind IN ('repeat', 'backlog')),
  ADD COLUMN summary text CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 400),
  ALTER COLUMN step_count DROP NOT NULL,
  ALTER COLUMN tool_names SET DEFAULT '{}'::text[],
  ADD CONSTRAINT conversation_skill_hints_kind_shape CHECK (
    (kind = 'repeat' AND step_count IS NOT NULL AND summary IS NULL)
    OR (kind = 'backlog' AND summary IS NOT NULL)
  );

-- 3. Владелец выдаёт авторский навык внешней группе. Навык не добавляет прав: при выдаче и при
--    каждой загрузке шаги навыка сверяются с allowlist группы. Смена типа группы пересоздаёт её
--    строку, и гранты уходят вместе с ней.
CREATE TABLE authored_skill_group_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES authored_skills(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  granted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, group_id)
);

CREATE INDEX authored_skill_group_grants_group ON authored_skill_group_grants (group_id);

-- 4. Эвалы навыка: сохранённые примеры «запрос → ожидаемый результат» (до пяти активных на навык)
--    и прогон каждого перед публикацией новой версии; прогоны хранятся вместе с версией.
CREATE TABLE authored_skill_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES authored_skills(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  request text NOT NULL CHECK (char_length(request) BETWEEN 1 AND 1000),
  expected text NOT NULL CHECK (char_length(expected) BETWEEN 1 AND 1000),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT authored_skill_examples_removed_shape CHECK (
    (active AND removed_at IS NULL) OR (NOT active AND removed_at IS NOT NULL)
  )
);

CREATE INDEX authored_skill_examples_skill_active
  ON authored_skill_examples (skill_id, created_at) WHERE active;

ALTER TABLE authored_skill_versions
  ADD COLUMN trials jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trials) = 'array');
