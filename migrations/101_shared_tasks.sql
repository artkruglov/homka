-- Task refs and participant refs are scoped opaque identifiers, never caller authority.
CREATE TABLE shared_task_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  display_name text NOT NULL,
  UNIQUE NULLS NOT DISTINCT (family_id, group_id, telegram_user_id)
);

CREATE TABLE shared_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  creator_telegram_id text NOT NULL,
  assignee_telegram_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1000),
  due_at timestamptz,
  status text NOT NULL CHECK (status IN ('proposed','accepted','completed','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope='group' AND group_id IS NOT NULL) OR (scope IN ('personal','family') AND group_id IS NULL)),
  CHECK (scope <> 'personal' OR creator_telegram_id = assignee_telegram_id)
);
CREATE INDEX shared_tasks_assignee ON shared_tasks(family_id, assignee_telegram_id, status, due_at);
CREATE INDEX shared_tasks_group ON shared_tasks(group_id, status);

CREATE TABLE shared_task_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  actor_telegram_id text NOT NULL,
  request_hash text NOT NULL,
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(family_id, operation_key)
);
