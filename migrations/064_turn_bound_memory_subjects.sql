-- Verified subject refs may authorize writes only in the exact Eve turn that received the view.
ALTER TABLE profile_views
  ADD COLUMN eve_session_id text,
  ADD COLUMN eve_turn_id text,
  ADD CONSTRAINT profile_views_eve_turn_shape CHECK (
    (eve_session_id IS NULL AND eve_turn_id IS NULL) OR
    (char_length(eve_session_id) > 0 AND char_length(eve_turn_id) > 0)
  );

CREATE INDEX profile_views_eve_turn
  ON profile_views (viewer_conversation_id, eve_session_id, eve_turn_id)
  WHERE eve_session_id IS NOT NULL;
