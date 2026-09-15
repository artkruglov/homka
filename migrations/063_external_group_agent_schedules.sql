-- Telegram chat type is learned only from a verified update; owner-entered IDs cannot define it.
ALTER TABLE telegram_groups
  ADD COLUMN telegram_chat_type text
  CHECK (telegram_chat_type IS NULL OR telegram_chat_type IN ('group', 'supergroup'));

ALTER TABLE agent_schedules
  ADD COLUMN history_window_days smallint
    CHECK (history_window_days IS NULL OR history_window_days BETWEEN 1 AND 365),
  ADD COLUMN tool_allowlist text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE agent_schedules
  DROP CONSTRAINT agent_schedules_check,
  ADD CONSTRAINT agent_schedules_scope_shape CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL
      AND message_thread_id IS NULL AND history_window_days IS NULL
      AND cardinality(tool_allowlist) = 0) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NOT NULL
      AND history_window_days IS NULL AND cardinality(tool_allowlist) = 0) OR
    (scope = 'group' AND owner_user_id IS NULL AND group_id IS NOT NULL
      AND message_thread_id IS NULL AND forum_topic_id IS NULL)
  );

ALTER TABLE proactive_deliveries
  DROP CONSTRAINT proactive_deliveries_check,
  ADD CONSTRAINT proactive_deliveries_scope_shape CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL
      AND message_thread_id IS NULL) OR
    (scope IN ('family', 'group') AND owner_user_id IS NULL AND group_id IS NOT NULL) AND
      (scope <> 'group' OR message_thread_id IS NULL)
  );

CREATE INDEX proactive_deliveries_group_context_idx
  ON proactive_deliveries (family_id, group_id, telegram_chat_id, id DESC)
  WHERE scope = 'group';

-- A run snapshot is model-inaccessible durable state; only the run-bound reader projects chunks.
CREATE TABLE agent_schedule_history_snapshots (
  run_id uuid PRIMARY KEY REFERENCES agent_schedule_runs(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 0 AND 1000),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_start < window_end),
  CHECK ((entry_count = 0) = (chunk_count = 0))
);

CREATE TABLE agent_schedule_history_chunks (
  run_id uuid NOT NULL REFERENCES agent_schedule_history_snapshots(run_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  cursor_token uuid NOT NULL DEFAULT gen_random_uuid(),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) > 0),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, cursor_token)
);
