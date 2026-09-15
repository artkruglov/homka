-- Opaque refs are the only stable memory identity allowed across the model boundary.
CREATE TABLE memory_item_refs (
  memory_item_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  memory_ref text NOT NULL UNIQUE
    DEFAULT ('mem_' || encode(gen_random_bytes(16), 'hex')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_item_refs_safe_format
    CHECK (memory_ref ~ '^mem_[0-9a-f]{32}$')
);

-- The primary key and non-null unique ref make this an exact one-to-one backfill.
INSERT INTO memory_item_refs (memory_item_id)
SELECT id
FROM memory_items;

-- Fail the migration instead of accepting a partial mapping for existing durable data.
DO $$
DECLARE
  item_count bigint;
  ref_count bigint;
BEGIN
  SELECT count(*) INTO item_count FROM memory_items;
  SELECT count(*) INTO ref_count FROM memory_item_refs;
  IF item_count <> ref_count THEN
    RAISE EXCEPTION 'AGENT_MEMORY_REF_BACKFILL_INCOMPLETE: expected %, mapped %',
      item_count, ref_count;
  END IF;
END
$$;

-- Keep the one-to-one invariant for every future writer, not only the application repository.
CREATE FUNCTION create_memory_item_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO memory_item_refs (memory_item_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_items_create_opaque_ref
AFTER INSERT ON memory_items
FOR EACH ROW
EXECUTE FUNCTION create_memory_item_ref();
