-- One daily health digest per family owner. The row is a claim taken before the Telegram send and
-- completed after it, so a crashed dispatcher retries on the next tick and a duplicate never goes out.
CREATE TABLE owner_health_digests (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  digest_date date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  text_length integer CHECK (text_length IS NULL OR text_length >= 0),
  PRIMARY KEY (family_id, digest_date)
);
