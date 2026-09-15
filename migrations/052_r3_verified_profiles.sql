-- R3 subjects are conversation-local read identities. Claims remain the only durable memory facts;
-- profile subjects and views never become a second writable profile store.
ALTER TABLE application_conversations
  ADD CONSTRAINT application_conversations_id_family_unique UNIQUE (id, family_id);

ALTER TABLE memory_items
  ADD COLUMN profile_eligible boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT memory_items_profile_eligibility_shape CHECK (
    profile_eligible = false OR (
      provenance_state = 'evidenced' AND
      num_nonnulls(subject_user_id, subject_participant_id) = 1
    )
  );

-- R2 privacy cleanup clears nullable subject/provenance links. R3 must first retire those claims
-- from profile selection so the stricter verified-subject invariant never blocks deletion.
CREATE OR REPLACE FUNCTION clear_memory_conversation_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memory_items
  SET origin_conversation_id = NULL,
      subject_participant_id = NULL,
      subject_conversation_id = NULL,
      profile_eligible = false
  WHERE origin_conversation_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION clear_memory_participant_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memory_items
  SET subject_participant_id = NULL,
      subject_conversation_id = NULL,
      profile_eligible = false
  WHERE subject_participant_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION clear_claim_provenance_without_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = OLD.claim_id) THEN
    UPDATE memory_items
    SET provenance_state = 'legacy_unresolved',
        origin_conversation_id = NULL,
        subject_participant_id = NULL,
        subject_conversation_id = NULL,
        profile_eligible = false
    WHERE id = OLD.claim_id;
  END IF;
  RETURN OLD;
END
$$;

CREATE FUNCTION retire_profile_claims_for_deleted_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memory_items SET profile_eligible = false WHERE subject_user_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER users_retire_profile_claims
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION retire_profile_claims_for_deleted_user();

CREATE TABLE profile_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_ref text NOT NULL UNIQUE DEFAULT ('subj_' || encode(gen_random_bytes(16), 'hex')),
  conversation_id uuid NOT NULL,
  family_id uuid NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  subject_participant_id uuid,
  subject_conversation_id uuid,
  display_label_snapshot text NOT NULL CHECK (char_length(display_label_snapshot) BETWEEN 1 AND 200),
  last_verified_at timestamptz NOT NULL,
  dormant_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_subjects_ref_format CHECK (subject_ref ~ '^subj_[0-9a-f]{32}$'),
  CONSTRAINT profile_subjects_identity_shape CHECK (
    num_nonnulls(subject_user_id, subject_participant_id) = 1 AND
    ((subject_user_id IS NOT NULL AND subject_conversation_id IS NULL) OR
     (subject_participant_id IS NOT NULL AND subject_conversation_id = conversation_id))
  ),
  CONSTRAINT profile_subjects_dormancy_order CHECK (
    dormant_at IS NULL OR dormant_at >= last_verified_at
  ),
  FOREIGN KEY (conversation_id, family_id)
    REFERENCES application_conversations(id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_participant_id, subject_conversation_id)
    REFERENCES conversation_participants(id, conversation_id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (conversation_id, subject_user_id, subject_participant_id)
);

