-- External Telegram visibility never changed application authorization. Replace both historical
-- labels in place so group identities and every foreign-key-owned row remain attached.
ALTER TABLE telegram_groups
  DROP CONSTRAINT telegram_groups_family_allowlist_empty,
  DROP CONSTRAINT telegram_groups_owner_only_external;

CREATE TYPE telegram_group_type_consolidated AS ENUM ('family_private', 'external');

ALTER TABLE telegram_groups
  ALTER COLUMN type TYPE telegram_group_type_consolidated
  USING (
    CASE type::text
      WHEN 'family_private' THEN 'family_private'
      WHEN 'external_private' THEN 'external'
      WHEN 'external_public' THEN 'external'
    END
  )::telegram_group_type_consolidated;

DROP TYPE telegram_group_type;
ALTER TYPE telegram_group_type_consolidated RENAME TO telegram_group_type;

-- Recreate the type-dependent invariants against the canonical two-value enum.
ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_family_allowlist_empty
    CHECK (type <> 'family_private' OR cardinality(tool_allowlist) = 0),
  ADD CONSTRAINT telegram_groups_owner_only_external
    CHECK (message_mode <> 'owner_only' OR type = 'external');
