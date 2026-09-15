ALTER TABLE telegram_group_messages
  ADD COLUMN attachment_file_id text,
  ADD COLUMN attachment_file_unique_id text,
  ADD COLUMN attachment_file_name text,
  ADD COLUMN attachment_media_type text,
  ADD COLUMN attachment_size bigint,
  ADD COLUMN attachment_kind text;

ALTER TABLE telegram_group_messages
  ADD CONSTRAINT telegram_group_messages_attachment_shape CHECK (
    (attachment_file_id IS NULL AND attachment_kind IS NULL) OR
    (
      attachment_file_id IS NOT NULL AND char_length(attachment_file_id) > 0 AND
      attachment_kind IN ('document', 'photo') AND
      (attachment_file_unique_id IS NULL OR char_length(attachment_file_unique_id) > 0) AND
      (attachment_file_name IS NULL OR char_length(attachment_file_name) > 0) AND
      (attachment_media_type IS NULL OR char_length(attachment_media_type) > 0) AND
      (attachment_size IS NULL OR attachment_size > 0)
    )
  );
