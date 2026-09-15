-- A pre-send marker makes invitation delivery fail closed after a sent-but-uncommitted outcome.
ALTER TABLE invitations
  ADD COLUMN delivery_started_at timestamptz;

-- Before this marker, any still-open historical row may have crossed Telegram's transport boundary
-- before a process crash. Treat every legacy invitation as started so replay fails closed.
UPDATE invitations
SET delivery_started_at = COALESCE(delivery_completed_at, created_at);

ALTER TABLE invitations
  ADD CONSTRAINT invitation_delivery_completion_requires_start
  CHECK (delivery_completed_at IS NULL OR delivery_started_at IS NOT NULL);