CREATE INDEX profile_subjects_subject_user
  ON profile_subjects (subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX profile_subjects_subject_participant
  ON profile_subjects (subject_participant_id, subject_conversation_id)
  WHERE subject_participant_id IS NOT NULL;

-- Verified observations reactivate a subject. Scope decides whether the durable key is an
-- application user (personal/family) or a strictly chat-local participant (external group).
CREATE FUNCTION sync_profile_subject_from_participant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conversation_scope memory_scope;
BEGIN
  SELECT scope INTO conversation_scope
  FROM application_conversations WHERE id = NEW.conversation_id;

  IF conversation_scope = 'group' THEN
    INSERT INTO profile_subjects
      (conversation_id, family_id, subject_participant_id, subject_conversation_id,
       display_label_snapshot, last_verified_at)
    VALUES (
      NEW.conversation_id,
      NEW.family_id,
      NEW.id,
      NEW.conversation_id,
      coalesce(NEW.display_name_snapshot, 'Участник Telegram'),
      NEW.last_observed_at
    )
    ON CONFLICT (conversation_id, subject_user_id, subject_participant_id)
    DO UPDATE SET
      display_label_snapshot = EXCLUDED.display_label_snapshot,
      last_verified_at = greatest(profile_subjects.last_verified_at, EXCLUDED.last_verified_at),
      dormant_at = NULL,
      updated_at = now();
  ELSIF NEW.linked_user_id IS NOT NULL THEN
    INSERT INTO profile_subjects
      (conversation_id, family_id, subject_user_id, display_label_snapshot, last_verified_at)
    VALUES (
      NEW.conversation_id,
      NEW.family_id,
      NEW.linked_user_id,
      coalesce(NEW.display_name_snapshot, 'Участник семьи'),
      NEW.last_observed_at
    )
    ON CONFLICT (conversation_id, subject_user_id, subject_participant_id)
    DO UPDATE SET
      display_label_snapshot = EXCLUDED.display_label_snapshot,
      last_verified_at = greatest(profile_subjects.last_verified_at, EXCLUDED.last_verified_at),
      dormant_at = NULL,
      updated_at = now();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversation_participants_sync_profile_subject
AFTER INSERT OR UPDATE OF linked_user_id, display_name_snapshot, last_observed_at
ON conversation_participants
FOR EACH ROW EXECUTE FUNCTION sync_profile_subject_from_participant();

INSERT INTO profile_subjects
  (conversation_id, family_id, subject_user_id, subject_participant_id,
   subject_conversation_id, display_label_snapshot, last_verified_at)
SELECT participant.conversation_id,
       participant.family_id,
       CASE WHEN conversation.scope IN ('personal', 'family')
            THEN participant.linked_user_id ELSE NULL END,
       CASE WHEN conversation.scope = 'group' THEN participant.id ELSE NULL END,
       CASE WHEN conversation.scope = 'group' THEN participant.conversation_id ELSE NULL END,
       coalesce(participant.display_name_snapshot, 'Участник Telegram'),
       participant.last_observed_at
FROM conversation_participants AS participant
JOIN application_conversations AS conversation ON conversation.id = participant.conversation_id
WHERE conversation.scope = 'group' OR participant.linked_user_id IS NOT NULL;

-- Every external group has a stable opaque owner-facing ref and a fail-closed self-projection policy.
CREATE TABLE external_profile_projection_policies (
  group_id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_ref text NOT NULL UNIQUE DEFAULT ('grp_' || encode(gen_random_bytes(16), 'hex')),
  enabled boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_profile_projection_group_ref_format
    CHECK (group_ref ~ '^grp_[0-9a-f]{32}$'),
  FOREIGN KEY (group_id, family_id)
    REFERENCES telegram_groups(id, family_id) ON DELETE CASCADE,
  UNIQUE (group_id, family_id)
);

CREATE TABLE external_profile_projection_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_ref text NOT NULL UNIQUE DEFAULT ('notice_' || encode(gen_random_bytes(16), 'hex')),
  group_id uuid NOT NULL,
  family_id uuid NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  enabled boolean NOT NULL,
  notice_text text NOT NULL CHECK (char_length(notice_text) BETWEEN 1 AND 1000),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  first_presented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_profile_projection_notice_ref_format
    CHECK (notice_ref ~ '^notice_[0-9a-f]{32}$'),
  FOREIGN KEY (group_id, family_id)
    REFERENCES external_profile_projection_policies(group_id, family_id) ON DELETE CASCADE,
  UNIQUE (group_id, policy_version)
);

CREATE TABLE external_profile_projection_policy_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  group_id uuid NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key),
  FOREIGN KEY (group_id, family_id)
    REFERENCES external_profile_projection_policies(group_id, family_id) ON DELETE CASCADE
);

CREATE INDEX external_profile_projection_policies_family
  ON external_profile_projection_policies (family_id);
CREATE INDEX external_profile_projection_policies_updated_by_user
  ON external_profile_projection_policies (updated_by_user_id)
  WHERE updated_by_user_id IS NOT NULL;
