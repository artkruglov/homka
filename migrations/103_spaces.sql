-- Space metadata and immutable audience snapshots. Existing data readers are not switched here.
ALTER TABLE telegram_groups ADD CONSTRAINT telegram_groups_family_id_id UNIQUE (family_id, id);

CREATE TABLE spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('personal', 'work', 'shared', 'group', 'legacy_family')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  source_group_id uuid,
  legacy_scope memory_scope,
  state text NOT NULL DEFAULT 'forming' CHECK (state IN ('forming', 'active', 'archived')),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, id),
  FOREIGN KEY (family_id, source_group_id) REFERENCES telegram_groups(family_id, id) ON DELETE CASCADE,
  CHECK (
    (kind IN ('personal','work') AND owner_user_id IS NOT NULL AND source_group_id IS NULL) OR
    (kind = 'group' AND owner_user_id IS NULL AND source_group_id IS NOT NULL) OR
    (kind IN ('shared','legacy_family') AND owner_user_id IS NULL AND source_group_id IS NULL)
  ),
  CHECK (legacy_scope IS NULL OR
    (legacy_scope='personal' AND kind='personal') OR
    (legacy_scope='family' AND kind='legacy_family') OR
    (legacy_scope='group' AND kind='group'))
);
CREATE UNIQUE INDEX spaces_legacy_partition ON spaces(family_id, legacy_scope, owner_user_id, source_group_id)
  NULLS NOT DISTINCT WHERE legacy_scope IS NOT NULL;

CREATE TABLE space_memberships (
  family_id uuid NOT NULL,
  space_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('manager','adult','helper','child')),
  state text NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','declined','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id),
  FOREIGN KEY (family_id, space_id) REFERENCES spaces(family_id,id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, user_id) REFERENCES family_memberships(family_id,user_id) ON DELETE CASCADE
);
CREATE INDEX space_memberships_reader ON space_memberships(family_id,user_id,state);

CREATE TABLE space_bindings (
  family_id uuid NOT NULL,
  group_id uuid PRIMARY KEY,
  space_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending_verification' CHECK (state IN ('pending_verification','active','paused')),
  FOREIGN KEY (family_id, group_id) REFERENCES telegram_groups(family_id,id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, space_id) REFERENCES spaces(family_id,id) ON DELETE CASCADE
);

CREATE FUNCTION space_role_rank(role text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE role WHEN 'manager' THEN 4 WHEN 'adult' THEN 3 WHEN 'helper' THEN 2 ELSE 1 END $$;

CREATE FUNCTION guard_space_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent spaces;
BEGIN
  SELECT * INTO parent FROM spaces WHERE id=COALESCE(NEW.space_id,OLD.space_id) FOR UPDATE;
  IF NOT FOUND THEN RETURN COALESCE(NEW,OLD); END IF; -- Parent removal is already a revocation.
  IF TG_OP='INSERT' AND parent.state <> 'forming' THEN
    RAISE EXCEPTION 'AGENT_SPACE_AUDIENCE_FROZEN: Create a new space for additional readers';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.family_id,NEW.space_id,NEW.user_id) IS DISTINCT FROM (OLD.family_id,OLD.space_id,OLD.user_id) THEN
      RAISE EXCEPTION 'AGENT_SPACE_MEMBERSHIP_IDENTITY_IMMUTABLE';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state='invited' AND NEW.state IN ('active','declined','revoked')) OR
      (OLD.state='active' AND NEW.state='revoked')
    ) THEN RAISE EXCEPTION 'AGENT_SPACE_MEMBERSHIP_TERMINAL'; END IF;
    -- Активное пространство заморожено целиком, а не только по составу: прежде `child` молча
    -- становился `manager` и получал запись, публикацию, управление составом и подключения.
    -- Сужение прав внутри той же аудитории остаётся доступным всегда; расширение требует нового
    -- пространства, как и добавление читателя.
    IF NEW.role <> OLD.role AND parent.state <> 'forming' AND
      space_role_rank(NEW.role) > space_role_rank(OLD.role) THEN
      RAISE EXCEPTION 'AGENT_SPACE_ROLE_ESCALATION_FROZEN: Create a new space for wider rights';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND parent.owner_user_id IS NOT NULL AND NEW.user_id <> parent.owner_user_id THEN
    RAISE EXCEPTION 'AGENT_SPACE_PERSONAL_OWNER_ONLY';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER space_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON space_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_space_membership();

