-- Profile projection is fail-closed until the matching policy notice is durably confirmed delivered.
ALTER TABLE external_profile_projection_notices
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN delivery_token uuid UNIQUE,
  ADD COLUMN delivery_started_at timestamptz,
  ADD COLUMN delivery_error_code text;

UPDATE external_profile_projection_notices
SET delivery_status = 'presented'
WHERE first_presented_at IS NOT NULL;

ALTER TABLE external_profile_projection_notices
  ADD CONSTRAINT external_profile_projection_notice_delivery_status
    CHECK (delivery_status IN ('pending', 'started', 'presented', 'ambiguous', 'failed')),
  ADD CONSTRAINT external_profile_projection_notice_delivery_token_state
    CHECK ((delivery_status = 'started') = (delivery_token IS NOT NULL)),
  ADD CONSTRAINT external_profile_projection_notice_presented_state
    CHECK ((delivery_status = 'presented') = (first_presented_at IS NOT NULL)),
  ADD CONSTRAINT external_profile_projection_notice_error_code_format
    CHECK (delivery_error_code IS NULL OR delivery_error_code ~ '^AGENT_[A-Z0-9_]+$');

CREATE INDEX external_profile_projection_notices_pending
  ON external_profile_projection_notices (group_id, policy_version)
  WHERE delivery_status = 'pending';
