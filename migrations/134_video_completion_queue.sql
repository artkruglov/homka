-- Only a backend-captured origin can opt a new order into automatic completion.
-- Existing billing receipts remain unchanged; no audience or identity is guessed/backfilled.
ALTER TABLE video_generation_operations
  ADD COLUMN completion_origin jsonb,
  ADD COLUMN delivery_state text CHECK(delivery_state IN ('pending','delivered','cancelled','failed')),
  ADD COLUMN completion_due_at timestamptz,
  ADD COLUMN completion_lease_token uuid,
  ADD COLUMN completion_lease_until timestamptz,
  ADD COLUMN completion_error_code text,
  ADD CONSTRAINT video_completion_origin_shape CHECK (
    (completion_origin IS NULL AND delivery_state IS NULL AND completion_due_at IS NULL) OR
    (completion_origin IS NOT NULL AND jsonb_typeof(completion_origin)='object'
      AND delivery_state IS NOT NULL AND completion_due_at IS NOT NULL)),
  ADD CONSTRAINT video_completion_lease_pair CHECK (
    (completion_lease_token IS NULL)=(completion_lease_until IS NULL));
CREATE INDEX video_completion_pending ON video_generation_operations(completion_due_at)
  WHERE delivery_state='pending' AND status IN ('submitted','completed');
CREATE FUNCTION guard_video_completion_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.completion_origin IS DISTINCT FROM OLD.completion_origin THEN
    RAISE EXCEPTION 'AGENT_VIDEO_COMPLETION_ORIGIN_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER video_completion_origin_immutable BEFORE UPDATE OF completion_origin
  ON video_generation_operations FOR EACH ROW EXECUTE FUNCTION guard_video_completion_origin();
