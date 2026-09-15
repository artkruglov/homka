ALTER TABLE telegram_group_messages
  ADD COLUMN attachment_source_message_id bigint;

UPDATE telegram_group_messages
SET attachment_source_message_id = telegram_message_id
WHERE attachment_file_id IS NOT NULL;

ALTER TABLE telegram_group_messages
  ADD CONSTRAINT telegram_group_messages_attachment_source_shape CHECK (
    (attachment_file_id IS NULL AND attachment_source_message_id IS NULL) OR
    (attachment_file_id IS NOT NULL AND attachment_source_message_id > 0)
  );