CREATE INDEX external_profile_projection_notices_created_by_user
  ON external_profile_projection_notices (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
CREATE INDEX external_profile_projection_policy_operations_group
  ON external_profile_projection_policy_operations (group_id, family_id);

CREATE FUNCTION create_external_profile_projection_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_notice text := 'Проекция сведений из этой внешней группы в личный профиль участника отключена. Владелец семьи может изменить политику только с явным уведомлением группы.';
BEGIN
  IF NEW.type = 'external' THEN
    INSERT INTO external_profile_projection_policies (group_id, family_id)
    VALUES (NEW.id, NEW.family_id);
    INSERT INTO external_profile_projection_notices
      (group_id, family_id, policy_version, enabled, notice_text)
    VALUES (NEW.id, NEW.family_id, 1, false, policy_notice);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_groups_create_external_profile_projection_policy
AFTER INSERT ON telegram_groups
FOR EACH ROW EXECUTE FUNCTION create_external_profile_projection_policy();

INSERT INTO external_profile_projection_policies (group_id, family_id)
SELECT id, family_id FROM telegram_groups WHERE type = 'external';

INSERT INTO external_profile_projection_notices
  (group_id, family_id, policy_version, enabled, notice_text)
SELECT policy.group_id,
       policy.family_id,
       policy.policy_version,
       false,
       'Проекция сведений из этой внешней группы в личный профиль участника отключена. Владелец семьи может изменить политику только с явным уведомлением группы.'
FROM external_profile_projection_policies AS policy;

-- A view is an immutable ordered read snapshot. Claim deletion cascades the selected row so erased
-- memory cannot survive in a historical view; readers detect an incomplete snapshot by claim_count.
CREATE TABLE profile_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_view_ref text NOT NULL UNIQUE DEFAULT ('view_' || encode(gen_random_bytes(16), 'hex')),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  viewer_conversation_id uuid NOT NULL,
  viewer_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  subject_count integer NOT NULL CHECK (subject_count BETWEEN 0 AND 4),
  claim_count integer NOT NULL CHECK (claim_count >= 0),
  total_characters integer NOT NULL CHECK (total_characters BETWEEN 0 AND 12000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_views_ref_format CHECK (profile_view_ref ~ '^view_[0-9a-f]{32}$'),
  FOREIGN KEY (viewer_conversation_id, family_id)
    REFERENCES application_conversations(id, family_id) ON DELETE CASCADE,
  UNIQUE (id, family_id)
);

CREATE TABLE profile_view_subjects (
  profile_view_id uuid NOT NULL REFERENCES profile_views(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
  profile_subject_id uuid REFERENCES profile_subjects(id) ON DELETE SET NULL,
  subject_ref_snapshot text NOT NULL CHECK (subject_ref_snapshot ~ '^subj_[0-9a-f]{32}$'),
  subject_label_snapshot text NOT NULL CHECK (char_length(subject_label_snapshot) BETWEEN 1 AND 200),
  priority_reason text NOT NULL CHECK (
    priority_reason IN ('current_author', 'reply_subject', 'explicit_mention', 'retrieval_related')
  ),
  total_characters integer NOT NULL CHECK (total_characters BETWEEN 0 AND 8000),
  PRIMARY KEY (profile_view_id, ordinal)
);

CREATE TABLE profile_view_claims (
  profile_view_id uuid NOT NULL,
  subject_ordinal integer NOT NULL,
  claim_ordinal integer NOT NULL CHECK (claim_ordinal BETWEEN 0 AND 29),
  claim_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  memory_ref_snapshot text NOT NULL CHECK (memory_ref_snapshot ~ '^mem_[0-9a-f]{32}$'),
  content_snapshot text NOT NULL CHECK (char_length(content_snapshot) BETWEEN 1 AND 4000),
  kind memory_kind NOT NULL,
  confirmation memory_confirmation NOT NULL,
  origin_scope memory_scope NOT NULL,
  origin_label_snapshot text NOT NULL CHECK (char_length(origin_label_snapshot) BETWEEN 1 AND 500),
  evidence_kind text NOT NULL CHECK (
    evidence_kind IN ('firsthand', 'reported', 'inferred', 'unresolved')
  ),
  observed_at timestamptz NOT NULL,
  source_author_label_snapshot text NOT NULL CHECK (
    char_length(source_author_label_snapshot) BETWEEN 1 AND 500
  ),
  rendered_characters integer NOT NULL CHECK (rendered_characters > 0),
  PRIMARY KEY (profile_view_id, subject_ordinal, claim_ordinal),
  FOREIGN KEY (profile_view_id, subject_ordinal)
    REFERENCES profile_view_subjects(profile_view_id, ordinal) ON DELETE CASCADE,
  UNIQUE (profile_view_id, claim_id)
);

CREATE INDEX profile_views_family ON profile_views (family_id);
CREATE INDEX profile_views_viewer_conversation
  ON profile_views (viewer_conversation_id, family_id);
CREATE INDEX profile_views_viewer_user
  ON profile_views (viewer_user_id) WHERE viewer_user_id IS NOT NULL;
CREATE INDEX profile_view_subjects_profile_subject
  ON profile_view_subjects (profile_subject_id) WHERE profile_subject_id IS NOT NULL;

CREATE INDEX profile_view_claims_claim
  ON profile_view_claims (claim_id);

-- Pending sensitive decisions receive a model-safe ref, are surfaced once, and retain the exact
-- verified actor and operation identity used to resolve them.
ALTER TABLE memory_extraction_approval_notices
  ADD COLUMN approval_ref text NOT NULL UNIQUE DEFAULT ('approval_' || encode(gen_random_bytes(16), 'hex')),
  ADD COLUMN notice_delivered_at timestamptz,
  ADD COLUMN resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN resolved_by_telegram_user_id text,
  ADD COLUMN decision_operation_key text,
  ADD CONSTRAINT memory_extraction_approval_ref_format
    CHECK (approval_ref ~ '^approval_[0-9a-f]{32}$'),
  ADD CONSTRAINT memory_extraction_approval_resolution_actor CHECK (
    (status = 'pending' AND resolved_by_user_id IS NULL
      AND resolved_by_telegram_user_id IS NULL AND decision_operation_key IS NULL) OR
    (status IN ('approved', 'rejected')
      AND (resolved_by_user_id IS NOT NULL OR resolved_by_telegram_user_id IS NOT NULL)
      AND decision_operation_key IS NOT NULL)
  );

CREATE INDEX memory_extraction_approval_notices_resolved_by_user
  ON memory_extraction_approval_notices (resolved_by_user_id)
  WHERE resolved_by_user_id IS NOT NULL;

CREATE TABLE memory_sensitive_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  approval_ref text NOT NULL UNIQUE REFERENCES memory_extraction_approval_notices(approval_ref)
    ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by_telegram_user_id text NOT NULL CHECK (char_length(decided_by_telegram_user_id) > 0),
  resolved_claim_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, operation_key)
);

