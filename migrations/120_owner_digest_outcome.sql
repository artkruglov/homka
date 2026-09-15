-- Неоднозначная доставка дайджеста не повторяется автоматически.
--
-- Заявка на отправку удалялась при любой ошибке, включая ту, где Telegram сообщение уже принял, а
-- ответ потерялся: через десять минут владелец получал вторую копию сводки за те же сутки. Теперь
-- у строки есть исход: неясный записывается кодом и остаётся терминальным, а заявку без исхода
-- перезабирает только чистка брошенных.
ALTER TABLE owner_health_digests
  ADD COLUMN diagnostic_code text
    CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  ADD CONSTRAINT owner_health_digests_outcome_shape CHECK (
    sent_at IS NULL OR diagnostic_code IS NULL
  );
