-- OAuth consent delivery is a separate transport boundary from state creation and callback claim.
ALTER TABLE oauth_authorizations
  ADD COLUMN delivery_started_at timestamptz,
  ADD COLUMN delivery_completed_at timestamptz;

-- Historical pending states may already have reached Telegram. Mark them ambiguous instead of
-- allowing a duplicate valid consent link; terminal rows no longer participate in delivery.
UPDATE oauth_authorizations
SET delivery_started_at = created_at
WHERE status = 'pending';

ALTER TABLE oauth_authorizations
  ADD CONSTRAINT oauth_authorization_delivery_completion_requires_start
  CHECK (delivery_completed_at IS NULL OR delivery_started_at IS NOT NULL);
