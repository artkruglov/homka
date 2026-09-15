-- Доказанный состав чата. Приложение отвечает за аудиторию, поэтому «кто это читает» обязано быть
-- строкой в базе, а не выводом из типа чата: тип чата говорит о доверии, а не о людях в нём.
--
-- Замыкание — главное здесь. Поимённая проверка доказывает, что каждый названный человек в чате
-- есть; она ничего не говорит о том, что в нём нет никого больше. Поэтому счётчик участников
-- входит в ту же строку ограничением: незамкнутая аудитория непредставима.
CREATE FUNCTION has_unique_elements(items uuid[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(items) = (SELECT count(DISTINCT item) FROM unnest(items) AS item) $$;

CREATE TABLE telegram_chat_audience_proofs (
  group_id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  space_id uuid NOT NULL,
  space_policy_version integer NOT NULL CHECK (space_policy_version > 0),
  roster uuid[] NOT NULL,
  -- Сам бот тоже участник чата, и в семейном чате он может быть не один.
  declared_bot_count integer NOT NULL CHECK (declared_bot_count BETWEEN 1 AND 50),
  observed_member_count integer NOT NULL,
  bot_is_administrator boolean NOT NULL,
  proved_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, group_id) REFERENCES telegram_groups(family_id, id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, space_id) REFERENCES spaces(family_id, id) ON DELETE CASCADE,
  CHECK (observed_member_count = cardinality(roster) + declared_bot_count),
  CHECK (cardinality(roster) BETWEEN 1 AND 200),
  CHECK (has_unique_elements(roster))
);

-- Доказательство принадлежит ровно той версии политики, при которой его подтвердил владелец:
-- любое изменение состава области поднимает версию, и прежняя строка перестаёт годиться.
CREATE INDEX telegram_chat_audience_proofs_space
  ON telegram_chat_audience_proofs (family_id, space_id, space_policy_version);
