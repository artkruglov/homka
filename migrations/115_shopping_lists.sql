-- Покупки. Таблицы `shopping_*` создавались миграцией 012 и были удалены 017, поэтому это новая
-- подсистема, а не интерфейс к существующей: суррогат через название списка дел не даёт ни
-- количества, ни отметки «куплено» с автором, отличной от статуса задачи.
--
-- Список покупок по своей природе общий: его ведут вдвоём и смотрят в магазине с телефона, то есть
-- из личного чата. Поэтому у пункта нет исполнителя и нет личной области: он принадлежит области,
-- и её читают все, кто в ней состоит.
CREATE TABLE shopping_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  space_id uuid,
  list_name text NOT NULL CHECK (char_length(list_name) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  quantity text CHECK (char_length(quantity) BETWEEN 1 AND 50),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  added_by_telegram_id text NOT NULL,
  bought_by_telegram_id text,
  bought_at timestamptz,
  removed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Отметка о покупке это автор и время вместе: «куплено без покупателя» ничего не значит.
  CONSTRAINT shopping_items_bought_shape
    CHECK ((bought_by_telegram_id IS NULL) = (bought_at IS NULL)),
  -- Область строки неизменна так же, как у прежних записей: её меняет только удаление области.
  CONSTRAINT shopping_items_space_id_fkey FOREIGN KEY (space_id, family_id)
    REFERENCES spaces(id, family_id) ON DELETE SET NULL (space_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX shopping_items_space_id_idx ON shopping_items(space_id, family_id);
CREATE INDEX shopping_items_list ON shopping_items(family_id, list_name)
  WHERE removed_at IS NULL;
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON shopping_items
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();

-- Повтор одного действия не создаёт второй пункт и не снимает отметку дважды.
CREATE TABLE shopping_item_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  actor_telegram_id text NOT NULL,
  request_hash text NOT NULL,
  item_id uuid NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
  space_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key),
  CONSTRAINT shopping_item_operations_space_id_fkey FOREIGN KEY (space_id, family_id)
    REFERENCES spaces(id, family_id) ON DELETE SET NULL (space_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX shopping_item_operations_space_id_idx ON shopping_item_operations(space_id, family_id);
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON shopping_item_operations
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();
CREATE TRIGGER space_inheritance BEFORE INSERT ON shopping_item_operations
  FOR EACH ROW EXECUTE FUNCTION inherit_space_from_parent('shopping_items', 'item_id');
