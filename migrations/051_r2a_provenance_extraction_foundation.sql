-- Stable application conversations are Telegram chats. Forum topics remain per-entry metadata and
-- never split conversation identity or its retention/trust boundary.
ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_id_family_unique UNIQUE (id, family_id);

CREATE TABLE application_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  telegram_group_id uuid UNIQUE,
  telegram_chat_id text NOT NULL UNIQUE,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) > 0),
  next_timeline_sequence bigint NOT NULL DEFAULT 0 CHECK (next_timeline_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_conversations_partition_shape CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND telegram_group_id IS NULL
      AND scope_partition_key = owner_user_id) OR
    (scope = 'family' AND owner_user_id IS NULL AND telegram_group_id IS NOT NULL
      AND scope_partition_key = family_id) OR
    (scope = 'group' AND owner_user_id IS NULL AND telegram_group_id IS NOT NULL
      AND scope_partition_key = telegram_group_id)
  ),
  FOREIGN KEY (telegram_group_id, family_id)
    REFERENCES telegram_groups(id, family_id) ON DELETE CASCADE,
  UNIQUE (id, family_id, scope, scope_partition_key),
  UNIQUE NULLS NOT DISTINCT (id, telegram_group_id),
  UNIQUE NULLS NOT DISTINCT (family_id, scope, owner_user_id, telegram_group_id)
);

-- Backfill is exact and transport-owned: one row per registered Telegram group, with no Eve history.
INSERT INTO application_conversations
  (family_id, telegram_group_id, telegram_chat_id, scope, scope_partition_key, label, created_at)
SELECT telegram_group.family_id,
       telegram_group.id,
       telegram_group.telegram_chat_id,
       CASE WHEN telegram_group.type = 'family_private' THEN 'family' ELSE 'group' END::memory_scope,
       CASE WHEN telegram_group.type = 'family_private' THEN telegram_group.family_id ELSE telegram_group.id END,
       telegram_group.title,
       telegram_group.created_at
FROM telegram_groups AS telegram_group;

-- A verified user receives one personal Telegram-chat conversation. No Eve transcript is copied.
INSERT INTO application_conversations
  (family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label, created_at)
SELECT membership.family_id, app_user.id, app_user.telegram_user_id, 'personal', app_user.id,
       app_user.display_name, app_user.created_at
FROM family_memberships AS membership
JOIN users AS app_user ON app_user.id = membership.user_id;

-- Future registered groups receive the same deterministic conversation identity immediately.
CREATE FUNCTION create_application_conversation_for_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO application_conversations
    (family_id, telegram_group_id, telegram_chat_id, scope, scope_partition_key, label, created_at)
  VALUES (
    NEW.family_id,
    NEW.id,
    NEW.telegram_chat_id,
    CASE WHEN NEW.type = 'family_private' THEN 'family' ELSE 'group' END::memory_scope,
    CASE WHEN NEW.type = 'family_private' THEN NEW.family_id ELSE NEW.id END,
    NEW.title,
    NEW.created_at
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_groups_create_application_conversation
AFTER INSERT ON telegram_groups
FOR EACH ROW EXECUTE FUNCTION create_application_conversation_for_group();

CREATE FUNCTION update_application_conversation_label()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE application_conversations
  SET label = NEW.title, updated_at = now()
  WHERE telegram_group_id = NEW.id;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_groups_update_application_conversation_label
AFTER UPDATE OF title ON telegram_groups
FOR EACH ROW
WHEN (OLD.title IS DISTINCT FROM NEW.title)
EXECUTE FUNCTION update_application_conversation_label();

-- Membership is the verification boundary for future private conversations.
CREATE FUNCTION create_application_conversation_for_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conversation_id uuid;
BEGIN
  INSERT INTO application_conversations
    (family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label, created_at)
  SELECT NEW.family_id, app_user.id, app_user.telegram_user_id, 'personal', app_user.id,
         app_user.display_name, app_user.created_at
  FROM users AS app_user WHERE app_user.id = NEW.user_id
  ON CONFLICT (telegram_chat_id) DO UPDATE
  SET label = EXCLUDED.label, updated_at = now()
  WHERE application_conversations.family_id = EXCLUDED.family_id
    AND application_conversations.owner_user_id = EXCLUDED.owner_user_id
    AND application_conversations.scope = 'personal'
    AND application_conversations.telegram_group_id IS NULL
  RETURNING id INTO conversation_id;
  IF conversation_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_APPLICATION_CONVERSATION_REJOIN_CONFLICT: private conversation belongs to another trust boundary';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER family_memberships_create_application_conversation
AFTER INSERT ON family_memberships
FOR EACH ROW EXECUTE FUNCTION create_application_conversation_for_member();

CREATE FUNCTION update_personal_application_conversation_label()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE application_conversations
  SET label = NEW.display_name, updated_at = now()
  WHERE owner_user_id = NEW.id AND scope = 'personal';
  RETURN NEW;
END
$$;

CREATE TRIGGER users_update_application_conversation_label
AFTER UPDATE OF display_name ON users
FOR EACH ROW
WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name)
EXECUTE FUNCTION update_personal_application_conversation_label();

