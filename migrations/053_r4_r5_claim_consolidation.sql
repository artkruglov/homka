-- R4/R5 extends the claim lifecycle without rewriting existing rows. Recreating the enum avoids
-- PostgreSQL's same-transaction restriction on using an ALTER TYPE ADD VALUE result immediately.
ALTER TABLE memory_items DROP CONSTRAINT memory_items_lifecycle_shape;
ALTER TABLE memory_items ALTER COLUMN claim_status DROP DEFAULT;
ALTER TYPE memory_claim_status RENAME TO memory_claim_status_r2;
CREATE TYPE memory_claim_status AS ENUM ('active', 'superseded', 'retracted', 'duplicate');
ALTER TABLE memory_items
  ALTER COLUMN claim_status TYPE memory_claim_status
  USING claim_status::text::memory_claim_status,
  ALTER COLUMN claim_status SET DEFAULT 'active';
DROP TYPE memory_claim_status_r2;

ALTER TABLE memory_items
  ADD COLUMN reinforcement_count integer NOT NULL DEFAULT 0 CHECK (reinforcement_count >= 0),
  ADD COLUMN last_reinforced_at timestamptz,
  ADD CONSTRAINT memory_items_reinforcement_shape CHECK (
    (reinforcement_count = 0 AND last_reinforced_at IS NULL) OR
    (reinforcement_count > 0 AND last_reinforced_at IS NOT NULL)
  ),
  ADD CONSTRAINT memory_items_lifecycle_shape CHECK (
    (claim_status = 'active' AND superseded_by IS NULL AND duplicate_of IS NULL) OR
    (claim_status = 'superseded' AND superseded_by IS NOT NULL AND duplicate_of IS NULL) OR
    (claim_status = 'retracted' AND superseded_by IS NULL AND duplicate_of IS NULL) OR
    (claim_status = 'duplicate' AND superseded_by IS NULL AND duplicate_of IS NOT NULL)
  );

-- Trigram similarity only proposes a bounded candidate set. Every semantic decision still passes
-- the closed classifier and deterministic guards before persistence.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX memory_items_active_content_trgm
  ON memory_items USING gin (content_normalized gin_trgm_ops)
  WHERE claim_status = 'active' AND content_normalized IS NOT NULL;

-- Relations are normalized and carry their trust partition on both composite foreign keys. The
-- application owns semantic direction: source is the older/duplicate claim, target is its peer.
CREATE TYPE claim_relation_type AS ENUM (
  'duplicate', 'refinement', 'temporal_update', 'correction'
);

CREATE TABLE claim_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_claim_id uuid NOT NULL,
  target_claim_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  relation_type claim_relation_type NOT NULL,
  detection_method text NOT NULL CHECK (
    detection_method IN ('deterministic_exact', 'model_guarded', 'user_explicit')
  ),
  detection_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(detection_metadata) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_claim_id <> target_claim_id),
  FOREIGN KEY (source_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (target_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  UNIQUE (source_claim_id, target_claim_id, relation_type)
);

CREATE INDEX claim_relations_target ON claim_relations(target_claim_id, relation_type);

-- Conflicts are symmetric by canonical UUID ordering. Resolution never deletes a claim and records
-- both the verified actor and explicit operation used for replay protection.
CREATE TABLE claim_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_ref text NOT NULL UNIQUE DEFAULT ('conf_' || encode(gen_random_bytes(16), 'hex')),
  claim_a_id uuid NOT NULL,
  claim_b_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  detection_method text NOT NULL CHECK (
    detection_method IN ('model_guarded', 'deterministic_guard', 'user_reported')
  ),
  detection_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(detection_metadata) = 'object'
  ),
  resolution text NOT NULL DEFAULT 'unresolved' CHECK (
    resolution IN ('unresolved', 'chosen', 'keep_both')
  ),
  chosen_claim_id uuid,
  resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_telegram_user_id text,
  resolution_metadata jsonb CHECK (
    resolution_metadata IS NULL OR jsonb_typeof(resolution_metadata) = 'object'
  ),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT claim_conflicts_ref_format CHECK (conflict_ref ~ '^conf_[0-9a-f]{32}$'),
  CONSTRAINT claim_conflicts_canonical_pair CHECK (claim_a_id < claim_b_id),
  CONSTRAINT claim_conflicts_resolution_shape CHECK (
    (resolution = 'unresolved' AND chosen_claim_id IS NULL AND resolved_at IS NULL) OR
    (resolution = 'chosen' AND chosen_claim_id IN (claim_a_id, claim_b_id)
      AND resolved_at IS NOT NULL) OR
    (resolution = 'keep_both' AND chosen_claim_id IS NULL AND resolved_at IS NOT NULL)
  ),
  FOREIGN KEY (claim_a_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (claim_b_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (chosen_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key),
  UNIQUE (claim_a_id, claim_b_id)
);

CREATE INDEX claim_conflicts_unresolved_a
  ON claim_conflicts(claim_a_id) WHERE resolution = 'unresolved';
CREATE INDEX claim_conflicts_unresolved_b
  ON claim_conflicts(claim_b_id) WHERE resolution = 'unresolved';
CREATE INDEX claim_conflicts_chosen_claim
  ON claim_conflicts(chosen_claim_id) WHERE chosen_claim_id IS NOT NULL;
CREATE INDEX claim_conflicts_resolved_by_user
  ON claim_conflicts(resolved_by_user_id) WHERE resolved_by_user_id IS NOT NULL;

CREATE TABLE memory_conflict_resolution_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  conflict_id uuid NOT NULL REFERENCES claim_conflicts(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('choose', 'keep_both', 'keep_unresolved')),
  chosen_claim_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key),
  CHECK ((action = 'choose') = (chosen_claim_id IS NOT NULL))
);

