-- Личное время: окно, которое принадлежит человеку.
--
-- У семейного планировщика до сих пор не было способа сказать «это моё»: любой мог поставить
-- другому дело на его тренировку или на вечер с ребёнком, и отказаться значило объясняться. Окно
-- делает это правилом, а не разговором: бот в него не пишет первым, а чужое дело в него не ставится.
--
-- Окно повторяется по дням недели, потому что личное время это привычка, а не однократное событие.
-- Хранится местное время человека: пояс живёт в его настройках и может измениться, а «с семи до
-- девяти вечера» остаётся тем же.
CREATE TABLE personal_time_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  -- 0 это воскресенье, как в ISO-выдаче Postgres; NULL означает каждый день.
  weekday smallint CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Окно внутри суток: «с вечера до утра» это два окна, и человек задаёт их отдельно.
  CONSTRAINT personal_time_windows_shape CHECK (starts_at < ends_at),
  UNIQUE (user_id, weekday, starts_at, ends_at)
);
CREATE INDEX personal_time_windows_person ON personal_time_windows(user_id, weekday);
