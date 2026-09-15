-- A short reservation serializes E5 calls; durable outcomes enforce one refined create per source.
-- Timeline retention may delete the source row, but family/conversation deletion still erases the ledger.
-- Rejected claim text is never stored; only opaque request hashes and existing candidate metadata persist.
CREATE TABLE memory_thread_creation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  conversation_id uuid NOT NULL,
  timeline_entry_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (char_length(operation_key) > 0),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 2),
  status text NOT NULL CHECK (status IN ('pending', 'candidate', 'completed', 'resolved')),
  lease_token uuid,
  lease_expires_at timestamptz,
  candidate_thread_refs text[],
  candidate_titles text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, family_id, scope, scope_partition_key)
    REFERENCES application_conversations(id, family_id, scope, scope_partition_key)
    ON DELETE CASCADE,
  CONSTRAINT memory_thread_creation_attempt_state_shape CHECK (
    (status = 'pending' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND candidate_thread_refs IS NULL AND candidate_titles IS NULL) OR
    (status = 'candidate' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND candidate_thread_refs IS NOT NULL AND candidate_titles IS NOT NULL) OR
    (status = 'resolved' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND candidate_thread_refs IS NOT NULL AND candidate_titles IS NOT NULL) OR
    (status = 'completed' AND attempt_number = 2 AND lease_token IS NULL
      AND lease_expires_at IS NULL AND candidate_thread_refs IS NULL AND candidate_titles IS NULL)
  ),
  CONSTRAINT memory_thread_creation_attempt_candidates_shape CHECK (
    status NOT IN ('candidate', 'resolved') OR (
      cardinality(candidate_thread_refs) BETWEEN 1 AND 3 AND
      cardinality(candidate_titles) = cardinality(candidate_thread_refs) AND
      array_position(candidate_titles, NULL) IS NULL AND
      array_to_string(candidate_thread_refs, ',') ~
        '^thread_[0-9a-f]{32}(,thread_[0-9a-f]{32}){0,2}$'
    )
  ),
  UNIQUE (family_id, operation_key),
  UNIQUE (conversation_id, timeline_entry_id, attempt_number)
);
