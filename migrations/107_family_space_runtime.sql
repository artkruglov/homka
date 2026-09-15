-- Признаком включённого режима должно быть явное состояние семьи, а не заполненная миграцией
-- колонка: 104 связывает все прежние строки задолго до того, как ingress начнёт выдавать контекст.
-- Переключатель живёт в таблице, потому что его надо снимать и возвращать без пересборки образа и
-- читать `FOR SHARE` в той же транзакции, что и проверку доступа к пространству.
CREATE TABLE family_space_runtime (
  family_id uuid PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'spaces')),
  cutover_at timestamptz,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT family_space_runtime_cutover_shape CHECK (mode = 'legacy' OR cutover_at IS NOT NULL)
);

INSERT INTO family_space_runtime (family_id, reason)
  SELECT id, 'Перенос W04: режим по умолчанию прежний' FROM families;

-- Одна строка на семью: читателю не нужно различать «режим прежний» и «строки ещё нет».
CREATE FUNCTION add_family_space_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO family_space_runtime (family_id, reason)
    VALUES (NEW.id, 'Новая семья: режим по умолчанию прежний')
    ON CONFLICT (family_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER family_space_runtime_default AFTER INSERT ON families
  FOR EACH ROW EXECUTE FUNCTION add_family_space_runtime();

-- Ворота включения принадлежат базе, а не дисциплине оператора: всё, что перечислено ниже,
-- нельзя обойти ни скриптом, ни ручным UPDATE. Обратный переход не ограничивается никогда:
-- откат режима обязан оставаться доступным, а его условие по данным проверяет скрипт перехода.
CREATE FUNCTION guard_family_space_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family_id IS DISTINCT FROM OLD.family_id THEN
    RAISE EXCEPTION 'AGENT_SPACE_RUNTIME_IDENTITY_IMMUTABLE';
  END IF;
  NEW.changed_at := now();
  IF NEW.mode = OLD.mode THEN
    RETURN NEW;
  END IF;
  IF NEW.mode = 'legacy' THEN
    NEW.cutover_at := NULL;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM telegram_groups g
     WHERE g.family_id = NEW.family_id
       AND NOT EXISTS (SELECT 1 FROM space_bindings b WHERE b.group_id = g.id)
  ) THEN
    RAISE EXCEPTION 'AGENT_SPACE_CUTOVER_GROUP_UNBOUND';
  END IF;
  IF EXISTS (
    SELECT 1 FROM telegram_groups g
     JOIN space_bindings b ON b.group_id = g.id
     WHERE g.family_id = NEW.family_id AND g.type = 'family_private' AND b.state <> 'active'
  ) THEN
    RAISE EXCEPTION 'AGENT_SPACE_CUTOVER_AUDIENCE_UNVERIFIED';
  END IF;
  -- Прежняя сессия несёт историю, доказанную другой аудиторией: продолжать её в новой области
  -- нельзя, поэтому переход разрешён только после того, как переход отставил их все.
  IF EXISTS (
    SELECT 1 FROM conversation_sessions s
     WHERE s.family_id = NEW.family_id AND s.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'AGENT_SPACE_CUTOVER_SESSIONS_ACTIVE';
  END IF;
  NEW.cutover_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER family_space_mode_guard BEFORE UPDATE ON family_space_runtime
  FOR EACH ROW EXECUTE FUNCTION guard_family_space_mode();
