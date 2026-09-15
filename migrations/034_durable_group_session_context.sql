-- A group session owns a monotonic cursor into the application timeline. Existing active group
-- sessions rotate on their next safe turn so no pre-migration ephemeral snapshot is mistaken for
-- durable history.
ALTER TABLE conversation_sessions
  ADD COLUMN group_timeline_cursor bigint CHECK (group_timeline_cursor > 0),
  ADD CONSTRAINT conversation_sessions_group_cursor_scope CHECK (
    group_timeline_cursor IS NULL OR group_id IS NOT NULL
  );

UPDATE conversation_sessions
SET rotation_requested_at = coalesce(rotation_requested_at, now())
WHERE group_id IS NOT NULL
  AND retired_at IS NULL;

-- Agent timeline entries identify their originating application session. Incremental context can
-- then exclude responses already present in that Eve session while retaining other branches.
ALTER TABLE telegram_group_messages
  ADD COLUMN application_session_id uuid
    REFERENCES conversation_sessions(id) ON DELETE SET NULL;

CREATE INDEX telegram_group_messages_application_session
  ON telegram_group_messages (application_session_id)
  WHERE application_session_id IS NOT NULL;
