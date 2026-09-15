-- Preserve legacy operational evidence and its foreign keys without publishing mixed context.
ALTER TABLE audit_events ADD COLUMN legacy_quarantined_at timestamptz;
ALTER TABLE agent_improvement_items ADD COLUMN legacy_quarantined_at timestamptz;

DROP INDEX agent_improvement_items_open_fingerprint;
CREATE UNIQUE INDEX agent_improvement_items_open_fingerprint
  ON agent_improvement_items (family_id, fingerprint)
  WHERE status = 'open' AND legacy_quarantined_at IS NULL;
