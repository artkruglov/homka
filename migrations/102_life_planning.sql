-- Additive planning metadata. Existing tasks and reminders retain their identity.
ALTER TABLE shared_tasks
  ADD COLUMN kind text NOT NULL DEFAULT 'task' CHECK (kind IN ('task','idea','ritual')),
  ADD COLUMN list_name text CHECK (char_length(list_name) BETWEEN 1 AND 100),
  ADD COLUMN details text CHECK (char_length(details) <= 4000),
  ADD COLUMN due_on date,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD CONSTRAINT shared_tasks_one_deadline CHECK (due_on IS NULL OR due_at IS NULL),
  ADD CONSTRAINT shared_tasks_ideas_without_deadline CHECK (kind='task' OR (due_on IS NULL AND due_at IS NULL));
CREATE TABLE shared_task_plans (
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  planned_from date NOT NULL,
  planned_until date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_until >= planned_from),
  PRIMARY KEY(task_id,telegram_user_id)
);
CREATE TABLE shared_task_versions (
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  version integer NOT NULL,
  actor_telegram_id text NOT NULL,
  action text NOT NULL,
  previous_record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,version)
);
CREATE TABLE shared_ritual_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  actor_telegram_id text NOT NULL,
  occurred_on date NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  UNIQUE(task_id,actor_telegram_id,occurred_on)
);
ALTER TABLE reminders ADD COLUMN shared_task_id uuid REFERENCES shared_tasks(id) ON DELETE CASCADE;
CREATE INDEX reminders_shared_task ON reminders(shared_task_id) WHERE shared_task_id IS NOT NULL;
