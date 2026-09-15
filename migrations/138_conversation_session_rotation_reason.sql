-- Why a session was asked to rotate. The owner digest counted every rotation as a failure,
-- including a new context the person asked for. Rows rotated before this migration stay NULL.
ALTER TABLE conversation_sessions
  ADD COLUMN rotation_reason text
    CHECK (rotation_reason IN ('session_failed', 'history_unrecoverable', 'user_requested')),
  ADD CONSTRAINT conversation_sessions_rotation_reason_requested
    CHECK (rotation_reason IS NULL OR rotation_requested_at IS NOT NULL);
