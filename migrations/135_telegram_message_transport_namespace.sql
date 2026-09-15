-- Telegram message numbers are scoped to a transport chat, not a lasting conversation.
-- Keep historical source rows when a basic group becomes a supergroup.
ALTER TABLE telegram_group_messages ADD COLUMN telegram_chat_id text;
UPDATE telegram_group_messages m SET telegram_chat_id=c.telegram_chat_id
FROM application_conversations c WHERE c.id=m.conversation_id;
ALTER TABLE telegram_group_messages
  ALTER COLUMN telegram_chat_id SET NOT NULL,
  DROP CONSTRAINT telegram_group_messages_group_id_telegram_message_id_key,
  ADD CONSTRAINT telegram_group_messages_transport_message_unique
    UNIQUE (conversation_id, telegram_chat_id, telegram_message_id);

CREATE FUNCTION set_timeline_transport_chat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_chat text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id THEN
      RAISE EXCEPTION 'AGENT_TIMELINE_TRANSPORT_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  SELECT telegram_chat_id INTO current_chat FROM application_conversations WHERE id=NEW.conversation_id;
  IF current_chat IS NULL OR (NEW.telegram_chat_id IS NOT NULL AND NEW.telegram_chat_id<>current_chat) THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_TRANSPORT_MISMATCH';
  END IF;
  NEW.telegram_chat_id := current_chat;
  RETURN NEW;
END;
$$;
-- Existing conversation-resolver trigger runs first, including group-only inserts.
CREATE TRIGGER zz_timeline_transport_chat BEFORE INSERT OR UPDATE OF telegram_chat_id
ON telegram_group_messages FOR EACH ROW EXECUTE FUNCTION set_timeline_transport_chat();

ALTER TABLE telegram_group_message_ids ADD COLUMN telegram_chat_id text;
UPDATE telegram_group_message_ids a SET telegram_chat_id=m.telegram_chat_id
FROM telegram_group_messages m WHERE m.id=a.entry_id;
ALTER TABLE telegram_group_message_ids
  ALTER COLUMN telegram_chat_id SET NOT NULL,
  DROP CONSTRAINT telegram_group_message_ids_pkey,
  ADD PRIMARY KEY (conversation_id, telegram_chat_id, telegram_message_id);
DROP INDEX telegram_group_message_ids_group_alias;
CREATE UNIQUE INDEX telegram_group_message_ids_group_alias
ON telegram_group_message_ids (group_id, telegram_chat_id, telegram_message_id) WHERE group_id IS NOT NULL;
CREATE FUNCTION set_timeline_alias_transport_chat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_chat text;
BEGIN
  SELECT telegram_chat_id INTO source_chat FROM telegram_group_messages
  WHERE id=NEW.entry_id AND conversation_id=NEW.conversation_id;
  IF source_chat IS NULL OR (NEW.telegram_chat_id IS NOT NULL AND NEW.telegram_chat_id<>source_chat) THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_ALIAS_TRANSPORT_MISMATCH';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.entry_id IS DISTINCT FROM OLD.entry_id OR
      NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id) THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_ALIAS_TRANSPORT_IMMUTABLE';
  END IF;
  NEW.telegram_chat_id := source_chat;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_timeline_alias_transport_chat
BEFORE INSERT OR UPDATE OF telegram_chat_id, entry_id, conversation_id
ON telegram_group_message_ids FOR EACH ROW EXECUTE FUNCTION set_timeline_alias_transport_chat();
