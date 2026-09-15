ALTER TABLE telegram_groups
  ADD COLUMN skill_allowlist text[] NOT NULL DEFAULT '{}';

ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_skill_allowlist_safe CHECK (
    skill_allowlist <@ ARRAY['pohuy']::text[] AND
    cardinality(skill_allowlist) <= 1
  );
