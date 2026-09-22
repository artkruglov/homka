-- Коуч касается человека не чаще раза в сутки его дня. Новое значение перечисления нельзя
-- использовать в той же транзакции, где оно добавлено, поэтому индекс живёт отдельно от 145.
CREATE UNIQUE INDEX initiative_messages_coach_daily
  ON initiative_messages(user_id, sent_on)
  WHERE kind = 'coach';
CREATE INDEX initiative_messages_coach_reason_idx
  ON initiative_messages(user_id, coach_reason, sent_at DESC)
  WHERE kind = 'coach';
ALTER TABLE initiative_messages ADD CONSTRAINT initiative_messages_coach_reason_shape
  CHECK ((kind = 'coach') = (coach_reason IS NOT NULL));