CREATE INDEX memory_sensitive_approval_decisions_decided_by_user
  ON memory_sensitive_approval_decisions (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;
CREATE INDEX memory_sensitive_approval_decisions_resolved_claim
  ON memory_sensitive_approval_decisions (resolved_claim_id)
  WHERE resolved_claim_id IS NOT NULL;

-- The transport stores the exact approved Eve action, not only its visible Telegram presentation.
-- Pending pre-contract rows are expired because their later execution cannot be proven.
ALTER TABLE telegram_hitl_approvals
  ADD COLUMN tool_call_id text,
  ADD COLUMN tool_name text,
  ADD COLUMN tool_input_hash text;

UPDATE telegram_hitl_approvals SET consumed_at = coalesce(consumed_at, now())
WHERE consumed_at IS NULL;

ALTER TABLE telegram_hitl_approvals
  ADD CONSTRAINT telegram_hitl_tool_evidence_shape CHECK (
    (tool_call_id IS NULL AND tool_name IS NULL AND tool_input_hash IS NULL) OR
    (tool_call_id IS NOT NULL AND char_length(tool_call_id) > 0 AND
     tool_name IS NOT NULL AND char_length(tool_name) > 0 AND
     tool_input_hash ~ '^[0-9a-f]{64}$')
  );

CREATE INDEX telegram_hitl_approvals_tool_execution
  ON telegram_hitl_approvals (eve_session_id, tool_call_id, tool_name)
  WHERE consumed_at IS NOT NULL AND tool_call_id IS NOT NULL;
