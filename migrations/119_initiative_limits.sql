-- Разговор, начатый ботом, ограничивается данными, а не фразой в промпте.
--
-- Тихие часы у человека уже есть; здесь появляются три вещи, которых не было: выключатель
-- «не пиши мне первым», предел на сутки и пауза после молчания. Предел и пауза считаются по
-- журналу начатых разговоров: без него «сколько раз сегодня» пришлось бы выводить из логов.
--
-- Журнал держит только то, что ограничение и покрывает. Сводка здоровья и предупреждение о памяти
-- сюда не пишутся: это служба отчитывается о себе, и молчание вместо них значило бы «всё хорошо».
ALTER TABLE user_notification_settings
  ADD COLUMN initiative_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN initiative_daily_limit smallint NOT NULL DEFAULT 3
    CHECK (initiative_daily_limit BETWEEN 0 AND 20);

CREATE TYPE initiative_kind AS ENUM ('suggestion', 'update_proposal');

CREATE TABLE initiative_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind initiative_kind NOT NULL,
  -- Местная дата человека, а не дата сервера: предел на сутки это его сутки.
  sent_on date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  -- Ответ человека снимает паузу: пока он молчит, следующие попытки упираются в неё.
  answered_at timestamptz CHECK (answered_at IS NULL OR answered_at >= sent_at)
);

CREATE INDEX initiative_messages_user_day_idx
  ON initiative_messages (user_id, sent_on DESC);
CREATE INDEX initiative_messages_unanswered_idx
  ON initiative_messages (user_id, sent_at DESC) WHERE answered_at IS NULL;
