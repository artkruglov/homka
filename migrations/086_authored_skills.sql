-- Авторские навыки: агент пишет их сам из доступных инструментов, владелец публикует кнопкой.
-- Одна библиотека на семью; версии никогда не удаляются, откат создаёт новую версию.

CREATE TABLE authored_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  markdown text NOT NULL CHECK (char_length(markdown) BETWEEN 1 AND 8000),
  files jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(files) = 'object'),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE UNIQUE INDEX authored_skills_active_name
  ON authored_skills (family_id, name) WHERE status = 'active';
CREATE INDEX authored_skills_family_status ON authored_skills (family_id, status);

CREATE TABLE authored_skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES authored_skills(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  description text NOT NULL,
  markdown text NOT NULL,
  files jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note text NOT NULL CHECK (char_length(change_note) BETWEEN 1 AND 500),
  trial_summary text NOT NULL CHECK (char_length(trial_summary) BETWEEN 1 AND 1000),
  -- Один вызов инструмента создаёт ровно одну версию, даже если Eve повторит его после кнопки.
  operation_key text NOT NULL,
  eve_session_id text,
  eve_turn_id text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version),
  UNIQUE (family_id, operation_key)
);

CREATE TABLE authored_skill_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES authored_skills(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES application_conversations(id) ON DELETE SET NULL,
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('unknown', 'ok', 'failed')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  outcome_at timestamptz
);

CREATE INDEX authored_skill_usage_skill_loaded ON authored_skill_usage (skill_id, loaded_at DESC);
CREATE INDEX authored_skill_usage_conversation_loaded
  ON authored_skill_usage (conversation_id, loaded_at DESC) WHERE conversation_id IS NOT NULL;

-- Подсказка «предыдущая задача потребовала N шагов»: одна строка на разговор, живёт до следующего
-- хода или 24 часа. Модель предлагает навык только при наличии строки.
CREATE TABLE conversation_skill_hints (
  conversation_id uuid PRIMARY KEY REFERENCES application_conversations(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  step_count integer NOT NULL CHECK (step_count >= 1),
  tool_names text[] NOT NULL,
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
