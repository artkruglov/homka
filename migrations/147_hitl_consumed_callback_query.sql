-- The button press that consumed an approval. The decision was marked used before Eve received it,
-- so when that delivery failed the same Telegram update came back as "expired" and the parked turn
-- never resumed. Knowing the exact callback query lets that same update replay the recorded
-- decision, while any other press still finds the approval used.
ALTER TABLE telegram_hitl_approvals
  ADD COLUMN consumed_callback_query_id text;
