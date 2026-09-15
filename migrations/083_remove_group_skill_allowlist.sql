-- Custom group skills were removed. Clear historical grants before tightening
-- the persisted policy so an old row cannot resurrect a removed package.
UPDATE telegram_groups
SET skill_allowlist = '{}'::text[]
WHERE cardinality(skill_allowlist) <> 0;

ALTER TABLE telegram_groups
  DROP CONSTRAINT telegram_groups_skill_allowlist_safe;

ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_skill_allowlist_safe CHECK (
    cardinality(skill_allowlist) = 0
  );
