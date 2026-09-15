CREATE TABLE joint_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 300),
  details text CHECK(char_length(details) BETWEEN 1 AND 2000),
  cancelled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(creator_user_id<>partner_user_id),
  UNIQUE(id,family_id),
  FOREIGN KEY(space_id,family_id) REFERENCES spaces(id,family_id)
    ON DELETE SET NULL(space_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX joint_decisions_area ON joint_decisions(family_id,space_id,created_at DESC,id);
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON joint_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();
CREATE FUNCTION guard_joint_decision_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.family_id,NEW.creator_user_id,NEW.partner_user_id,NEW.group_id,NEW.title,NEW.details)
    IS DISTINCT FROM (OLD.family_id,OLD.creator_user_id,OLD.partner_user_id,OLD.group_id,OLD.title,OLD.details) THEN
    RAISE EXCEPTION 'AGENT_DECISION_PROPOSAL_IMMUTABLE';
  END IF;
  IF OLD.cancelled AND NOT NEW.cancelled THEN RAISE EXCEPTION 'AGENT_DECISION_CANCELLED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER joint_decision_proposal_guard BEFORE UPDATE ON joint_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_joint_decision_proposal();

CREATE TABLE joint_decision_answers (
  decision_id uuid NOT NULL REFERENCES joint_decisions(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice text NOT NULL CHECK(choice IN ('agree','decline')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(decision_id,actor_user_id)
);
CREATE TABLE joint_decision_feedback (
  decision_id uuid NOT NULL REFERENCES joint_decisions(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(decision_id,actor_user_id)
);
CREATE FUNCTION guard_joint_decision_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM joint_decisions d WHERE d.id=NEW.decision_id
    AND NEW.actor_user_id IN (d.creator_user_id,d.partner_user_id)) THEN
    RAISE EXCEPTION 'AGENT_DECISION_PARTICIPANT_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER joint_decision_answer_actor BEFORE INSERT OR UPDATE ON joint_decision_answers
  FOR EACH ROW EXECUTE FUNCTION guard_joint_decision_participant();
CREATE TRIGGER joint_decision_feedback_actor BEFORE INSERT OR UPDATE ON joint_decision_feedback
  FOR EACH ROW EXECUTE FUNCTION guard_joint_decision_participant();
CREATE TABLE joint_decision_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK(char_length(operation_key) BETWEEN 1 AND 500),
  decision_id uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(family_id,operation_key),
  FOREIGN KEY(decision_id,family_id) REFERENCES joint_decisions(id,family_id) ON DELETE CASCADE
);
