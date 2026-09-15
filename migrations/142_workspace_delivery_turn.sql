-- One file could reach a chat twice in one turn: generate_image delivers what it draws as a photo,
-- and a follow-up send_workspace_file of the same bytes went out again as a document. Exactly-once
-- is keyed on the tool call id, and two calls have two ids (upstream 61363db and 4eca2c9,
-- migrations 102/104). The turn is the scope for "already sent": a repeat inside one turn is always
-- a mistake, while a later request to send the same file again is legitimate. Backend deliveries
-- without a turn (video completion) keep NULL and plain exact-once semantics.
ALTER TABLE workspace_file_deliveries
  ADD COLUMN IF NOT EXISTS turn_id text;

-- In-flight sends are part of the lookup, so a parallel call sees a started delivery as ambiguous
-- instead of sending the same bytes again. The repository serializes the check with an advisory lock.
CREATE INDEX IF NOT EXISTS workspace_file_deliveries_turn_content_idx
  ON workspace_file_deliveries
    (telegram_chat_id, turn_id, content_sha256, telegram_message_thread_id)
  WHERE turn_id IS NOT NULL AND status IN ('started', 'completed');
