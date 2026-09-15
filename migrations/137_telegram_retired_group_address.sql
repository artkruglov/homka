-- Retired transport addresses cannot be registered again, including after trust-zone replacement.
ALTER TABLE telegram_group_migrations
  DROP CONSTRAINT telegram_group_migrations_family_id_group_id_fkey,
  ALTER COLUMN group_id DROP NOT NULL,
  ADD FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (family_id,group_id) REFERENCES telegram_groups(family_id,id)
    ON DELETE SET NULL (group_id);

CREATE FUNCTION reject_retired_telegram_group_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM telegram_group_migrations WHERE old_chat_id=NEW.telegram_chat_id) THEN
    RAISE EXCEPTION 'AGENT_TELEGRAM_GROUP_ADDRESS_RETIRED: Чат перенесён в супергруппу. Используйте её текущий адрес.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telegram_group_retired_address_guard
BEFORE INSERT OR UPDATE OF telegram_chat_id ON telegram_groups
FOR EACH ROW EXECUTE FUNCTION reject_retired_telegram_group_address();
