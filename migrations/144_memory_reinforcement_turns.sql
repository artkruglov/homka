-- Reinforcement widens a record's stability, so it must count a turn once. A replayed turn
-- (Eve retry, repeated delivery of the same completed output) named the same refs again and
-- incremented reinforcement_count every time. Upstream 960c4b9 (their migration 106) keys
-- reinforcement by memory item and Eve turn; here the policy stays "reinforced only by use",
-- only the replay inflation is removed.
CREATE TABLE memory_reinforcement_turns (
  memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL CHECK (char_length(eve_session_id) BETWEEN 1 AND 200),
  eve_turn_id text NOT NULL CHECK (char_length(eve_turn_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (reason IN ('model_used', 'remember_reinforces')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, eve_session_id, eve_turn_id)
);

-- Turns already audited stay replay-safe after the upgrade. Historical counts are not rewritten:
-- a past replay cannot be told apart from a real reuse after the fact.
INSERT INTO memory_reinforcement_turns (memory_item_id, eve_session_id, eve_turn_id, reason, created_at)
SELECT DISTINCT ON (item.id, audit.metadata->>'sessionId', audit.metadata->>'turnId')
       item.id, audit.metadata->>'sessionId', audit.metadata->>'turnId', audit.metadata->>'reason',
       audit.created_at
  FROM audit_events AS audit
  JOIN memory_items_all AS item ON item.id = audit.subject_id
 WHERE audit.event_type = 'memory.reinforced'
   AND audit.metadata->>'reason' IN ('model_used', 'remember_reinforces')
   AND char_length(audit.metadata->>'sessionId') BETWEEN 1 AND 200
   AND char_length(audit.metadata->>'turnId') BETWEEN 1 AND 200
 ORDER BY item.id, audit.metadata->>'sessionId', audit.metadata->>'turnId', audit.created_at;
