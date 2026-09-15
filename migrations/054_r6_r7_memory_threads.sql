-- R6/R7 is additive: existing claims remain authoritative and unchanged. Application events gain a
-- composite family identity so confirmed outcomes can prove tenant-local provenance by foreign key.
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_id_family_unique UNIQUE (id, family_id);

-- Projects are scoped identities for shared processes such as a repair or family trip. They are not
-- generic entities: their only purpose is binding subjectless claims, outcomes, and memory threads.
CREATE TABLE memory_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref text NOT NULL UNIQUE DEFAULT ('project_' || encode(gen_random_bytes(16), 'hex')),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  title_normalized text GENERATED ALWAYS AS (lower(regexp_replace(trim(title), '\s+', ' ', 'g'))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_projects_ref_format CHECK (project_ref ~ '^project_[0-9a-f]{32}$'),
  CONSTRAINT memory_projects_shared_scope CHECK (scope IN ('family', 'group')),
  CONSTRAINT memory_projects_partition_shape CHECK (
    (scope = 'family' AND group_id IS NULL AND scope_partition_key = family_id) OR
    (scope = 'group' AND group_id IS NOT NULL AND scope_partition_key = group_id)
  ),
  FOREIGN KEY (group_id, family_id) REFERENCES telegram_groups(id, family_id) ON DELETE CASCADE,
  UNIQUE (id, family_id, scope, scope_partition_key),
  UNIQUE (family_id, scope, scope_partition_key, title_normalized)
);

CREATE INDEX memory_projects_group
  ON memory_projects (group_id, family_id) WHERE group_id IS NOT NULL;

ALTER TABLE memory_items
  ADD COLUMN memory_project_id uuid,
  ADD CONSTRAINT memory_items_project_identity_shape CHECK (
    memory_project_id IS NULL OR
    num_nonnulls(subject_family_id, subject_user_id, subject_participant_id) = 0
  ),
  ADD CONSTRAINT memory_items_project_partition_fk
    FOREIGN KEY (memory_project_id, family_id, scope, scope_partition_key)
    REFERENCES memory_projects(id, family_id, scope, scope_partition_key);

CREATE INDEX memory_items_memory_project
  ON memory_items (memory_project_id) WHERE memory_project_id IS NOT NULL;

-- Absence of an explicit continuation signal remains false and fail-closed for pre-R6 candidates.
ALTER TABLE memory_extraction_candidates
  ADD COLUMN proposed_thread_continuation boolean NOT NULL DEFAULT false;

-- Outcomes are authoritative only when an application event proves how confirmation occurred. The
-- snapshot survives timeline retention; optional source coordinates preserve exact user provenance.
CREATE TYPE confirmed_outcome_status AS ENUM ('confirmed', 'retracted');
CREATE TYPE confirmed_outcome_authority AS ENUM (
  'verified_user_statement', 'application_event', 'formal_goal_condition'
);
CREATE TYPE confirmed_outcome_kind AS ENUM ('result', 'completion_episode');

