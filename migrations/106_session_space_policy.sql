-- Existing sessions have not proved a single model-history audience. Do not assign the current
-- policy to their old history. A scoped preparation must replace them with a fresh Eve/sandbox root.
ALTER TABLE conversation_sessions ADD COLUMN space_policy_version integer
  CHECK (space_policy_version > 0);
ALTER TABLE conversation_sessions ADD CONSTRAINT conversation_session_space_policy_shape
  CHECK (space_policy_version IS NULL OR space_id IS NOT NULL);

CREATE FUNCTION guard_session_space_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.space_id IS NULL AND OLD.space_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM spaces WHERE id=OLD.space_id) THEN
    NEW.space_policy_version := NULL;
  ELSIF OLD.space_policy_version IS NOT NULL
    AND NEW.space_policy_version IS DISTINCT FROM OLD.space_policy_version THEN
    RAISE EXCEPTION 'AGENT_SESSION_SPACE_POLICY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_space_policy_guard BEFORE UPDATE ON conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_session_space_policy();
