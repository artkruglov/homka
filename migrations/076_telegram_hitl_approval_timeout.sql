-- An unanswered approval parks the Eve turn forever: Eve holds `session.waiting` for as long as it
-- takes and approvals have no expiry, so one ignored prompt silently freezes the whole chat.
-- The confirmation window is bounded here; the sweep leases a row before it answers Eve, so a failed
-- cancellation retries instead of leaving a consumed row whose parked turn was never resumed.
-- The confirmation window covers what a person is expected to answer: tool approvals and agent
-- questions. Framework `session-limit` continuation prompts keep their own boundary.
ALTER TABLE telegram_hitl_approvals
  ADD COLUMN request_kind text
    CHECK (request_kind IN ('question', 'session-limit', 'tool-approval')),
  ADD COLUMN timed_out_at timestamptz,
  ADD COLUMN timeout_lease_token uuid,
  ADD COLUMN timeout_lease_expires_at timestamptz,
  -- A prompt whose cancellation keeps failing must not starve fresher timeouts at the queue head.
  ADD COLUMN timeout_attempts integer NOT NULL DEFAULT 0 CHECK (timeout_attempts >= 0);

ALTER TABLE telegram_hitl_approvals
  ADD CONSTRAINT telegram_hitl_timeout_is_terminal CHECK (
    timed_out_at IS NULL OR consumed_at IS NOT NULL
  ),
  ADD CONSTRAINT telegram_hitl_timeout_lease_pair CHECK (
    (timeout_lease_token IS NULL) = (timeout_lease_expires_at IS NULL)
  );

-- Rows written before this migration carry no request kind. Only durable tool evidence proves an
-- unanswered prompt was a tool approval; anything unproven stays NULL and is never cancelled.
UPDATE telegram_hitl_approvals
   SET request_kind = 'tool-approval'
 WHERE consumed_at IS NULL
   AND tool_call_id IS NOT NULL
   AND tool_name IS NOT NULL
   AND tool_name <> 'session_limit_continuation';

-- The sweep scans only unanswered prompts ordered by age; pending rows stay a small working set.
CREATE INDEX telegram_hitl_approvals_pending_deadline
  ON telegram_hitl_approvals (created_at)
  WHERE consumed_at IS NULL;
