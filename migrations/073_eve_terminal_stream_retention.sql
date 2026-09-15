-- Eve 0.32.0 retains every cumulative reasoning/message stream event after a run terminates.
-- Application sessions already provide the verified retirement boundary and physical deletion lease;
-- keep one day for diagnostics instead of retaining high-volume terminal streams for 90 days.
WITH shortened AS (
  UPDATE conversation_sessions
     SET delete_after = retired_at + interval '1 day'
   WHERE retired_at IS NOT NULL
     AND (delete_after IS NULL OR delete_after > retired_at + interval '1 day')
  RETURNING id, family_id, kind, task_state, retention_hold
)
INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT family_id, 'session.retention_shortened', id,
       jsonb_build_object(
         'kind', kind::text,
         'taskState', task_state::text,
         'retentionHold', retention_hold,
         'retentionDays', 1
       )
  FROM shortened;

-- Trust-zone recreation retires active sessions directly in PostgreSQL, so its trigger must use the
-- same deadline as application-driven rotation and terminal event handlers.
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
         delete_after = now() + interval '1 day',
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
