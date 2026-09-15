-- Бэклог улучшений: наблюдения агента о собственных сбоях и тяжёлых ходах, отдельно от памяти о людях.
-- Пункты только совещательные: ничего из них не запускается само, закрывает их владелец.
-- Повтор той же проблемы увеличивает счётчик, а не создаёт новую строку.

CREATE TABLE agent_improvement_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  category text NOT NULL CHECK (category IN ('tool_error', 'prompt', 'memory', 'workflow', 'other')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 400),
  priority text NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  recurrence_count integer NOT NULL DEFAULT 1 CHECK (recurrence_count >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT agent_improvement_items_closed_shape CHECK (
    (status = 'open' AND closed_at IS NULL) OR (status <> 'open' AND closed_at IS NOT NULL)
  )
);

-- One open row per family and fingerprint; a closed item may be reopened as a fresh row.
CREATE UNIQUE INDEX agent_improvement_items_open_fingerprint
  ON agent_improvement_items (family_id, fingerprint) WHERE status = 'open';
CREATE INDEX agent_improvement_items_family_status
  ON agent_improvement_items (family_id, status, last_seen_at DESC);