CREATE INDEX memory_conflict_resolution_operations_conflict
  ON memory_conflict_resolution_operations (conflict_id);

-- A candidate is not written until this durable adjudication reaches a terminal state. Provider
-- failure is terminal and recoverable only by an explicit new operation; workers never auto-retry.
CREATE TABLE memory_consolidation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_row_id uuid REFERENCES memory_extraction_candidates(id) ON DELETE CASCADE,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  proposed_content text CHECK (proposed_content IS NULL OR char_length(proposed_content) BETWEEN 1 AND 4000),
  proposed_kind memory_kind,
  proposed_author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  proposed_author_telegram_user_id text,
  proposed_subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'leased', 'new', 'duplicate', 'refinement', 'temporal_update',
    'correction', 'conflict', 'ambiguous', 'failed'
  )),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_call_started_at timestamptz,
  selected_existing_claim_id uuid,
  diagnostic_code text CHECK (
    diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'
  ),
  output_payload_hash text CHECK (
    output_payload_hash IS NULL OR output_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT memory_consolidation_jobs_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT memory_consolidation_jobs_terminal_shape CHECK (
    (status IN ('pending', 'leased') AND completed_at IS NULL AND diagnostic_code IS NULL) OR
    (status = 'failed' AND completed_at IS NOT NULL AND diagnostic_code IS NOT NULL) OR
    (status IN ('new', 'duplicate', 'refinement', 'temporal_update', 'correction', 'conflict', 'ambiguous')
      AND completed_at IS NOT NULL AND diagnostic_code IS NULL AND output_payload_hash IS NOT NULL)
  ),
  CONSTRAINT memory_consolidation_jobs_input_shape CHECK (
    (candidate_row_id IS NOT NULL AND proposed_content IS NULL AND proposed_kind IS NULL) OR
    (candidate_row_id IS NULL AND proposed_content IS NOT NULL AND proposed_kind IS NOT NULL
      AND (proposed_author_user_id IS NOT NULL OR proposed_author_telegram_user_id IS NOT NULL))
  ),
  FOREIGN KEY (selected_existing_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key),
  UNIQUE (family_id, operation_key),
  UNIQUE NULLS NOT DISTINCT (candidate_row_id, operation_key, attempt)
);

CREATE INDEX memory_consolidation_jobs_claim
  ON memory_consolidation_jobs(status, created_at, id) WHERE status = 'pending';
CREATE UNIQUE INDEX memory_consolidation_jobs_one_active
  ON memory_consolidation_jobs(candidate_row_id)
  WHERE candidate_row_id IS NOT NULL AND status IN ('pending', 'leased');
CREATE INDEX memory_consolidation_jobs_selected_claim
  ON memory_consolidation_jobs (selected_existing_claim_id)
  WHERE selected_existing_claim_id IS NOT NULL;
CREATE INDEX memory_consolidation_jobs_proposed_author_user
  ON memory_consolidation_jobs (proposed_author_user_id)
  WHERE proposed_author_user_id IS NOT NULL;
CREATE INDEX memory_consolidation_jobs_proposed_subject_user
  ON memory_consolidation_jobs (proposed_subject_user_id)
  WHERE proposed_subject_user_id IS NOT NULL;

CREATE TABLE memory_consolidation_job_candidates (
  job_id uuid NOT NULL REFERENCES memory_consolidation_jobs(id) ON DELETE CASCADE,
  candidate_ref text NOT NULL CHECK (candidate_ref ~ '^existing_[0-9a-f]{32}$'),
  existing_claim_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  similarity double precision NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  PRIMARY KEY (job_id, candidate_ref),
  UNIQUE (job_id, existing_claim_id),
  FOREIGN KEY (existing_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE
);

CREATE INDEX memory_consolidation_job_candidates_existing_claim
  ON memory_consolidation_job_candidates (existing_claim_id);

-- Existing pending candidates remain valid. New terminal states distinguish deferred classifier
-- failure/ambiguity from a successfully materialized or reinforced claim.
ALTER TABLE memory_extraction_candidates
  DROP CONSTRAINT memory_extraction_candidates_resolution_status_check,
  DROP CONSTRAINT memory_extraction_candidate_resolution_shape;

ALTER TABLE memory_extraction_candidates
  ADD CONSTRAINT memory_extraction_candidates_resolution_status_check CHECK (
    resolution_status IN (
      'pending', 'approval_pending', 'consolidation_pending', 'claim_created',
      'reinforced', 'duplicate', 'conflict', 'ambiguous', 'rejected'
    )
  ),
  ADD CONSTRAINT memory_extraction_candidate_resolution_shape CHECK (
    (resolution_status IN ('pending', 'approval_pending', 'consolidation_pending')
      AND resolved_claim_id IS NULL AND resolution_diagnostic_code IS NULL AND resolved_at IS NULL) OR
    (resolution_status IN ('claim_created', 'reinforced', 'duplicate', 'conflict')
      AND resolved_claim_id IS NOT NULL AND resolution_diagnostic_code IS NULL AND resolved_at IS NOT NULL) OR
    (resolution_status = 'ambiguous' AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NULL AND resolved_at IS NOT NULL) OR
    (resolution_status = 'rejected' AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NOT NULL AND resolved_at IS NOT NULL)
  );
