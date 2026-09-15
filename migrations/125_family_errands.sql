-- Private intent and individually disclosed results; never a shared family transcript.
CREATE TABLE errands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  initiator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid,
  private_query text NOT NULL CHECK (char_length(private_query) BETWEEN 1 AND 12000),
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 1500),
  delivery_authorized boolean NOT NULL,
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN
    ('preparing','ready','queued','sending','sent','failed','ambiguous','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  result_version integer NOT NULL DEFAULT 0 CHECK (result_version >= 0),
  diagnostic_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,family_id),
  CHECK (initiator_user_id <> recipient_user_id),
  CHECK (state NOT IN ('ready','queued','sending','sent','ambiguous') OR result_version > 0),
  CHECK (state NOT IN ('queued','sending','sent','ambiguous') OR delivery_authorized),
  FOREIGN KEY(space_id,family_id) REFERENCES spaces(id,family_id)
    ON DELETE SET NULL(space_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX errands_queue ON errands(created_at,id) WHERE state='queued';
CREATE INDEX errands_initiator ON errands(family_id,initiator_user_id,created_at DESC);
CREATE INDEX errands_recipient ON errands(family_id,recipient_user_id,created_at DESC);
CREATE INDEX errands_space ON errands(space_id,family_id);
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON errands
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();

CREATE FUNCTION guard_errand_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.family_id,NEW.initiator_user_id,NEW.recipient_user_id,NEW.private_query,NEW.brief)
    IS DISTINCT FROM (OLD.family_id,OLD.initiator_user_id,OLD.recipient_user_id,OLD.private_query,OLD.brief) THEN
    RAISE EXCEPTION 'AGENT_ERRAND_IDENTITY_IMMUTABLE: Create a new errand for a different brief or recipient';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER errand_identity_guard BEFORE UPDATE ON errands
  FOR EACH ROW EXECUTE FUNCTION guard_errand_identity();

CREATE TABLE errand_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id uuid NOT NULL REFERENCES errands(id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK(result_version > 0),
  text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 3000),
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(errand_id,result_version)
);
CREATE TABLE errand_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id uuid NOT NULL,
  result_version integer NOT NULL,
  state text NOT NULL CHECK(state IN ('sending','sent','failed','ambiguous')),
  telegram_message_id text CHECK(telegram_message_id ~ '^[1-9][0-9]*$'),
  diagnostic_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(errand_id,result_version),
  FOREIGN KEY(errand_id,result_version) REFERENCES errand_results(errand_id,result_version) ON DELETE CASCADE,
  CHECK ((state='sending' AND telegram_message_id IS NULL AND completed_at IS NULL) OR
    (state='sent' AND telegram_message_id IS NOT NULL AND completed_at IS NOT NULL) OR
    (state IN ('failed','ambiguous') AND telegram_message_id IS NULL AND completed_at IS NOT NULL AND diagnostic_code IS NOT NULL))
);
CREATE TABLE errand_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id uuid NOT NULL,
  result_version integer NOT NULL,
  text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(errand_id,result_version) REFERENCES errand_results(errand_id,result_version) ON DELETE CASCADE
);
CREATE TABLE errand_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  errand_id uuid NOT NULL,
  operation_key text NOT NULL CHECK(char_length(operation_key) BETWEEN 1 AND 500),
  request_hash text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('create','result','send','cancel','share_answer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(errand_id,family_id) REFERENCES errands(id,family_id) ON DELETE CASCADE,
  UNIQUE(family_id,operation_key)
);
