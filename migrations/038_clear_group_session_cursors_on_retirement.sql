-- Detach every historical session cursor before the group foreign key is cleared. Retired
-- sessions keep their original retention timestamps, while only the active session is retired.
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

  -- Historical Telegram anchors belong to the deleted trust zone and must not route a newly
  -- registered group into a detached session generation.
  DELETE FROM conversation_session_routes
   WHERE session_id IN (
     SELECT id FROM conversation_sessions WHERE group_id = OLD.id
   );

  UPDATE conversation_sessions
     SET group_timeline_cursor = NULL
   WHERE group_id = OLD.id;

  UPDATE conversation_sessions
     SET retired_at = now(),
         delete_after = now() + interval '90 days',
         pending_operation = false
   WHERE group_id = OLD.id
     AND retired_at IS NULL;
  RETURN OLD;
END;
$$;
