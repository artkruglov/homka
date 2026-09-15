-- The turn that asks for approval knows its conversation and the timeline entry of the message
-- that started it. The resumed turn after a button press rebuilt its auth from this table alone and
-- lost both, so manage_memory corrections and thread lifecycle failed with
-- AGENT_MEMORY_CORRECTION_SOURCE_INVALID after every approval. Keep them with the approval.
ALTER TABLE telegram_hitl_approvals
  ADD COLUMN telegram_conversation_id uuid,
  ADD COLUMN telegram_timeline_entry_id uuid;
