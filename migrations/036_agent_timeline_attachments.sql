ALTER TABLE telegram_group_messages
  DROP CONSTRAINT telegram_group_messages_attachment_shape;

ALTER TABLE telegram_group_messages
  ADD CONSTRAINT telegram_group_messages_attachment_shape CHECK (
    (
      attachment_kind IS NULL AND
      attachment_file_id IS NULL AND
      attachment_file_unique_id IS NULL AND
      attachment_file_name IS NULL AND
      attachment_media_type IS NULL AND
      attachment_size IS NULL
    ) OR (
      attachment_kind IN ('document', 'photo') AND
      (attachment_file_name IS NULL OR char_length(attachment_file_name) > 0) AND
      (attachment_media_type IS NULL OR char_length(attachment_media_type) > 0) AND
      (attachment_size IS NULL OR attachment_size > 0) AND
      (
        (
          attachment_file_id IS NOT NULL AND
          char_length(attachment_file_id) > 0 AND
          (attachment_file_unique_id IS NULL OR char_length(attachment_file_unique_id) > 0)
        ) OR (
          actor_kind = 'agent_self' AND
          attachment_file_id IS NULL AND
          attachment_file_unique_id IS NULL
        )
      )
    )
  );