CREATE FUNCTION guard_space_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_version < OLD.policy_version THEN
    RAISE EXCEPTION 'AGENT_SPACE_POLICY_VERSION_REWIND';
  END IF;
  IF (NEW.id,NEW.family_id,NEW.kind,NEW.owner_user_id,NEW.source_group_id,NEW.legacy_scope)
    IS DISTINCT FROM (OLD.id,OLD.family_id,OLD.kind,OLD.owner_user_id,OLD.source_group_id,OLD.legacy_scope) THEN
    RAISE EXCEPTION 'AGENT_SPACE_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state='forming' AND NEW.state IN ('active','archived')) OR
      (OLD.state='active' AND NEW.state='archived')) THEN RAISE EXCEPTION 'AGENT_SPACE_STATE_TERMINAL'; END IF;
    IF NEW.state='active' AND NEW.kind <> 'group' AND (
      NOT EXISTS(SELECT 1 FROM space_memberships WHERE space_id=NEW.id AND state='active') OR
      EXISTS(SELECT 1 FROM space_memberships WHERE space_id=NEW.id AND state <> 'active')
    ) THEN RAISE EXCEPTION 'AGENT_SPACE_AUDIENCE_NOT_READY'; END IF;
  END IF;
  -- Название в аудиторию не входит: подъём версии из-за переименования отставил бы сессию,
  -- удалил маршруты и погасил все висящие подтверждения ради косметики.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.policy_version := OLD.policy_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER space_state_guard BEFORE UPDATE ON spaces FOR EACH ROW EXECUTE FUNCTION guard_space_state();

-- Удаление пространства обнуляет область у его строк (`ON DELETE SET NULL (space_id)`) и версию
-- политики у его сессий. В самом режиме пространств такие строки просто перестают читаться, но
-- после отката режима их снова разбирают прежние предикаты по разделу — и запись пары становится
-- общесемейной. Поэтому удаление требует осознанной архивации, а не одного оператора. Удаление
-- семьи проходит как прежде: её строка исчезает раньше каскада, и данных, к которым вели эти
-- пространства, тоже не остаётся.
CREATE FUNCTION guard_space_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Каскад от родителя проходит как прежде: его строка исчезает раньше, и данных, к которым вело
  -- пространство, тоже не остаётся. Запрет касается только прямого удаления живого пространства.
  IF OLD.state <> 'archived'
     AND EXISTS (SELECT 1 FROM families WHERE id=OLD.family_id)
     AND (OLD.source_group_id IS NULL OR EXISTS (SELECT 1 FROM telegram_groups WHERE id=OLD.source_group_id))
     AND (OLD.owner_user_id IS NULL OR EXISTS (SELECT 1 FROM users WHERE id=OLD.owner_user_id)) THEN
    RAISE EXCEPTION 'AGENT_SPACE_ARCHIVE_REQUIRED: Archive the space before deleting it';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER space_deletion_guard BEFORE DELETE ON spaces FOR EACH ROW EXECUTE FUNCTION guard_space_deletion();

