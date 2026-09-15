-- Persist the exact user-visible prompt and callback semantics so a verified choice can replace the
-- original Telegram message without trusting callback payload order or opaque framework IDs.
ALTER TABLE telegram_hitl_approvals
  ADD COLUMN prompt_text text,
  ADD COLUMN callback_options jsonb,
  ADD COLUMN selected_option_id text,
  ADD COLUMN selected_option_label text;

-- Existing pending prompts do not have a trustworthy semantic mapping. Expire them instead of
-- guessing what an old compact callback ID meant.
UPDATE telegram_hitl_approvals
SET consumed_at = now()
WHERE consumed_at IS NULL;

ALTER TABLE telegram_hitl_approvals
  ADD CONSTRAINT telegram_hitl_pending_presentation CHECK (
    consumed_at IS NOT NULL OR (
      prompt_text IS NOT NULL AND char_length(prompt_text) > 0 AND
      callback_options IS NOT NULL AND jsonb_typeof(callback_options) = 'array'
    )
  ),
  ADD CONSTRAINT telegram_hitl_selected_option_pair CHECK (
    (selected_option_id IS NULL) = (selected_option_label IS NULL)
  );
