-- Заявки уведомлений. Новое значение перечисления нельзя использовать в той же транзакции, где
-- оно добавлено, поэтому таблица и индекс живут отдельно от 150.
--
-- Уникальность по (человек, вид, предмет) значит «про одно и то же не пишем дважды»; один повтор
-- через неделю отмечается `reminded_at`, третьего не будет. Уникальность по суткам не даёт
-- накопившемуся списку прийти стеной.
CREATE TABLE partner_alert_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_kind text NOT NULL CHECK (alert_kind IN
    ('task_proposed', 'task_transfer', 'care_area_proposed', 'decision_open')),
  subject_id uuid NOT NULL,
  delivery_ref uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  reminded_at timestamptz,
  UNIQUE (user_id, alert_kind, subject_id)
);
CREATE INDEX partner_alert_claims_pending ON partner_alert_claims(user_id, claimed_at DESC);

CREATE UNIQUE INDEX initiative_messages_partner_alert_daily
  ON initiative_messages(user_id, sent_on)
  WHERE kind = 'partner_alert';
