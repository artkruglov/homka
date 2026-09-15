-- Application session roles are explicit. Existing personal conversations remain canonical, while
-- linked schedule runs are classified as scheduled before legacy group branches are processed.
CREATE TYPE conversation_session_kind AS ENUM ('canonical', 'task', 'scheduled', 'proactive');
CREATE TYPE conversation_task_state AS ENUM ('running', 'pending', 'completed', 'failed');

ALTER TABLE conversation_sessions
  ADD COLUMN kind conversation_session_kind NOT NULL DEFAULT 'canonical',
  ADD COLUMN task_state conversation_task_state,
  ADD COLUMN telegram_forum_topic_id bigint CHECK (telegram_forum_topic_id > 0),
  ADD COLUMN requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN requester_telegram_user_id text,
  ADD COLUMN originating_canonical_session_id uuid
    REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  ADD COLUMN pending_request_id text;

-- Existing HITL constraints should already guarantee positive topics. Validate explicitly so a
-- damaged legacy schema fails with an application diagnostic before any lifecycle row is changed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM conversation_sessions session
      JOIN telegram_hitl_approvals hitl ON hitl.application_session_id = session.id
     WHERE session.group_id IS NOT NULL
       AND session.pending_operation = true
       AND session.retired_at IS NULL
       AND hitl.consumed_at IS NULL
       AND (
         hitl.telegram_chat_id !~ '^-?[1-9][0-9]*$' OR
         (hitl.telegram_message_thread_id IS NOT NULL AND hitl.telegram_message_thread_id <= 0)
       )
  ) THEN
    RAISE EXCEPTION 'AGENT_MIGRATION_042_INVALID_TELEGRAM_ID: pending HITL route contains an invalid Telegram identifier';
  END IF;
END;
$$;

UPDATE conversation_sessions session
SET kind = 'scheduled',
    task_state = CASE
      WHEN session.retired_at IS NULL THEN 'running'::conversation_task_state
      ELSE 'completed'::conversation_task_state
    END
WHERE EXISTS (
  SELECT 1 FROM agent_schedule_runs run
  WHERE run.application_session_id = session.id
);

-- A pending legacy group branch contains the only safe resumable Eve state. Reclassify it in place
-- and retain requester/request identity only when an exact unconsumed Telegram prompt proves it.
UPDATE conversation_sessions session
SET kind = 'task',
    task_state = 'pending',
    telegram_forum_topic_id = (
      SELECT hitl.telegram_message_thread_id
      FROM telegram_hitl_approvals hitl
      WHERE hitl.application_session_id = session.id AND hitl.consumed_at IS NULL
      ORDER BY hitl.created_at, hitl.id
      LIMIT 1
    ),
    originating_canonical_session_id = session.id,
    pending_request_id = (
      SELECT hitl.request_id
      FROM telegram_hitl_approvals hitl
      WHERE hitl.application_session_id = session.id AND hitl.consumed_at IS NULL
      ORDER BY hitl.created_at, hitl.id
      LIMIT 1
    ),
    requester_telegram_user_id = (
      SELECT hitl.expected_telegram_user_id
      FROM telegram_hitl_approvals hitl
      WHERE hitl.application_session_id = session.id AND hitl.consumed_at IS NULL
      ORDER BY hitl.created_at, hitl.id
      LIMIT 1
    ),
    requester_user_id = (
      SELECT requester.id
      FROM telegram_hitl_approvals hitl
      JOIN users requester ON requester.telegram_user_id = hitl.expected_telegram_user_id
      WHERE hitl.application_session_id = session.id AND hitl.consumed_at IS NULL
      ORDER BY hitl.created_at, hitl.id
      LIMIT 1
    )
WHERE session.group_id IS NOT NULL
  AND session.pending_operation = true
  AND session.retired_at IS NULL
  AND session.kind = 'canonical'
  AND EXISTS (
    SELECT 1 FROM telegram_hitl_approvals hitl
    WHERE hitl.application_session_id = session.id AND hitl.consumed_at IS NULL
  );

-- Pending OAuth branches may not have a Telegram HITL row but still own parked Eve state.
-- Validate the exact Eve `chat:thread:conversation` shape instead of silently treating malformed
-- stored identifiers as the main topic or leaking PostgreSQL cast details.
DO $$
DECLARE
  legacy record;
  parsed_chat_id bigint;
  parsed_conversation_id bigint;
  parsed_topic_id bigint;
BEGIN
  FOR legacy IN
    SELECT id, conversation_key,
           split_part(conversation_key, ':', 1) AS chat_id,
           split_part(conversation_key, ':', 2) AS topic_id,
           split_part(conversation_key, ':', 3) AS conversation_id
      FROM conversation_sessions
     WHERE group_id IS NOT NULL
       AND pending_operation = true
       AND retired_at IS NULL
       AND kind = 'canonical'
  LOOP
    IF char_length(legacy.conversation_key) - char_length(replace(legacy.conversation_key, ':', '')) <> 2 OR
       legacy.chat_id !~ '^-?[1-9][0-9]*$' OR
       legacy.conversation_id !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'AGENT_MIGRATION_042_INVALID_TELEGRAM_ID: session % has malformed Telegram continuation token', legacy.id;
    END IF;
    BEGIN
      parsed_chat_id := legacy.chat_id::bigint;
      parsed_conversation_id := legacy.conversation_id::bigint;
      IF parsed_chat_id = 0 OR parsed_conversation_id <= 0 THEN
        RAISE numeric_value_out_of_range;
      END IF;
      IF legacy.topic_id <> '' THEN
        parsed_topic_id := legacy.topic_id::bigint;
        IF parsed_topic_id <= 0 THEN
          RAISE numeric_value_out_of_range;
        END IF;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'AGENT_MIGRATION_042_INVALID_TELEGRAM_ID: session % has an out-of-range Telegram identifier', legacy.id;
    END;
  END LOOP;
