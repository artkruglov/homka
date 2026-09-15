-- One paid research attempt per immutable input version, committed before network I/O.
CREATE TABLE errand_research_runs (
  errand_id uuid NOT NULL REFERENCES errands(id) ON DELETE CASCADE,
  input_version integer NOT NULL CHECK(input_version > 0),
  state text NOT NULL CHECK(state IN ('started','completed','ambiguous')),
  result jsonb,
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(errand_id,input_version),
  CHECK((state='completed') = (result IS NOT NULL)),
  CHECK((state='started') = (completed_at IS NULL))
);
