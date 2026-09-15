-- One immutable source set binds every memory write to the exact messages visible in an Eve turn.
-- The model selects a rendered sequence number; opaque timeline IDs never enter its tool input.
CREATE TABLE memory_turn_source_sets (
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  application_session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  current_timeline_entry_id uuid NOT NULL,
  invoking_telegram_user_id text NOT NULL CHECK (char_length(invoking_telegram_user_id) > 0),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eve_session_id, eve_turn_id),
  UNIQUE (eve_session_id, eve_turn_id, conversation_id),
  FOREIGN KEY (current_timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id)
);

CREATE INDEX memory_turn_source_sets_application_session
  ON memory_turn_source_sets (application_session_id);
CREATE INDEX memory_turn_source_sets_conversation
  ON memory_turn_source_sets (conversation_id);
CREATE INDEX memory_turn_source_sets_current_timeline_entry
  ON memory_turn_source_sets (current_timeline_entry_id, conversation_id);

CREATE TABLE memory_turn_sources (
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  conversation_id uuid NOT NULL,
  timeline_entry_id uuid NOT NULL,
  timeline_sequence bigint NOT NULL CHECK (timeline_sequence > 0),
  is_current boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eve_session_id, eve_turn_id, timeline_entry_id),
  UNIQUE (eve_session_id, eve_turn_id, timeline_sequence),
  FOREIGN KEY (eve_session_id, eve_turn_id, conversation_id)
    REFERENCES memory_turn_source_sets(eve_session_id, eve_turn_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id)
);

CREATE UNIQUE INDEX memory_turn_sources_one_current
  ON memory_turn_sources (eve_session_id, eve_turn_id) WHERE is_current;
CREATE INDEX memory_turn_sources_conversation
  ON memory_turn_sources (conversation_id);
CREATE INDEX memory_turn_sources_timeline_entry
  ON memory_turn_sources (timeline_entry_id, conversation_id);
