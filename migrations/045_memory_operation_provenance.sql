-- Historical operation rows have no trustworthy Eve/user provenance and therefore remain NULL.
-- New memory creates persist verified caller/session/turn facts used by fail-closed immediate undo.
ALTER TABLE memory_mutation_operations
  ADD COLUMN actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN actor_telegram_user_id text,
  ADD COLUMN eve_session_id text,
  ADD COLUMN eve_turn_id text,
  ADD CONSTRAINT memory_operation_provenance_complete CHECK (
    (actor_telegram_user_id IS NULL AND eve_session_id IS NULL AND eve_turn_id IS NULL) OR
    (actor_telegram_user_id IS NOT NULL AND eve_session_id IS NOT NULL AND eve_turn_id IS NOT NULL)
  );

CREATE INDEX memory_mutation_operations_immediate_undo
  ON memory_mutation_operations
    (family_id, memory_item_id, mutation_kind, actor_telegram_user_id, eve_session_id, eve_turn_id);
