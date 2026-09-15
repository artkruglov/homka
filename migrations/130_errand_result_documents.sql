-- Purpose: retain complete researched selections independently of Telegram's message limit.
-- Delivery chooses a single text message or a single document with the same durable receipt.
-- Recipient-authored answers retain their existing 3000-character limit.
ALTER TABLE errand_results DROP CONSTRAINT errand_results_text_check;
ALTER TABLE errand_results ADD CONSTRAINT errand_results_text_check
  CHECK (char_length(text) BETWEEN 1 AND 32000);
