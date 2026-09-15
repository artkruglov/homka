-- Потомок заявления или нити читается только через своего родителя, поэтому утечки от пустой
-- области он не даёт. Но ворота переключения требуют, чтобы несвязанных строк не осталось вовсе,
-- а перечислять все места вставки — значит однажды забыть одно из них. Область наследуется
-- инвариантом схемы: писатель может её не передавать, но не может передать чужую — это уже
-- запрещает составной отложенный ключ, созданный переносом 104.
CREATE FUNCTION inherit_space_from_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_key uuid; parent_space uuid;
BEGIN
  IF NEW.space_id IS NOT NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT ($1).%I', TG_ARGV[1]) INTO parent_key USING NEW;
  IF parent_key IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT space_id FROM %I WHERE id = $1', TG_ARGV[0])
    INTO parent_space USING parent_key;
  NEW.space_id := parent_space;
  RETURN NEW;
END $$;

DO $$
DECLARE inheritance text[][] := ARRAY[
  ['claim_evidence', 'memory_items_all', 'claim_id'],
  ['claim_relations', 'memory_items_all', 'source_claim_id'],
  ['memory_embedding_chunks', 'memory_items_all', 'memory_item_id'],
  ['memory_embedding_jobs', 'memory_items_all', 'memory_item_id'],
  ['memory_item_refs', 'memory_items_all', 'memory_item_id'],
  ['memory_mutation_operations', 'memory_items_all', 'memory_item_id'],
  ['memory_thread_entries', 'memory_threads', 'thread_id'],
  ['memory_thread_briefs', 'memory_threads', 'thread_id'],
  ['memory_thread_creation_notices', 'memory_threads', 'thread_id'],
  ['memory_thread_lifecycle_operations', 'memory_threads', 'thread_id']
];
  entry text[];
BEGIN
  FOREACH entry SLICE 1 IN ARRAY inheritance LOOP
    EXECUTE format(
      'CREATE TRIGGER space_inheritance BEFORE INSERT ON %I
         FOR EACH ROW EXECUTE FUNCTION inherit_space_from_parent(%L, %L)',
      entry[1], entry[2], entry[3]);
  END LOOP;
END $$;

-- Прежние строки, оставшиеся без области после того, как родитель её получил.
UPDATE claim_evidence child SET space_id = parent.space_id
  FROM memory_items_all parent
 WHERE parent.id = child.claim_id AND child.space_id IS NULL AND parent.space_id IS NOT NULL;
UPDATE memory_item_refs child SET space_id = parent.space_id
  FROM memory_items_all parent
 WHERE parent.id = child.memory_item_id AND child.space_id IS NULL AND parent.space_id IS NOT NULL;
UPDATE memory_thread_entries child SET space_id = parent.space_id
  FROM memory_threads parent
 WHERE parent.id = child.thread_id AND child.space_id IS NULL AND parent.space_id IS NOT NULL;
