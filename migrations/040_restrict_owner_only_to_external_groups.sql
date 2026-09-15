-- PostgreSQL requires a newly added enum value to commit before another transaction may use it.
-- This database boundary prevents family trust zones from bypassing application validation.
ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_owner_only_external
  CHECK (
    message_mode <> 'owner_only' OR
    type IN ('external_private', 'external_public')
  );