CREATE FUNCTION bump_space_membership_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR (NEW.role,NEW.state) IS DISTINCT FROM (OLD.role,OLD.state) THEN
    UPDATE spaces SET policy_version=policy_version+1 WHERE id=COALESCE(NEW.space_id,OLD.space_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER space_membership_policy AFTER INSERT OR UPDATE OR DELETE ON space_memberships
  FOR EACH ROW EXECUTE FUNCTION bump_space_membership_policy();

CREATE FUNCTION guard_space_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_kind text; target_group uuid; group_type text;
BEGIN
  SELECT s.kind,s.source_group_id,g.type::text INTO target_kind,target_group,group_type
    FROM spaces s JOIN telegram_groups g ON g.family_id=s.family_id
    WHERE s.id=NEW.space_id AND s.family_id=NEW.family_id AND g.id=NEW.group_id;
  IF NOT FOUND OR NOT (
    (group_type='external' AND target_kind='group' AND target_group=NEW.group_id) OR
    (group_type='family_private' AND target_kind IN ('shared','legacy_family'))
  ) THEN RAISE EXCEPTION 'AGENT_SPACE_BINDING_INVALID'; END IF;
  -- Удаление и вставка в одной транзакции обходили бы требование паузы, объявленное ветке
  -- UPDATE. Аудиторию общей области доказывают заново, поэтому новая привязка начинается
  -- неподтверждённой; у внешней группы доказывать нечего — область и есть сама группа.
  IF TG_OP='INSERT' AND NEW.state='active' AND target_kind <> 'group' THEN
    RAISE EXCEPTION 'AGENT_SPACE_BINDING_UNPROVEN: Confirm the chat audience before binding it';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.family_id,NEW.group_id) IS DISTINCT FROM (OLD.family_id,OLD.group_id) THEN
      RAISE EXCEPTION 'AGENT_SPACE_BINDING_IDENTITY_IMMUTABLE';
    END IF;
    IF NEW.space_id <> OLD.space_id AND (OLD.state='active' OR NEW.state='active') THEN
      RAISE EXCEPTION 'AGENT_SPACE_BINDING_PAUSE_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER space_binding_guard BEFORE INSERT OR UPDATE ON space_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_space_binding();

CREATE FUNCTION bump_space_binding_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE spaces SET policy_version=policy_version+1 WHERE id=OLD.space_id;
  ELSIF TG_OP='INSERT' THEN
    UPDATE spaces SET policy_version=policy_version+1 WHERE id=NEW.space_id;
  ELSIF (NEW.space_id,NEW.state) IS DISTINCT FROM (OLD.space_id,OLD.state) THEN
    UPDATE spaces SET policy_version=policy_version+1 WHERE id IN (OLD.space_id,NEW.space_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER space_binding_policy AFTER INSERT OR UPDATE OR DELETE ON space_bindings
  FOR EACH ROW EXECUTE FUNCTION bump_space_binding_policy();

-- LEGACY_AUDIENCE_SNAPSHOT: executed once by the migration, never on family enrollment.
INSERT INTO spaces(family_id,kind,title,legacy_scope)
  SELECT id,'legacy_family','Прежняя семейная область','family' FROM families;
INSERT INTO spaces(family_id,kind,title,owner_user_id,legacy_scope)
  SELECT family_id,'personal','Личное',user_id,'personal' FROM family_memberships;
-- Telegram допускает название чата длиннее, чем принимает название пространства, и
-- `telegram_groups.title` хранит его без ограничения: срез сохраняет узнаваемость и не роняет перенос.
INSERT INTO spaces(family_id,kind,title,source_group_id,legacy_scope)
  SELECT family_id,'group',left(title,100),id,'group' FROM telegram_groups WHERE type='external';
INSERT INTO space_memberships(family_id,space_id,user_id,role,state)
  SELECT s.family_id,s.id,m.user_id,
    CASE WHEN s.kind='personal' OR m.role IN ('owner','recovery_owner') THEN 'manager' ELSE 'adult' END,'active'
  FROM spaces s JOIN family_memberships m ON m.family_id=s.family_id
  WHERE s.legacy_scope='family' OR (s.legacy_scope='personal' AND s.owner_user_id=m.user_id);
UPDATE spaces s SET state=CASE WHEN kind='group' OR EXISTS(
  SELECT 1 FROM space_memberships m WHERE m.space_id=s.id AND m.state='active'
) THEN 'active' ELSE 'archived' END;
INSERT INTO space_bindings(family_id,group_id,space_id,state)
  SELECT g.family_id,g.id,s.id,CASE WHEN g.type='external' THEN 'active' ELSE 'pending_verification' END
  FROM telegram_groups g JOIN spaces s ON s.family_id=g.family_id AND (
    (g.type='external' AND s.legacy_scope='group' AND s.source_group_id=g.id) OR
    (g.type='family_private' AND s.legacy_scope='family')
  );
