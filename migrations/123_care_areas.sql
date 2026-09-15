-- Область заботы: целое дело жизни, у которого есть хозяин.
--
-- Семейный планировщик умел только поштучные поручения, и «машина», «садик», «здоровье родителей»
-- превращались в поток задач, который второй взрослый обязан был отслеживать, чтобы ничего не
-- забыли. Область заботы говорит другое: этим занимается вот этот человек целиком, и остальным не
-- нужно держать её в голове.
--
-- Хозяин появляется только через явное согласие, как и у передачи дела: предложить можно кому
-- угодно, назначить нельзя никого. Отказ возвращает область в свободные, и её отсутствие видно.
--
-- Рейтинга вклада здесь нет и не будет: сравнение «кто больше сделал» это то, ради чего семья
-- ботом пользоваться не станет.
CREATE TABLE care_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  space_id uuid,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  details text CHECK (char_length(details) BETWEEN 1 AND 1000),
  creator_telegram_id text NOT NULL,
  owner_telegram_id text,
  pending_owner_telegram_id text,
  proposed_at timestamptz,
  accepted_at timestamptz,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'proposed', 'accepted', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Состояние и участники держатся вместе: «принято без хозяина» и «предложено никому» непредставимы.
  CONSTRAINT care_areas_state_shape CHECK (
    (status = 'open' AND owner_telegram_id IS NULL AND pending_owner_telegram_id IS NULL) OR
    (status = 'proposed' AND owner_telegram_id IS NULL AND pending_owner_telegram_id IS NOT NULL) OR
    (status = 'accepted' AND owner_telegram_id IS NOT NULL AND pending_owner_telegram_id IS NULL
      AND accepted_at IS NOT NULL) OR
    (status = 'retired' AND pending_owner_telegram_id IS NULL)
  ),
  CONSTRAINT care_areas_proposal_shape CHECK (
    (pending_owner_telegram_id IS NULL) = (proposed_at IS NULL)
  ),
  -- Личная область заботы бессмысленна: заботиться за себя перед собой не нужно.
  CONSTRAINT care_areas_scope_shape CHECK (scope <> 'personal'),
  CONSTRAINT care_areas_space_id_fkey FOREIGN KEY (space_id, family_id)
    REFERENCES spaces(id, family_id) ON DELETE SET NULL (space_id)
    DEFERRABLE INITIALLY DEFERRED
);
-- Одинаковое название в одном чате это одна область: иначе «машина» и «машина» разошлись бы молча.
CREATE UNIQUE INDEX care_areas_title
  ON care_areas(family_id, COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(title))
  WHERE status <> 'retired';
CREATE INDEX care_areas_space_id_idx ON care_areas(space_id, family_id);
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON care_areas
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();

-- Дело может принадлежать области заботы: тогда видно, к чему оно относится и кто её ведёт.
ALTER TABLE shared_tasks
  ADD COLUMN care_area_id uuid REFERENCES care_areas(id) ON DELETE SET NULL;
CREATE INDEX shared_tasks_care_area ON shared_tasks(care_area_id) WHERE care_area_id IS NOT NULL;
