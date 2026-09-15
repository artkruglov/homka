-- Model spend visibility. On 14 September 2026 the DeepSeek balance reached -0.04 USD and the bot
-- lost its model before anyone saw it: per-call usage lived only in container logs.
-- One row per provider response, priced at write time; an installation serves one family.
CREATE TABLE model_usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id text NOT NULL CHECK (char_length(model_id) > 0),
  cache_hit_tokens integer NOT NULL CHECK (cache_hit_tokens >= 0),
  cache_miss_tokens integer NOT NULL CHECK (cache_miss_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  web_search_calls integer NOT NULL DEFAULT 0 CHECK (web_search_calls >= 0),
  cost_usd numeric(12, 6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_usage_events_created_at ON model_usage_events (created_at);

-- One low-balance alert per family per UTC day, claimed before the Telegram send like the digest.
CREATE TABLE owner_balance_alerts (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  alert_date date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^AGENT_[A-Z0-9_]+$'),
  PRIMARY KEY (family_id, alert_date)
);