CREATE TABLE confirmed_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome_ref text NOT NULL UNIQUE DEFAULT ('outcome_' || encode(gen_random_bytes(16), 'hex')),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid GENERATED ALWAYS AS (
    CASE WHEN scope = 'group' THEN scope_partition_key ELSE NULL END
  ) STORED,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  subject_participant_id uuid,
  subject_conversation_id uuid,
  memory_project_id uuid,
  outcome_kind confirmed_outcome_kind NOT NULL DEFAULT 'result',
  authority confirmed_outcome_authority NOT NULL,
  application_event_id uuid NOT NULL,
  source_conversation_id uuid,
  source_timeline_entry_id uuid,
  source_erased_at timestamptz,
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  status confirmed_outcome_status NOT NULL DEFAULT 'confirmed',
  occurred_at timestamptz NOT NULL,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT confirmed_outcomes_ref_format CHECK (outcome_ref ~ '^outcome_[0-9a-f]{32}$'),
  CONSTRAINT confirmed_outcomes_identity_shape CHECK (
    num_nonnulls(subject_user_id, subject_participant_id, memory_project_id) = 1 AND
    ((subject_participant_id IS NULL AND subject_conversation_id IS NULL) OR
     (subject_participant_id IS NOT NULL AND subject_conversation_id IS NOT NULL))
  ),
  CONSTRAINT confirmed_outcomes_partition_shape CHECK (
    (scope = 'personal' AND subject_user_id IS NOT NULL AND scope_partition_key = subject_user_id
      AND group_id IS NULL) OR
    (scope = 'family' AND subject_participant_id IS NULL AND scope_partition_key = family_id
      AND group_id IS NULL) OR
    (scope = 'group' AND subject_user_id IS NULL AND group_id = scope_partition_key)
  ),
  CONSTRAINT confirmed_outcomes_lifecycle_shape CHECK (
    (status = 'confirmed' AND retracted_at IS NULL) OR
    (status = 'retracted' AND retracted_at IS NOT NULL)
  ),
  CONSTRAINT confirmed_outcomes_user_source_shape CHECK (
    (authority = 'verified_user_statement' AND (
      (source_conversation_id IS NOT NULL AND source_erased_at IS NULL) OR
      (source_conversation_id IS NULL AND source_timeline_entry_id IS NULL
        AND source_erased_at IS NOT NULL)
    )) OR
    (authority <> 'verified_user_statement' AND source_conversation_id IS NULL
      AND source_timeline_entry_id IS NULL AND source_erased_at IS NULL)
  ),
  FOREIGN KEY (group_id, family_id)
    REFERENCES telegram_groups(id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (application_event_id, family_id)
    REFERENCES audit_events(id, family_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES application_conversations(id, family_id, scope, scope_partition_key),
  FOREIGN KEY (source_timeline_entry_id, source_conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id) ON DELETE SET NULL (source_timeline_entry_id),
  FOREIGN KEY (subject_participant_id, subject_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES conversation_participants(id, conversation_id, family_id, scope, scope_partition_key),
  FOREIGN KEY (memory_project_id, family_id, scope, scope_partition_key)
    REFERENCES memory_projects(id, family_id, scope, scope_partition_key),
  UNIQUE (id, family_id, scope, scope_partition_key)
);

CREATE TABLE confirmed_outcome_source_claims (
  outcome_id uuid NOT NULL,
  source_claim_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  source_role text NOT NULL CHECK (
    source_role IN ('goal', 'result', 'decision', 'lesson', 'method', 'episode', 'open_loop')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outcome_id, source_claim_id, source_role),
  FOREIGN KEY (outcome_id, family_id, scope, scope_partition_key)
    REFERENCES confirmed_outcomes(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (source_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE
);

CREATE INDEX confirmed_outcomes_source_conversation
  ON confirmed_outcomes (source_conversation_id) WHERE source_conversation_id IS NOT NULL;
CREATE INDEX confirmed_outcomes_family ON confirmed_outcomes (family_id);
CREATE INDEX confirmed_outcomes_subject_user
  ON confirmed_outcomes (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX confirmed_outcomes_application_event
  ON confirmed_outcomes (application_event_id, family_id);
CREATE INDEX confirmed_outcomes_source_timeline_entry
  ON confirmed_outcomes (source_timeline_entry_id, source_conversation_id)
  WHERE source_timeline_entry_id IS NOT NULL;
CREATE INDEX confirmed_outcomes_subject_participant
  ON confirmed_outcomes (subject_participant_id, subject_conversation_id)
  WHERE subject_participant_id IS NOT NULL;
CREATE INDEX confirmed_outcomes_memory_project
  ON confirmed_outcomes (memory_project_id) WHERE memory_project_id IS NOT NULL;
CREATE INDEX confirmed_outcomes_group
  ON confirmed_outcomes (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX confirmed_outcome_source_claims_claim
  ON confirmed_outcome_source_claims (source_claim_id);

CREATE TABLE confirmed_outcome_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('create', 'retract')),
  outcome_id uuid NOT NULL REFERENCES confirmed_outcomes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);

CREATE INDEX confirmed_outcome_operations_outcome
  ON confirmed_outcome_operations (outcome_id);

CREATE FUNCTION validate_confirmed_outcome_source_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  outcome confirmed_outcomes%ROWTYPE;
  claim memory_items%ROWTYPE;
BEGIN
  SELECT * INTO outcome FROM confirmed_outcomes WHERE id = NEW.outcome_id;
  SELECT * INTO claim FROM memory_items WHERE id = NEW.source_claim_id;
  IF claim.provenance_state <> 'evidenced' OR
     claim.subject_user_id IS DISTINCT FROM outcome.subject_user_id OR
     claim.subject_participant_id IS DISTINCT FROM outcome.subject_participant_id OR
     claim.memory_project_id IS DISTINCT FROM outcome.memory_project_id THEN
    RAISE EXCEPTION 'AGENT_CONFIRMED_OUTCOME_SOURCE_IDENTITY_MISMATCH: source identity differs';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER confirmed_outcome_sources_validate_identity
BEFORE INSERT OR UPDATE ON confirmed_outcome_source_claims
FOR EACH ROW EXECUTE FUNCTION validate_confirmed_outcome_source_identity();

-- Threads carry only a stable scoped identity and lifecycle. A thread belongs to one verified user,
-- one verified group participant, or one scoped project; a parent is constrained to the same zone.
CREATE TYPE memory_thread_status AS ENUM ('active', 'completed');
CREATE TYPE memory_thread_entry_role AS ENUM (
  'goal', 'constraint', 'method', 'decision', 'episode', 'outcome', 'lesson', 'open_loop'
);

CREATE TABLE memory_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_ref text NOT NULL UNIQUE DEFAULT ('thread_' || encode(gen_random_bytes(16), 'hex')),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid GENERATED ALWAYS AS (
    CASE WHEN scope = 'group' THEN scope_partition_key ELSE NULL END
  ) STORED,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  subject_participant_id uuid,
  subject_conversation_id uuid,
  memory_project_id uuid,
  parent_thread_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  title_normalized text GENERATED ALWAYS AS (lower(regexp_replace(trim(title), '\s+', ' ', 'g'))) STORED,
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 500),
  status memory_thread_status NOT NULL DEFAULT 'active',
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  completion_outcome_id uuid,
  title_embedding vector(384),
  title_embedding_model text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_threads_ref_format CHECK (thread_ref ~ '^thread_[0-9a-f]{32}$'),
  CONSTRAINT memory_threads_identity_shape CHECK (
    num_nonnulls(subject_user_id, subject_participant_id, memory_project_id) = 1 AND
    ((subject_participant_id IS NULL AND subject_conversation_id IS NULL) OR
     (subject_participant_id IS NOT NULL AND subject_conversation_id IS NOT NULL))
  ),
  CONSTRAINT memory_threads_partition_shape CHECK (
    (scope = 'personal' AND subject_user_id IS NOT NULL AND scope_partition_key = subject_user_id
      AND group_id IS NULL) OR
    (scope = 'family' AND subject_participant_id IS NULL AND scope_partition_key = family_id
      AND group_id IS NULL) OR
    (scope = 'group' AND subject_user_id IS NULL AND group_id = scope_partition_key)
  ),
  CONSTRAINT memory_threads_lifecycle_shape CHECK (
    (status = 'active' AND completed_at IS NULL AND completion_outcome_id IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND completion_outcome_id IS NOT NULL)
  ),
  FOREIGN KEY (subject_participant_id, subject_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES conversation_participants(id, conversation_id, family_id, scope, scope_partition_key),
  FOREIGN KEY (memory_project_id, family_id, scope, scope_partition_key)
    REFERENCES memory_projects(id, family_id, scope, scope_partition_key),
  FOREIGN KEY (group_id, family_id)
    REFERENCES telegram_groups(id, family_id) ON DELETE CASCADE,
  UNIQUE (id, family_id, scope, scope_partition_key),
  UNIQUE (id, family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
          subject_conversation_id, memory_project_id),
  UNIQUE NULLS NOT DISTINCT (
    family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
    memory_project_id, parent_thread_id, title_normalized
  )
);

ALTER TABLE memory_threads
  ADD CONSTRAINT memory_threads_parent_partition_fk
    FOREIGN KEY (parent_thread_id, family_id, scope, scope_partition_key)
    REFERENCES memory_threads(id, family_id, scope, scope_partition_key),
  ADD CONSTRAINT memory_threads_completion_partition_fk
    FOREIGN KEY (completion_outcome_id, family_id, scope, scope_partition_key)
    REFERENCES confirmed_outcomes(id, family_id, scope, scope_partition_key);

CREATE INDEX memory_threads_parent
  ON memory_threads (parent_thread_id) WHERE parent_thread_id IS NOT NULL;
CREATE INDEX memory_threads_subject_user
  ON memory_threads (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX memory_threads_completion_outcome
  ON memory_threads (completion_outcome_id) WHERE completion_outcome_id IS NOT NULL;
CREATE INDEX memory_threads_subject_participant
  ON memory_threads (subject_participant_id, subject_conversation_id)
  WHERE subject_participant_id IS NOT NULL;
CREATE INDEX memory_threads_memory_project
  ON memory_threads (memory_project_id) WHERE memory_project_id IS NOT NULL;
CREATE INDEX memory_threads_group
  ON memory_threads (group_id) WHERE group_id IS NOT NULL;

CREATE FUNCTION validate_memory_thread_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent memory_threads%ROWTYPE;
BEGIN
  IF NEW.parent_thread_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent FROM memory_threads WHERE id = NEW.parent_thread_id;
  IF parent.id IS NULL OR parent.parent_thread_id IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_MEMORY_THREAD_DEPTH_INVALID: only root plus one subthread is allowed';
  END IF;
  IF parent.subject_user_id IS DISTINCT FROM NEW.subject_user_id OR
     parent.subject_participant_id IS DISTINCT FROM NEW.subject_participant_id OR
     parent.memory_project_id IS DISTINCT FROM NEW.memory_project_id THEN
    RAISE EXCEPTION 'AGENT_MEMORY_THREAD_IDENTITY_MISMATCH: parent identity differs';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_threads_validate_hierarchy
BEFORE INSERT OR UPDATE OF parent_thread_id, subject_user_id, subject_participant_id, memory_project_id
ON memory_threads FOR EACH ROW EXECUTE FUNCTION validate_memory_thread_hierarchy();

-- Each entry has exactly one authoritative source. Composite FKs prevent cross-zone links, while
-- the validation trigger proves source provenance and exact project/subject identity.
CREATE TABLE memory_thread_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_ref text NOT NULL UNIQUE DEFAULT ('entry_' || encode(gen_random_bytes(16), 'hex')),
  thread_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  source_claim_id uuid,
  source_outcome_id uuid,
  role memory_thread_entry_role NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_thread_entries_ref_format CHECK (entry_ref ~ '^entry_[0-9a-f]{32}$'),
  CONSTRAINT memory_thread_entries_source_shape CHECK (
    num_nonnulls(source_claim_id, source_outcome_id) = 1
  ),
  FOREIGN KEY (thread_id, family_id, scope, scope_partition_key)
    REFERENCES memory_threads(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (source_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (source_outcome_id, family_id, scope, scope_partition_key)
    REFERENCES confirmed_outcomes(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  UNIQUE (id, thread_id),
  UNIQUE NULLS NOT DISTINCT (thread_id, source_claim_id, source_outcome_id)
);

CREATE FUNCTION validate_memory_thread_entry_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  thread memory_threads%ROWTYPE;
  claim memory_items%ROWTYPE;
  outcome confirmed_outcomes%ROWTYPE;
BEGIN
  SELECT * INTO thread FROM memory_threads WHERE id = NEW.thread_id;
  IF NEW.source_claim_id IS NOT NULL THEN
    SELECT * INTO claim FROM memory_items WHERE id = NEW.source_claim_id;
    IF claim.provenance_state <> 'evidenced' OR
       claim.claim_status <> 'active' OR
       NOT EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id) THEN
      RAISE EXCEPTION 'AGENT_MEMORY_THREAD_SOURCE_REQUIRED: claim has no durable evidence';
    END IF;
    IF claim.subject_user_id IS DISTINCT FROM thread.subject_user_id OR
       claim.subject_participant_id IS DISTINCT FROM thread.subject_participant_id OR
       claim.memory_project_id IS DISTINCT FROM thread.memory_project_id THEN
      RAISE EXCEPTION 'AGENT_MEMORY_THREAD_SOURCE_IDENTITY_MISMATCH: claim identity differs';
    END IF;
  ELSE
    SELECT * INTO outcome FROM confirmed_outcomes WHERE id = NEW.source_outcome_id;
    IF outcome.status <> 'confirmed' THEN
      RAISE EXCEPTION 'AGENT_MEMORY_THREAD_SOURCE_REQUIRED: outcome is not confirmed';
    END IF;
    IF outcome.subject_user_id IS DISTINCT FROM thread.subject_user_id OR
       outcome.subject_participant_id IS DISTINCT FROM thread.subject_participant_id OR
       outcome.memory_project_id IS DISTINCT FROM thread.memory_project_id THEN
      RAISE EXCEPTION 'AGENT_MEMORY_THREAD_SOURCE_IDENTITY_MISMATCH: outcome identity differs';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_thread_entries_validate_source
BEFORE INSERT OR UPDATE ON memory_thread_entries
FOR EACH ROW EXECUTE FUNCTION validate_memory_thread_entry_source();

CREATE INDEX memory_thread_entries_thread_order
  ON memory_thread_entries(thread_id, occurred_at DESC, id DESC);
CREATE INDEX memory_thread_entries_claim ON memory_thread_entries(source_claim_id)
  WHERE source_claim_id IS NOT NULL;
CREATE INDEX memory_thread_entries_outcome ON memory_thread_entries(source_outcome_id)
  WHERE source_outcome_id IS NOT NULL;

-- A brief is a generation/model/schema projection. Blocks cannot exist without source entries from
-- the same thread, and the application stores whole generated blocks rather than truncating text.
CREATE TABLE memory_thread_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_ref text NOT NULL UNIQUE DEFAULT ('brief_' || encode(gen_random_bytes(16), 'hex')),
  thread_id uuid NOT NULL REFERENCES memory_threads(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  model_version text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 200),
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 120),
  total_characters integer NOT NULL CHECK (total_characters BETWEEN 1 AND 6000),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_thread_briefs_ref_format CHECK (brief_ref ~ '^brief_[0-9a-f]{32}$'),
  UNIQUE (thread_id, generation, model_version, schema_version),
  UNIQUE (id, thread_id)
);

CREATE TABLE memory_thread_brief_blocks (
  brief_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  kind text NOT NULL CHECK (kind IN (
    'constraints_conflicts', 'active_goals_open_loops', 'method',
    'decisions_outcomes', 'lessons', 'episodes'
  )),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 6000),
  PRIMARY KEY (brief_id, ordinal),
  UNIQUE (brief_id, ordinal, thread_id),
  FOREIGN KEY (brief_id, thread_id)
    REFERENCES memory_thread_briefs(id, thread_id) ON DELETE CASCADE
);

CREATE TABLE memory_thread_brief_block_sources (
  brief_id uuid NOT NULL,
  block_ordinal integer NOT NULL,
  thread_id uuid NOT NULL,
  thread_entry_id uuid NOT NULL,
  PRIMARY KEY (brief_id, block_ordinal, thread_entry_id),
  FOREIGN KEY (brief_id, block_ordinal, thread_id)
    REFERENCES memory_thread_brief_blocks(brief_id, ordinal, thread_id) ON DELETE CASCADE,
  FOREIGN KEY (thread_entry_id, thread_id)
    REFERENCES memory_thread_entries(id, thread_id) ON DELETE CASCADE
);

CREATE INDEX memory_thread_brief_block_sources_entry
  ON memory_thread_brief_block_sources (thread_entry_id, thread_id);

-- Creation notices are inserted in the same transaction as a thread. Taking a notice is a single
-- pending-to-presented transition on the next authorized turn; there is no proactive delivery job.
CREATE TABLE memory_thread_creation_notices (
  thread_id uuid PRIMARY KEY REFERENCES memory_threads(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'presented')),
  presented_conversation_id uuid REFERENCES application_conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  presented_at timestamptz,
  CHECK ((status = 'pending') = (presented_at IS NULL))
);

CREATE INDEX memory_thread_creation_notices_presented_conversation
  ON memory_thread_creation_notices (presented_conversation_id)
  WHERE presented_conversation_id IS NOT NULL;
CREATE INDEX memory_thread_creation_notices_family
  ON memory_thread_creation_notices (family_id);

-- Online and recovery paths stage the same durable classifier job. Provider-capable leases become
-- terminal on ambiguity/failure; explicit requeue creates a distinct bounded attempt.
CREATE TABLE memory_thread_discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid GENERATED ALWAYS AS (
    CASE WHEN scope = 'group' THEN scope_partition_key ELSE NULL END
  ) STORED,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  subject_participant_id uuid,
  subject_conversation_id uuid,
  memory_project_id uuid,
  discovery_path text NOT NULL CHECK (discovery_path IN ('online', 'recovery')),
  candidate_key text NOT NULL CHECK (candidate_key ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'leased', 'attach_existing', 'create_new', 'create_subthread',
    'unrelated', 'ambiguous', 'failed'
  )),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_call_started_at timestamptz,
  result_thread_id uuid,
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  output_payload_hash text CHECK (output_payload_hash IS NULL OR output_payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT memory_thread_discovery_identity_shape CHECK (
    (num_nonnulls(subject_user_id, subject_participant_id, memory_project_id) = 1 OR
     (scope IN ('family', 'group') AND
      num_nonnulls(subject_user_id, subject_participant_id, memory_project_id) = 0)) AND
    ((subject_participant_id IS NULL AND subject_conversation_id IS NULL) OR
     (subject_participant_id IS NOT NULL AND subject_conversation_id IS NOT NULL))
  ),
  CONSTRAINT memory_thread_discovery_partition_shape CHECK (
    (scope = 'personal' AND subject_user_id IS NOT NULL AND scope_partition_key = subject_user_id
      AND group_id IS NULL) OR
    (scope = 'family' AND subject_participant_id IS NULL AND scope_partition_key = family_id
      AND group_id IS NULL) OR
    (scope = 'group' AND subject_user_id IS NULL AND group_id = scope_partition_key)
  ),
  CONSTRAINT memory_thread_discovery_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT memory_thread_discovery_terminal_shape CHECK (
    (status IN ('pending', 'leased') AND completed_at IS NULL AND diagnostic_code IS NULL) OR
    (status = 'failed' AND completed_at IS NOT NULL AND diagnostic_code IS NOT NULL) OR
    (status IN ('attach_existing', 'create_new', 'create_subthread', 'unrelated', 'ambiguous')
      AND completed_at IS NOT NULL AND diagnostic_code IS NULL AND output_payload_hash IS NOT NULL)
  ),
  FOREIGN KEY (subject_participant_id, subject_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES conversation_participants(id, conversation_id, family_id, scope, scope_partition_key),
  FOREIGN KEY (memory_project_id, family_id, scope, scope_partition_key)
    REFERENCES memory_projects(id, family_id, scope, scope_partition_key),
  FOREIGN KEY (result_thread_id, family_id, scope, scope_partition_key)
    REFERENCES memory_threads(id, family_id, scope, scope_partition_key),
  FOREIGN KEY (group_id, family_id)
    REFERENCES telegram_groups(id, family_id) ON DELETE CASCADE,
  UNIQUE (family_id, candidate_key, attempt),
  UNIQUE (id, family_id, scope, scope_partition_key)
);

CREATE UNIQUE INDEX memory_thread_discovery_one_active
  ON memory_thread_discovery_jobs(family_id, candidate_key)
  WHERE status IN ('pending', 'leased');
CREATE INDEX memory_thread_discovery_claim
  ON memory_thread_discovery_jobs(status, created_at, id) WHERE status = 'pending';
CREATE INDEX memory_thread_discovery_group
  ON memory_thread_discovery_jobs (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX memory_thread_discovery_subject_user
  ON memory_thread_discovery_jobs (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX memory_thread_discovery_participant
  ON memory_thread_discovery_jobs (subject_participant_id, subject_conversation_id)
  WHERE subject_participant_id IS NOT NULL;
CREATE INDEX memory_thread_discovery_project
  ON memory_thread_discovery_jobs (memory_project_id) WHERE memory_project_id IS NOT NULL;
CREATE INDEX memory_thread_discovery_result_thread
  ON memory_thread_discovery_jobs (result_thread_id) WHERE result_thread_id IS NOT NULL;

CREATE TABLE memory_thread_discovery_sources (
  job_id uuid NOT NULL,
  source_ref text NOT NULL DEFAULT ('source_' || encode(gen_random_bytes(16), 'hex'))
    CHECK (source_ref ~ '^source_[0-9a-f]{32}$'),
  source_claim_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  extraction_batch_id uuid REFERENCES memory_extraction_batches(id) ON DELETE SET NULL,
  ongoing_future_work boolean NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, source_ref),
  UNIQUE (job_id, source_claim_id),
  FOREIGN KEY (job_id, family_id, scope, scope_partition_key)
    REFERENCES memory_thread_discovery_jobs(id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (source_claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items(id, family_id, scope, scope_partition_key) ON DELETE CASCADE
);

CREATE INDEX memory_thread_discovery_sources_claim
  ON memory_thread_discovery_sources (source_claim_id);
CREATE INDEX memory_thread_discovery_sources_batch
  ON memory_thread_discovery_sources (extraction_batch_id)
  WHERE extraction_batch_id IS NOT NULL;

CREATE FUNCTION validate_memory_thread_discovery_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  job memory_thread_discovery_jobs%ROWTYPE;
  claim memory_items%ROWTYPE;
BEGIN
  SELECT * INTO job FROM memory_thread_discovery_jobs WHERE id = NEW.job_id;
  SELECT * INTO claim FROM memory_items WHERE id = NEW.source_claim_id;
  IF claim.provenance_state <> 'evidenced' OR
     claim.subject_user_id IS DISTINCT FROM job.subject_user_id OR
     claim.subject_participant_id IS DISTINCT FROM job.subject_participant_id OR
     claim.memory_project_id IS DISTINCT FROM job.memory_project_id THEN
    RAISE EXCEPTION 'AGENT_MEMORY_THREAD_DISCOVERY_SOURCE_IDENTITY_MISMATCH: source identity differs';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_thread_discovery_sources_validate_identity
BEFORE INSERT OR UPDATE ON memory_thread_discovery_sources
FOR EACH ROW EXECUTE FUNCTION validate_memory_thread_discovery_source();

CREATE TABLE memory_thread_discovery_existing (
  job_id uuid NOT NULL REFERENCES memory_thread_discovery_jobs(id) ON DELETE CASCADE,
  thread_candidate_ref text NOT NULL CHECK (thread_candidate_ref ~ '^thread_[0-9a-f]{32}$'),
  thread_id uuid NOT NULL REFERENCES memory_threads(id) ON DELETE CASCADE,
  is_parent_candidate boolean NOT NULL,
  PRIMARY KEY (job_id, thread_candidate_ref),
  UNIQUE (job_id, thread_id)
);

CREATE INDEX memory_thread_discovery_existing_thread
  ON memory_thread_discovery_existing (thread_id);

CREATE TABLE memory_thread_discovery_claim_coverage (
  source_claim_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  last_job_id uuid REFERENCES memory_thread_discovery_jobs(id) ON DELETE SET NULL,
  considered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_thread_lifecycle_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  thread_id uuid NOT NULL REFERENCES memory_threads(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('complete', 'reactivate')),
  outcome_id uuid REFERENCES confirmed_outcomes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);

CREATE INDEX memory_thread_discovery_claim_coverage_last_job
  ON memory_thread_discovery_claim_coverage (last_job_id) WHERE last_job_id IS NOT NULL;

CREATE INDEX memory_thread_lifecycle_operations_thread
  ON memory_thread_lifecycle_operations (thread_id);
CREATE INDEX memory_thread_lifecycle_operations_outcome
  ON memory_thread_lifecycle_operations (outcome_id) WHERE outcome_id IS NOT NULL;

-- Generation invalidation is synchronous with every authoritative source or relation mutation. A
-- cache from an older generation is physically removed before the mutating transaction commits.
CREATE FUNCTION invalidate_memory_threads_for_claim(claim_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid[];
BEGIN
  SELECT array_agg(DISTINCT thread_id) INTO affected
  FROM memory_thread_entries WHERE source_claim_id = claim_id;
  IF affected IS NULL THEN RETURN; END IF;
  DELETE FROM memory_thread_briefs WHERE thread_id = ANY(affected);
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = ANY(affected)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
END
$$;

CREATE FUNCTION invalidate_memory_threads_for_outcome(outcome_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid[];
BEGIN
  SELECT array_agg(DISTINCT thread_id) INTO affected
  FROM memory_thread_entries WHERE source_outcome_id = outcome_id;
  IF affected IS NULL THEN RETURN; END IF;
  DELETE FROM memory_thread_briefs WHERE thread_id = ANY(affected);
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = ANY(affected)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
END
$$;

CREATE FUNCTION invalidate_memory_thread_entry_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid;
BEGIN
  affected := CASE WHEN TG_OP = 'DELETE' THEN OLD.thread_id ELSE NEW.thread_id END;
  DELETE FROM memory_thread_briefs WHERE thread_id = affected;
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = affected
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER memory_thread_entries_invalidate
AFTER INSERT OR UPDATE OR DELETE ON memory_thread_entries
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_entry_change();

CREATE FUNCTION invalidate_memory_thread_claim_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM invalidate_memory_threads_for_claim(CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER memory_items_invalidate_thread_projections_on_delete
BEFORE DELETE ON memory_items
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_claim_change();

CREATE TRIGGER memory_items_invalidate_thread_projections_on_update
AFTER UPDATE OF content, subject_user_id,
  subject_participant_id, memory_project_id ON memory_items
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_claim_change();

CREATE FUNCTION invalidate_memory_thread_evidence_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM invalidate_memory_threads_for_claim(CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_id ELSE NEW.claim_id END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER claim_evidence_invalidate_thread_projections
AFTER INSERT OR UPDATE OR DELETE ON claim_evidence
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_evidence_change();

CREATE FUNCTION invalidate_memory_thread_relation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM invalidate_memory_threads_for_claim(CASE WHEN TG_OP = 'DELETE' THEN OLD.source_claim_id ELSE NEW.source_claim_id END);
  PERFORM invalidate_memory_threads_for_claim(CASE WHEN TG_OP = 'DELETE' THEN OLD.target_claim_id ELSE NEW.target_claim_id END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER claim_relations_invalidate_thread_projections
AFTER INSERT OR UPDATE OR DELETE ON claim_relations
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_relation_change();

CREATE FUNCTION invalidate_memory_thread_conflict_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM invalidate_memory_threads_for_claim(CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_a_id ELSE NEW.claim_a_id END);
  PERFORM invalidate_memory_threads_for_claim(CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_b_id ELSE NEW.claim_b_id END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER claim_conflicts_invalidate_thread_projections
AFTER INSERT OR UPDATE OR DELETE ON claim_conflicts
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_conflict_change();

CREATE FUNCTION invalidate_memory_thread_outcome_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM invalidate_memory_threads_for_outcome(CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER confirmed_outcomes_invalidate_thread_projections_on_delete
BEFORE DELETE ON confirmed_outcomes
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_outcome_change();

CREATE TRIGGER confirmed_outcomes_invalidate_thread_projections_on_update
AFTER UPDATE OF summary, status, occurred_at ON confirmed_outcomes
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_outcome_change();

CREATE FUNCTION invalidate_memory_thread_outcome_source_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM invalidate_memory_threads_for_outcome(CASE WHEN TG_OP = 'DELETE' THEN OLD.outcome_id ELSE NEW.outcome_id END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER confirmed_outcome_sources_invalidate_thread_projections
AFTER INSERT OR UPDATE OR DELETE ON confirmed_outcome_source_claims
FOR EACH ROW EXECUTE FUNCTION invalidate_memory_thread_outcome_source_change();

-- Removing or superseding an authoritative claim invalidates every completion decision that used
-- it. The outcome remains as an honest retracted audit record, while active context loses all
-- completion entries and completed threads become active again.
CREATE FUNCTION retract_confirmed_outcome_projections(affected_outcome_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- A missing generated owner group means the outer trust-zone DELETE already owns every root.
  -- Updating those rows mid-cascade could recheck a project FK after its parent was removed.
  IF EXISTS (
    SELECT 1
    FROM confirmed_outcomes AS outcome
    WHERE outcome.id = affected_outcome_id
      AND outcome.group_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM telegram_groups WHERE id = outcome.group_id)
  ) THEN
    RETURN;
  END IF;
  DELETE FROM memory_thread_entries WHERE source_outcome_id = affected_outcome_id;
  UPDATE memory_threads
  SET status = 'active', completion_outcome_id = NULL, completed_at = NULL,
      generation = generation + 1, updated_at = now()
  WHERE completion_outcome_id = affected_outcome_id;
  UPDATE confirmed_outcomes
  SET status = 'retracted', retracted_at = coalesce(retracted_at, now()), updated_at = now()
  WHERE id = affected_outcome_id AND status = 'confirmed';
END
$$;

CREATE FUNCTION retract_outcome_after_source_claim_removal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM retract_confirmed_outcome_projections(OLD.outcome_id);
  RETURN OLD;
END
$$;

CREATE TRIGGER confirmed_outcome_sources_retract_after_delete
AFTER DELETE ON confirmed_outcome_source_claims
FOR EACH ROW EXECUTE FUNCTION retract_outcome_after_source_claim_removal();

CREATE FUNCTION retract_outcomes_after_claim_lifecycle_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_outcome_id uuid;
BEGIN
  IF NEW.claim_status = 'active' AND NEW.provenance_state = 'evidenced' THEN
    RETURN NEW;
  END IF;
  FOR affected_outcome_id IN
    SELECT source.outcome_id
    FROM confirmed_outcome_source_claims AS source
    WHERE source.source_claim_id = NEW.id
  LOOP
    PERFORM retract_confirmed_outcome_projections(affected_outcome_id);
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_items_retract_confirmed_outcomes
AFTER UPDATE OF claim_status, provenance_state ON memory_items
FOR EACH ROW
WHEN (OLD.claim_status IS DISTINCT FROM NEW.claim_status OR
      OLD.provenance_state IS DISTINCT FROM NEW.provenance_state)
EXECUTE FUNCTION retract_outcomes_after_claim_lifecycle_change();

-- Thread membership is an active-source projection. Retiring or provenance-erasing a claim removes
-- its entries; the entry trigger above also erases every generated brief that cited the claim.
CREATE FUNCTION remove_inactive_claim_from_memory_threads()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.claim_status <> 'active' OR NEW.provenance_state <> 'evidenced' THEN
    DELETE FROM memory_thread_entries WHERE source_claim_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_items_remove_inactive_thread_sources
AFTER UPDATE OF claim_status, provenance_state ON memory_items
FOR EACH ROW
WHEN (OLD.claim_status IS DISTINCT FROM NEW.claim_status OR
      OLD.provenance_state IS DISTINCT FROM NEW.provenance_state)
EXECUTE FUNCTION remove_inactive_claim_from_memory_threads();

-- Family claims and outcomes survive deletion of one family Telegram conversation, but their live
-- source coordinates must not block the cascade or imply that erased source data remains available.
CREATE FUNCTION erase_confirmed_outcome_conversation_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE confirmed_outcomes
  SET source_conversation_id = NULL,
      source_timeline_entry_id = NULL,
      source_erased_at = coalesce(source_erased_at, now()),
      updated_at = now()
  WHERE source_conversation_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER application_conversations_erase_confirmed_outcome_source
BEFORE DELETE ON application_conversations
FOR EACH ROW EXECUTE FUNCTION erase_confirmed_outcome_conversation_source();