CREATE INDEX application_conversations_owner_user
  ON application_conversations (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- The existing transcript table evolves in place. Group rows are mapped exactly; private rows begin
-- empty because Eve history is not an application-owned source.
ALTER TABLE telegram_group_messages
  ADD COLUMN conversation_id uuid REFERENCES application_conversations(id) ON DELETE CASCADE;

UPDATE telegram_group_messages AS message
SET conversation_id = conversation.id
FROM application_conversations AS conversation
WHERE conversation.telegram_group_id = message.group_id;

ALTER TABLE telegram_group_messages
  ALTER COLUMN conversation_id SET NOT NULL,
  ALTER COLUMN group_id DROP NOT NULL,
  ADD CONSTRAINT telegram_group_messages_conversation_sequence_unique
    UNIQUE (conversation_id, sequence_id),
  ADD CONSTRAINT telegram_group_messages_transport_shape CHECK (
    group_id IS NOT NULL OR message_thread_id IS NULL
  ),
  ADD CONSTRAINT telegram_group_messages_conversation_group_fk
    FOREIGN KEY (conversation_id, group_id)
    REFERENCES application_conversations (id, telegram_group_id),
  ADD CONSTRAINT telegram_group_messages_id_conversation_unique UNIQUE (id, conversation_id);

UPDATE application_conversations AS conversation
SET next_timeline_sequence = existing.maximum
FROM (
  SELECT conversation_id, max(sequence_id) AS maximum
  FROM telegram_group_messages GROUP BY conversation_id
) AS existing
WHERE conversation.id = existing.conversation_id;

-- A pruned group may have a durable counter above every retained row; preserve that monotonic seed.
UPDATE application_conversations AS conversation
SET next_timeline_sequence = greatest(
  conversation.next_timeline_sequence,
  telegram_group.next_timeline_sequence
)
FROM telegram_groups AS telegram_group
WHERE conversation.telegram_group_id = telegram_group.id;

CREATE FUNCTION resolve_timeline_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_group_id uuid;
BEGIN
  IF NEW.conversation_id IS NULL AND NEW.group_id IS NOT NULL THEN
    SELECT id INTO NEW.conversation_id
    FROM application_conversations WHERE telegram_group_id = NEW.group_id;
  END IF;
  IF NEW.conversation_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_CONVERSATION_MISSING: timeline entry has no conversation';
  END IF;
  SELECT telegram_group_id INTO expected_group_id
  FROM application_conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND OR NEW.group_id IS DISTINCT FROM expected_group_id THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_CONVERSATION_GROUP_MISMATCH: timeline transport identity differs';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_group_messages_resolve_conversation
BEFORE INSERT OR UPDATE OF conversation_id, group_id ON telegram_group_messages
FOR EACH ROW EXECUTE FUNCTION resolve_timeline_conversation();

ALTER TABLE telegram_group_message_ids
  ADD COLUMN conversation_id uuid REFERENCES application_conversations(id) ON DELETE CASCADE;

UPDATE telegram_group_message_ids AS alias
SET conversation_id = conversation.id
FROM application_conversations AS conversation
WHERE conversation.telegram_group_id = alias.group_id;

ALTER TABLE telegram_group_message_ids
  DROP CONSTRAINT telegram_group_message_ids_pkey,
  ALTER COLUMN conversation_id SET NOT NULL,
  ALTER COLUMN group_id DROP NOT NULL,
  ADD PRIMARY KEY (conversation_id, telegram_message_id),
  ADD CONSTRAINT telegram_group_message_ids_conversation_group_fk
    FOREIGN KEY (conversation_id, group_id)
    REFERENCES application_conversations (id, telegram_group_id),
  ADD CONSTRAINT telegram_group_message_ids_entry_conversation_fk
    FOREIGN KEY (entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX telegram_group_message_ids_group_alias
  ON telegram_group_message_ids (group_id, telegram_message_id)
  WHERE group_id IS NOT NULL;

CREATE FUNCTION resolve_timeline_alias_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_group_id uuid;
BEGIN
  IF NEW.conversation_id IS NULL AND NEW.group_id IS NOT NULL THEN
    SELECT id INTO NEW.conversation_id
    FROM application_conversations WHERE telegram_group_id = NEW.group_id;
  END IF;
  IF NEW.conversation_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_ALIAS_CONVERSATION_MISSING: alias has no conversation';
  END IF;
  SELECT telegram_group_id INTO expected_group_id
  FROM application_conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND OR NEW.group_id IS DISTINCT FROM expected_group_id THEN
    RAISE EXCEPTION 'AGENT_TIMELINE_ALIAS_CONVERSATION_GROUP_MISMATCH: alias transport identity differs';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_group_message_ids_resolve_conversation
BEFORE INSERT OR UPDATE OF conversation_id, group_id ON telegram_group_message_ids
FOR EACH ROW EXECUTE FUNCTION resolve_timeline_alias_conversation();

CREATE INDEX telegram_group_message_ids_entry_conversation
  ON telegram_group_message_ids (entry_id, conversation_id);

-- The existing cursor column now serves every application conversation, despite its historical name.
ALTER TABLE conversation_sessions
  DROP CONSTRAINT conversation_sessions_group_cursor_scope;

-- A participant is a group-local Telegram identity. User linkage is optional and is derived only
-- from the immutable numeric Telegram user ID, never username or display name.
CREATE TABLE conversation_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_ref text NOT NULL UNIQUE DEFAULT ('part_' || encode(gen_random_bytes(16), 'hex')),
  conversation_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  telegram_user_id text NOT NULL CHECK (char_length(telegram_user_id) > 0),
  linked_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name_snapshot text,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_participants_ref_format
    CHECK (participant_ref ~ '^part_[0-9a-f]{32}$'),
  CONSTRAINT conversation_participants_observed_order
    CHECK (last_observed_at >= first_observed_at),
  FOREIGN KEY (conversation_id, family_id, scope, scope_partition_key)
    REFERENCES application_conversations (id, family_id, scope, scope_partition_key)
    ON DELETE CASCADE,
  UNIQUE (conversation_id, telegram_user_id),
  UNIQUE (id, conversation_id),
  UNIQUE (id, conversation_id, family_id, scope, scope_partition_key)
);

CREATE INDEX conversation_participants_linked_user
  ON conversation_participants (linked_user_id) WHERE linked_user_id IS NOT NULL;

-- Distinct Telegram users observed in the application timeline become participants. The latest
-- display label is presentation metadata; exact users.telegram_user_id equality is the sole link.
WITH observed AS (
  SELECT conversation.id AS conversation_id,
         conversation.family_id,
         conversation.scope,
         conversation.scope_partition_key,
         message.telegram_user_id,
         (array_agg(message.sender_display_name ORDER BY message.sequence_id DESC)
            FILTER (WHERE message.sender_display_name IS NOT NULL))[1] AS display_name_snapshot,
         min(message.sent_at) AS first_observed_at,
         max(message.sent_at) AS last_observed_at
  FROM application_conversations AS conversation
  JOIN telegram_group_messages AS message
    ON message.conversation_id = conversation.id
  WHERE message.actor_kind = 'user'
    AND message.telegram_user_id IS NOT NULL
  GROUP BY conversation.id, conversation.family_id, conversation.scope,
           conversation.scope_partition_key, message.telegram_user_id
)
INSERT INTO conversation_participants
  (conversation_id, family_id, scope, scope_partition_key, telegram_user_id, linked_user_id,
   display_name_snapshot, first_observed_at, last_observed_at)
SELECT observed.conversation_id,
       observed.family_id,
       observed.scope,
       observed.scope_partition_key,
       observed.telegram_user_id,
       app_user.id,
       observed.display_name_snapshot,
       observed.first_observed_at,
       observed.last_observed_at
FROM observed
LEFT JOIN users AS app_user ON app_user.telegram_user_id = observed.telegram_user_id;

-- Claims gain a durable trust-zone partition, minimal lifecycle, honest provenance state, and
-- verified subject links. Existing rows remain active but explicitly unresolved and unendorsed.
CREATE TYPE memory_claim_status AS ENUM ('active', 'superseded', 'duplicate');
CREATE TYPE memory_provenance_state AS ENUM ('legacy_unresolved', 'evidenced');

ALTER TABLE memory_items
  ADD COLUMN scope_partition_key uuid GENERATED ALWAYS AS (
    CASE scope
      WHEN 'personal' THEN owner_user_id
      WHEN 'family' THEN family_id
      WHEN 'group' THEN group_id
    END
  ) STORED,
  ADD COLUMN claim_status memory_claim_status NOT NULL DEFAULT 'active',
  ADD COLUMN provenance_state memory_provenance_state NOT NULL DEFAULT 'legacy_unresolved',
  ADD COLUMN origin_conversation_id uuid,
  ADD COLUMN subject_family_id uuid REFERENCES families(id) ON DELETE SET NULL,
  ADD COLUMN subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN subject_participant_id uuid,
  ADD COLUMN subject_conversation_id uuid,
  ADD COLUMN subject_label text,
  ADD COLUMN save_approved boolean,
  ADD COLUMN endorsed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN endorsed_at timestamptz,
  ADD COLUMN superseded_by uuid,
  ADD COLUMN duplicate_of uuid,
  ADD COLUMN content_normalized text,
  ADD CONSTRAINT memory_items_endorsement_shape CHECK (
    (endorsed_by_user_id IS NULL) = (endorsed_at IS NULL)
  ),
  ADD CONSTRAINT memory_items_subject_shape CHECK (
    num_nonnulls(subject_family_id, subject_user_id, subject_participant_id) <= 1 AND
    (subject_family_id IS NULL OR subject_family_id = family_id) AND
    ((subject_participant_id IS NULL AND subject_conversation_id IS NULL) OR
     (subject_participant_id IS NOT NULL AND subject_conversation_id = origin_conversation_id))
  ),
  ADD CONSTRAINT memory_items_lifecycle_shape CHECK (
    (claim_status = 'active' AND superseded_by IS NULL AND duplicate_of IS NULL) OR
    (claim_status = 'superseded' AND superseded_by IS NOT NULL AND duplicate_of IS NULL) OR
    (claim_status = 'duplicate' AND superseded_by IS NULL AND duplicate_of IS NOT NULL)
  );

ALTER TABLE memory_items
  ADD CONSTRAINT memory_items_partition_identity
    UNIQUE NULLS NOT DISTINCT (id, family_id, scope, scope_partition_key),
  ADD CONSTRAINT memory_items_origin_conversation_fk
    FOREIGN KEY (origin_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES application_conversations (id, family_id, scope, scope_partition_key),
  ADD CONSTRAINT memory_items_subject_participant_fk
    FOREIGN KEY (subject_participant_id, subject_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES conversation_participants (id, conversation_id, family_id, scope, scope_partition_key),
  ADD CONSTRAINT memory_items_superseded_partition_fk
    FOREIGN KEY (superseded_by, family_id, scope, scope_partition_key)
    REFERENCES memory_items (id, family_id, scope, scope_partition_key),
  ADD CONSTRAINT memory_items_duplicate_partition_fk
    FOREIGN KEY (duplicate_of, family_id, scope, scope_partition_key)
    REFERENCES memory_items (id, family_id, scope, scope_partition_key);

CREATE INDEX memory_items_origin_conversation
  ON memory_items (origin_conversation_id) WHERE origin_conversation_id IS NOT NULL;
CREATE INDEX memory_items_author_user
  ON memory_items (author_user_id) WHERE author_user_id IS NOT NULL;
CREATE INDEX memory_items_owner_user
  ON memory_items (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX memory_items_group
  ON memory_items (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX memory_items_endorsed_by_user
  ON memory_items (endorsed_by_user_id) WHERE endorsed_by_user_id IS NOT NULL;
CREATE INDEX memory_items_subject_family
  ON memory_items (subject_family_id) WHERE subject_family_id IS NOT NULL;
CREATE INDEX memory_items_subject_user
  ON memory_items (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX memory_items_subject_participant
  ON memory_items (subject_participant_id) WHERE subject_participant_id IS NOT NULL;
CREATE INDEX memory_items_superseded_by
  ON memory_items (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX memory_items_duplicate_of
  ON memory_items (duplicate_of) WHERE duplicate_of IS NOT NULL;

-- Composite trust-zone FKs include a generated partition column, for which PostgreSQL forbids
-- referential SET NULL actions. Explicit pre-delete cleanup preserves family claims while clearing
-- only nullable conversation/participant identity before the owning chat cascades.
CREATE FUNCTION clear_memory_conversation_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memory_items
  SET origin_conversation_id = NULL,
      subject_participant_id = NULL,
      subject_conversation_id = NULL
  WHERE origin_conversation_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER application_conversations_clear_memory_references
BEFORE DELETE ON application_conversations
FOR EACH ROW EXECUTE FUNCTION clear_memory_conversation_references();

CREATE FUNCTION clear_memory_participant_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memory_items
  SET subject_participant_id = NULL,
      subject_conversation_id = NULL
  WHERE subject_participant_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER conversation_participants_clear_memory_references
BEFORE DELETE ON conversation_participants
FOR EACH ROW EXECUTE FUNCTION clear_memory_participant_references();

CREATE FUNCTION clear_memory_lifecycle_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memory_items
  SET claim_status = 'active', superseded_by = NULL
  WHERE superseded_by = OLD.id;
  UPDATE memory_items
  SET claim_status = 'active', duplicate_of = NULL
  WHERE duplicate_of = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER memory_items_clear_lifecycle_references
BEFORE DELETE ON memory_items
FOR EACH ROW EXECUTE FUNCTION clear_memory_lifecycle_references();

-- Timeline composite identity lets provenance keep group metadata while its nullable full-entry link
-- is cleared independently by normal timeline pruning.
ALTER TABLE telegram_group_messages
  ADD CONSTRAINT telegram_group_messages_id_group_unique UNIQUE (id, group_id);

CREATE TABLE claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  evidence_role text NOT NULL CHECK (evidence_role IN ('primary', 'supporting', 'reinforcement')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('firsthand', 'reported', 'inferred')),
  origin_conversation_id uuid NOT NULL,
  origin_conversation_label_snapshot text NOT NULL CHECK (char_length(origin_conversation_label_snapshot) > 0),
  origin_telegram_group_id uuid,
  author_participant_id uuid,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_label_snapshot text,
  observed_at timestamptz NOT NULL,
  evidence_snippet text NOT NULL CHECK (char_length(evidence_snippet) BETWEEN 1 AND 1000),
  timeline_entry_id uuid,
  timeline_sequence bigint NOT NULL CHECK (timeline_sequence > 0),
  source_message_id bigint CHECK (source_message_id > 0),
  message_thread_id bigint CHECK (message_thread_id > 0),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_evidence_author_present CHECK (
    author_participant_id IS NOT NULL OR author_user_id IS NOT NULL
  ),
  CONSTRAINT claim_evidence_origin_transport_shape CHECK (
    (scope = 'personal' AND origin_telegram_group_id IS NULL) OR
    (scope IN ('family', 'group') AND origin_telegram_group_id IS NOT NULL)
  ),
  FOREIGN KEY (claim_id, family_id, scope, scope_partition_key)
    REFERENCES memory_items (id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (origin_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES application_conversations (id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  FOREIGN KEY (origin_conversation_id, origin_telegram_group_id)
    REFERENCES application_conversations (id, telegram_group_id) ON DELETE CASCADE,
  FOREIGN KEY (author_participant_id, origin_conversation_id, family_id, scope, scope_partition_key)
    REFERENCES conversation_participants (id, conversation_id, family_id, scope, scope_partition_key),
  FOREIGN KEY (timeline_entry_id, origin_conversation_id)
    REFERENCES telegram_group_messages (id, conversation_id) ON DELETE SET NULL (timeline_entry_id)
);

CREATE UNIQUE INDEX claim_evidence_one_primary
  ON claim_evidence (claim_id) WHERE evidence_role = 'primary';
CREATE INDEX claim_evidence_claim_observed
  ON claim_evidence (claim_id, observed_at, id);
CREATE INDEX claim_evidence_origin_conversation
  ON claim_evidence (origin_conversation_id);
CREATE INDEX claim_evidence_author_participant
  ON claim_evidence (author_participant_id) WHERE author_participant_id IS NOT NULL;
CREATE INDEX claim_evidence_author_user
  ON claim_evidence (author_user_id) WHERE author_user_id IS NOT NULL;
CREATE INDEX claim_evidence_timeline_entry
  ON claim_evidence (timeline_entry_id, origin_conversation_id)
  WHERE timeline_entry_id IS NOT NULL;

-- Evidence authors must equal the exact optional user link of their verified local participant.
-- Claims with evidence are explicitly evidenced; a model-confidence or legacy flag is insufficient.
CREATE FUNCTION validate_claim_evidence_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_user uuid;
  claim_provenance memory_provenance_state;
BEGIN
  SELECT provenance_state INTO claim_provenance FROM memory_items WHERE id = NEW.claim_id;
  IF claim_provenance IS DISTINCT FROM 'evidenced'::memory_provenance_state THEN
    RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_PROVENANCE_INVALID: claim must be evidenced';
  END IF;

  IF NEW.author_participant_id IS NOT NULL THEN
    SELECT linked_user_id INTO linked_user
    FROM conversation_participants
    WHERE id = NEW.author_participant_id;
    IF NEW.author_user_id IS DISTINCT FROM linked_user THEN
      RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_AUTHOR_LINK_INVALID: author user link is not exact';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER claim_evidence_validate_identity
BEFORE INSERT OR UPDATE ON claim_evidence
FOR EACH ROW EXECUTE FUNCTION validate_claim_evidence_identity();

-- A claim may have no evidence (legacy/erased) or exactly one primary plus any supporting and
-- reinforcement rows. Deferral permits a whole normalized source set to be written atomically.
CREATE FUNCTION require_claim_evidence_primary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_claim_id uuid;
BEGIN
  affected_claim_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_id ELSE NEW.claim_id END;
  IF EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = affected_claim_id)
     AND NOT EXISTS (
       SELECT 1 FROM claim_evidence
       WHERE claim_id = affected_claim_id AND evidence_role = 'primary'
     ) THEN
    RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_PRIMARY_MISSING: evidence set requires one primary';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER claim_evidence_require_primary
AFTER INSERT OR UPDATE OR DELETE ON claim_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_claim_evidence_primary();

-- Privacy erasure may remove the final source while a family claim survives. Its state and origin
-- must become honestly unresolved instead of implying that deleted provenance is still available.
CREATE FUNCTION clear_claim_provenance_without_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = OLD.claim_id) THEN
    UPDATE memory_items
    SET provenance_state = 'legacy_unresolved',
        origin_conversation_id = NULL,
        subject_participant_id = NULL,
        subject_conversation_id = NULL
    WHERE id = OLD.claim_id;
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER claim_evidence_clear_empty_provenance
AFTER DELETE ON claim_evidence
FOR EACH ROW EXECUTE FUNCTION clear_claim_provenance_without_evidence();

-- Temporary extraction snapshots copy exactly the bounded model input before a cursor can advance or
-- timeline pruning can delete full entries. Terminal erasure nulls copied content but retains hashes,
-- range diagnostics, and source coordinates needed for audit.
CREATE TABLE memory_extraction_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  family_id uuid NOT NULL,
  scope memory_scope NOT NULL,
  scope_partition_key uuid NOT NULL,
  application_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  caller_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  caller_telegram_user_id text CHECK (
    caller_telegram_user_id IS NULL OR caller_telegram_user_id ~ '^[1-9][0-9]*$'
  ),
  turn_id text NOT NULL CHECK (char_length(turn_id) > 0),
  extractor_version text NOT NULL CHECK (char_length(extractor_version) BETWEEN 1 AND 120),
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 120),
  request_identity_hash text NOT NULL CHECK (request_identity_hash ~ '^[0-9a-f]{64}$'),
  input_payload_hash text NOT NULL CHECK (input_payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'completed', 'completed_empty', 'failed')),
  snapshot_erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, family_id, scope, scope_partition_key)
    REFERENCES application_conversations (id, family_id, scope, scope_partition_key) ON DELETE CASCADE,
  CONSTRAINT memory_extraction_batch_caller_shape CHECK (
    caller_user_id IS NULL OR caller_telegram_user_id IS NOT NULL
  ),
  UNIQUE (conversation_id, turn_id, extractor_version, schema_version),
  UNIQUE (id, conversation_id),
  UNIQUE (id, conversation_id, family_id, scope, scope_partition_key)
);

CREATE TABLE memory_extraction_ranges (
  batch_id uuid PRIMARY KEY REFERENCES memory_extraction_batches(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  first_sequence bigint NOT NULL CHECK (first_sequence > 0),
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  omitted_before_sequence bigint CHECK (omitted_before_sequence >= 0),
  message_thread_id bigint CHECK (message_thread_id > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'completed', 'completed_empty', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, conversation_id)
    REFERENCES memory_extraction_batches (id, conversation_id) ON DELETE CASCADE
);

CREATE INDEX memory_extraction_batches_application_session
  ON memory_extraction_batches (application_session_id)
  WHERE application_session_id IS NOT NULL;
CREATE INDEX memory_extraction_batches_caller_user
  ON memory_extraction_batches (caller_user_id) WHERE caller_user_id IS NOT NULL;

CREATE TABLE memory_extraction_snapshot_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  timeline_entry_id uuid,
  timeline_entry_id_snapshot uuid NOT NULL,
  telegram_group_id uuid,
  source_ref text NOT NULL DEFAULT ('src_' || encode(gen_random_bytes(16), 'hex'))
    CHECK (source_ref ~ '^src_[0-9a-f]{32}$'),
  sequence_id bigint NOT NULL CHECK (sequence_id > 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent_self')),
  author_participant_id uuid,
  actor_label_snapshot text,
  observed_at timestamptz NOT NULL,
  content_text text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  message_thread_id bigint CHECK (message_thread_id > 0),
  reply_to_sequence_id bigint CHECK (reply_to_sequence_id > 0),
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_extraction_snapshot_erasure_shape CHECK (
    erased_at IS NULL OR content_text IS NULL
  ),
  FOREIGN KEY (batch_id, conversation_id)
    REFERENCES memory_extraction_batches (id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages (id, conversation_id) ON DELETE SET NULL (timeline_entry_id),
  FOREIGN KEY (author_participant_id, conversation_id)
    REFERENCES conversation_participants (id, conversation_id),
  UNIQUE (batch_id, ordinal),
  UNIQUE (batch_id, sequence_id),
  UNIQUE (batch_id, source_ref),
  UNIQUE (id, batch_id)
);

CREATE INDEX memory_extraction_snapshot_timeline_entry
  ON memory_extraction_snapshot_entries (timeline_entry_id, conversation_id)
  WHERE timeline_entry_id IS NOT NULL;
CREATE INDEX memory_extraction_snapshot_author_participant
  ON memory_extraction_snapshot_entries (author_participant_id, conversation_id)
  WHERE author_participant_id IS NOT NULL;

-- One explicit attempt is active at a time. Expired leases become terminal failures; only an
-- operator action may safely reset an unstarted call or create the next bounded attempt.
CREATE TABLE memory_extraction_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES memory_extraction_batches(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'completed', 'completed_empty', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_call_started_at timestamptz,
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  partial_results boolean NOT NULL DEFAULT false,
  candidate_count integer CHECK (candidate_count >= 0),
  output_payload_hash text CHECK (output_payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT memory_extraction_jobs_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT memory_extraction_jobs_result_shape CHECK (
    (status = 'completed' AND candidate_count > 0 AND output_payload_hash IS NOT NULL AND completed_at IS NOT NULL) OR
    (status = 'completed_empty' AND candidate_count = 0 AND output_payload_hash IS NOT NULL AND completed_at IS NOT NULL AND partial_results = false) OR
    (status = 'failed' AND diagnostic_code IS NOT NULL AND completed_at IS NOT NULL AND candidate_count IS NULL AND output_payload_hash IS NULL) OR
    (status IN ('pending', 'leased') AND candidate_count IS NULL AND output_payload_hash IS NULL AND completed_at IS NULL)
  ),
  CONSTRAINT memory_extraction_jobs_partial_diagnostic CHECK (
    partial_results = false OR (status = 'completed' AND diagnostic_code IS NOT NULL)
  ),
  UNIQUE (batch_id, attempt),
  UNIQUE (id, batch_id)
);

CREATE UNIQUE INDEX memory_extraction_jobs_one_active
  ON memory_extraction_jobs (batch_id) WHERE status IN ('pending', 'leased');
CREATE INDEX memory_extraction_jobs_claim
  ON memory_extraction_jobs (status, created_at, id);

CREATE TABLE memory_extraction_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES memory_extraction_batches(id) ON DELETE CASCADE,
  candidate_id text NOT NULL CHECK (candidate_id ~ '^cand_[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 120),
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  content text CHECK (content IS NULL OR char_length(content) BETWEEN 1 AND 4000),
  content_erased_at timestamptz,
  kind memory_kind NOT NULL,
  sensitivity memory_sensitivity NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('firsthand', 'reported', 'inferred')),
  subject_participant_ref text CHECK (
    subject_participant_ref IS NULL OR subject_participant_ref ~ '^part_[0-9a-f]{32}$'
  ),
  subject_label text CHECK (subject_label IS NULL OR char_length(subject_label) BETWEEN 1 AND 200),
  resolution_status text NOT NULL DEFAULT 'pending'
    CHECK (resolution_status IN (
      'pending', 'approval_pending', 'claim_created', 'reinforced', 'rejected'
    )),
  resolved_claim_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  resolution_diagnostic_code text CHECK (
    resolution_diagnostic_code IS NULL OR resolution_diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'
  ),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_extraction_candidate_erasure_shape CHECK (
    (content IS NULL) = (content_erased_at IS NOT NULL)
  ),
  CONSTRAINT memory_extraction_candidate_resolution_shape CHECK (
    (resolution_status IN ('pending', 'approval_pending') AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NULL AND resolved_at IS NULL) OR
    (resolution_status IN ('claim_created', 'reinforced')
      AND resolution_diagnostic_code IS NULL AND resolved_at IS NOT NULL) OR
    (resolution_status = 'rejected' AND resolved_claim_id IS NULL
      AND resolution_diagnostic_code IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  FOREIGN KEY (job_id, batch_id)
    REFERENCES memory_extraction_jobs (id, batch_id) ON DELETE CASCADE,
  UNIQUE (job_id, candidate_id, schema_version),
  UNIQUE (operation_key),
  UNIQUE (id, batch_id)
);

CREATE TABLE memory_extraction_candidate_sources (
  candidate_row_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  snapshot_entry_id uuid NOT NULL,
  source_role text NOT NULL CHECK (source_role IN ('primary', 'supporting')),
  source_order integer NOT NULL CHECK (source_order >= 0),
  PRIMARY KEY (candidate_row_id, snapshot_entry_id),
  FOREIGN KEY (candidate_row_id, batch_id)
    REFERENCES memory_extraction_candidates (id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_entry_id, batch_id)
    REFERENCES memory_extraction_snapshot_entries (id, batch_id) ON DELETE RESTRICT
);

CREATE INDEX memory_extraction_candidates_batch
  ON memory_extraction_candidates (batch_id);
CREATE INDEX memory_extraction_candidates_resolved_claim
  ON memory_extraction_candidates (resolved_claim_id) WHERE resolved_claim_id IS NOT NULL;

CREATE UNIQUE INDEX memory_extraction_candidate_one_primary
  ON memory_extraction_candidate_sources (candidate_row_id) WHERE source_role = 'primary';
CREATE UNIQUE INDEX memory_extraction_candidate_source_order
  ON memory_extraction_candidate_sources (candidate_row_id, source_role, source_order);
CREATE INDEX memory_extraction_candidate_sources_snapshot
  ON memory_extraction_candidate_sources (snapshot_entry_id, batch_id);

-- Every durable batch starts with exactly one pending attempt; this remains separate from the
-- conversation cursor and session lifecycle.
CREATE FUNCTION create_memory_extraction_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO memory_extraction_jobs (batch_id, attempt) VALUES (NEW.id, 1);
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_extraction_batches_create_job
AFTER INSERT ON memory_extraction_batches
FOR EACH ROW EXECUTE FUNCTION create_memory_extraction_job();

-- Eve streams are replayable. This cursor is advanced only with successful ingress completion so a
-- previous session.waiting event cannot release a later Telegram update.
CREATE TABLE eve_session_event_cursors (
  eve_session_id text PRIMARY KEY CHECK (char_length(eve_session_id) > 0),
  next_event_index bigint NOT NULL CHECK (next_event_index >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Exact entry coverage, not the conversation context cursor, owns extraction progress. Versions are
-- part of identity so a reviewed extractor/schema revision can intentionally process the same turn.
CREATE TABLE memory_extraction_entry_coverage (
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  timeline_entry_id_snapshot uuid NOT NULL,
  timeline_sequence bigint NOT NULL CHECK (timeline_sequence > 0),
  extractor_version text NOT NULL CHECK (char_length(extractor_version) BETWEEN 1 AND 120),
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 120),
  batch_id uuid NOT NULL REFERENCES memory_extraction_batches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    conversation_id, timeline_entry_id_snapshot, extractor_version, schema_version
  )
);

CREATE INDEX memory_extraction_entry_coverage_batch
  ON memory_extraction_entry_coverage (batch_id);

CREATE TABLE conversation_extraction_cursors (
  conversation_id uuid PRIMARY KEY REFERENCES application_conversations(id) ON DELETE CASCADE,
  last_covered_sequence bigint NOT NULL DEFAULT 0 CHECK (last_covered_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO conversation_extraction_cursors (conversation_id)
SELECT id FROM application_conversations;

CREATE FUNCTION create_conversation_extraction_cursor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO conversation_extraction_cursors (conversation_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;

CREATE TRIGGER application_conversations_create_extraction_cursor
AFTER INSERT ON application_conversations
FOR EACH ROW EXECUTE FUNCTION create_conversation_extraction_cursor();

-- Every closed model decision is durable, including skip and ambiguity. Only save/approval rows own
-- a candidate row; semantic usefulness is never reconstructed with keyword or length heuristics.
CREATE TABLE memory_extraction_semantic_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  action text NOT NULL CHECK (action IN ('save', 'skip', 'needs_approval', 'ambiguous')),
  primary_snapshot_entry_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  candidate_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, batch_id)
    REFERENCES memory_extraction_jobs(id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY (primary_snapshot_entry_id, batch_id)
    REFERENCES memory_extraction_snapshot_entries(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_row_id, batch_id)
    REFERENCES memory_extraction_candidates(id, batch_id) ON DELETE CASCADE,
  UNIQUE (job_id, ordinal),
  CHECK (
    (action IN ('save', 'needs_approval') AND candidate_row_id IS NOT NULL) OR
    (action IN ('skip', 'ambiguous') AND candidate_row_id IS NULL)
  )
);

-- Sensitive candidates wait for a future authorized interaction and are never auto-saved.
CREATE TABLE memory_extraction_approval_notices (
  candidate_row_id uuid PRIMARY KEY REFERENCES memory_extraction_candidates(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);

CREATE INDEX memory_extraction_semantic_results_primary_snapshot
  ON memory_extraction_semantic_results (primary_snapshot_entry_id, batch_id)
  WHERE primary_snapshot_entry_id IS NOT NULL;
CREATE INDEX memory_extraction_semantic_results_candidate
  ON memory_extraction_semantic_results (candidate_row_id, batch_id)
  WHERE candidate_row_id IS NOT NULL;
CREATE INDEX memory_extraction_approval_notices_family
  ON memory_extraction_approval_notices (family_id);
CREATE INDEX memory_extraction_approval_notices_conversation
  ON memory_extraction_approval_notices (conversation_id);

-- Candidate and timeline plaintext is retained only while some candidate still needs processing or
-- a human decision. The last terminal transition erases the whole immutable extraction snapshot.
CREATE FUNCTION erase_terminal_memory_extraction_plaintext(affected_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memory_extraction_batches
    WHERE id = affected_batch_id AND status IN ('completed', 'completed_empty')
  ) OR EXISTS (
    SELECT 1 FROM memory_extraction_jobs
    WHERE batch_id = affected_batch_id AND status IN ('pending', 'leased')
  ) OR EXISTS (
    SELECT 1 FROM memory_extraction_candidates
    WHERE batch_id = affected_batch_id
      AND resolution_status IN ('pending', 'approval_pending', 'consolidation_pending')
  ) THEN
    RETURN;
  END IF;

  UPDATE memory_extraction_candidates
  SET content = NULL, content_erased_at = coalesce(content_erased_at, now())
  WHERE batch_id = affected_batch_id AND content IS NOT NULL;
  UPDATE memory_extraction_snapshot_entries
  SET content_text = NULL, erased_at = coalesce(erased_at, now())
  WHERE batch_id = affected_batch_id AND content_text IS NOT NULL;
  UPDATE memory_extraction_batches
  SET snapshot_erased_at = coalesce(snapshot_erased_at, now()), updated_at = now()
  WHERE id = affected_batch_id;
END
$$;

CREATE FUNCTION erase_memory_extraction_after_candidate_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erase_terminal_memory_extraction_plaintext(NEW.batch_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_extraction_candidates_erase_terminal_plaintext
AFTER UPDATE OF resolution_status ON memory_extraction_candidates
FOR EACH ROW
WHEN (NEW.resolution_status IN (
  'claim_created', 'reinforced', 'duplicate', 'conflict', 'ambiguous', 'rejected'
))
EXECUTE FUNCTION erase_memory_extraction_after_candidate_terminal();

CREATE FUNCTION erase_memory_extraction_after_batch_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM erase_terminal_memory_extraction_plaintext(NEW.id);
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_extraction_batches_erase_terminal_plaintext
AFTER UPDATE OF status ON memory_extraction_batches
FOR EACH ROW
WHEN (NEW.status IN ('completed', 'completed_empty'))
EXECUTE FUNCTION erase_memory_extraction_after_batch_terminal();