END;
$$;

UPDATE conversation_sessions
SET kind = 'task',
    task_state = 'pending',
    telegram_forum_topic_id = CASE
      WHEN split_part(conversation_key, ':', 2) = '' THEN NULL
      ELSE split_part(conversation_key, ':', 2)::bigint
    END,
    originating_canonical_session_id = id
WHERE group_id IS NOT NULL
  AND pending_operation = true
  AND retired_at IS NULL
  AND kind = 'canonical';

-- Exact unconsumed prompt aliases are the only legacy routes allowed to resume promoted tasks.
DELETE FROM conversation_session_routes route
USING conversation_sessions session
WHERE route.session_id = session.id
  AND session.kind = 'task'
  AND session.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM telegram_hitl_approvals approval
    WHERE approval.application_session_id = session.id
      AND approval.consumed_at IS NULL
      AND route.base_continuation_token =
        approval.telegram_chat_id || ':' ||
        coalesce(approval.telegram_message_thread_id::text, '') || ':' ||
        approval.telegram_message_id::text
  );

-- Non-pending legacy group branches are history only. The next addressed message lazily creates a
-- canonical generation from the PostgreSQL timeline; Eve histories are never concatenated.
UPDATE conversation_sessions
SET retired_at = now(),
    delete_after = now() + interval '90 days',
    pending_operation = false
WHERE group_id IS NOT NULL
  AND retired_at IS NULL
  AND kind = 'canonical';

DELETE FROM conversation_session_routes route
USING conversation_sessions session
WHERE route.session_id = session.id
  AND session.group_id IS NOT NULL
  AND session.retired_at IS NOT NULL;

-- Migration decisions are application-visible without copying or inspecting any Eve history.
INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT family_id, 'session.legacy_promoted_to_task', id,
       jsonb_build_object('pendingRequestId', pending_request_id)
FROM conversation_sessions
WHERE kind = 'task' AND originating_canonical_session_id = id AND retired_at IS NULL;

INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT family_id, 'session.legacy_group_branch_retired', id,
       jsonb_build_object('generation', generation)
FROM conversation_sessions
WHERE kind = 'canonical' AND group_id IS NOT NULL AND retired_at IS NOT NULL;

ALTER TABLE conversation_sessions
  ALTER COLUMN kind DROP DEFAULT,
  ADD CONSTRAINT conversation_sessions_role_state CHECK (
    (kind = 'canonical' AND task_state IS NULL) OR
    (kind <> 'canonical' AND task_state IS NOT NULL)
  ),
  ADD CONSTRAINT conversation_sessions_canonical_group_not_pending CHECK (
    NOT (kind = 'canonical' AND group_id IS NOT NULL AND pending_operation)
  ),
  ADD CONSTRAINT conversation_sessions_topic_requires_group CHECK (
    telegram_forum_topic_id IS NULL OR group_id IS NOT NULL
  );

-- Tasks may share a stable sandbox thread with their replacement canonical generation.
DROP INDEX conversation_sessions_active_thread;
CREATE UNIQUE INDEX conversation_sessions_active_canonical_thread
  ON conversation_sessions (thread_id)
  WHERE retired_at IS NULL AND kind = 'canonical';
CREATE UNIQUE INDEX conversation_sessions_active_canonical_group_topic
  ON conversation_sessions (group_id, telegram_forum_topic_id) NULLS NOT DISTINCT
  WHERE retired_at IS NULL AND kind = 'canonical' AND group_id IS NOT NULL;

-- Trust-zone removal retires every role, clears topic/cursor identity, and terminally marks tasks.
CREATE OR REPLACE FUNCTION retire_group_conversation_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversation_route_generations (route_owner, next_generation)
  SELECT OLD.telegram_chat_id, coalesce(max(generation) + 1, 1)
    FROM conversation_sessions
   WHERE group_id = OLD.id
  ON CONFLICT (route_owner) DO UPDATE
    SET next_generation = greatest(
          conversation_route_generations.next_generation + 1,
          EXCLUDED.next_generation
        ),
        updated_at = now();

  DELETE FROM conversation_session_routes
   WHERE session_id IN (SELECT id FROM conversation_sessions WHERE group_id = OLD.id);

  UPDATE conversation_sessions
     SET group_timeline_cursor = NULL,
         telegram_forum_topic_id = NULL
   WHERE group_id = OLD.id;

  UPDATE conversation_sessions
     SET retired_at = now(),
         delete_after = now() + interval '90 days',
         pending_operation = false,
         task_state = CASE
           WHEN kind <> 'canonical' AND task_state IN ('running', 'pending')
             THEN 'failed'::conversation_task_state
           ELSE task_state
         END
   WHERE group_id = OLD.id
     AND retired_at IS NULL;
  RETURN OLD;
END;
$$;
