-- Permanent, scoped transport provenance. Source ingress may expire after reconciliation.
CREATE TABLE telegram_group_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  group_id uuid NOT NULL,
  old_chat_id text NOT NULL UNIQUE,
  new_chat_id text NOT NULL UNIQUE,
  source_update_id bigint NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, group_id) REFERENCES telegram_groups(family_id,id) ON DELETE CASCADE,
  CHECK (old_chat_id <> new_chat_id)
);
