-- Russian morphology complements the existing simple vector retained for exact names and numbers.
ALTER TABLE memory_items
  ADD COLUMN russian_search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('russian', content)) STORED;

-- The GIN index keeps morphology lookup indexed without adding pg_trgm after E5 passed the typo eval.
CREATE INDEX memory_items_russian_search_vector_idx
  ON memory_items USING gin (russian_search_vector);
