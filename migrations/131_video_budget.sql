-- Billing identity is the verified Telegram person, shared across every chat and family.
-- Deliberately not cascaded from memberships/workspaces: leaving a chat must not reset spending.
CREATE TABLE video_budget_accounts (
  actor_telegram_id text NOT NULL CHECK(actor_telegram_id ~ '^[1-9][0-9]{0,18}$'),
  month text NOT NULL CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  PRIMARY KEY(actor_telegram_id,month)
);
CREATE TABLE video_budget_reservations (
  operation_key text PRIMARY KEY CHECK(char_length(operation_key) BETWEEN 1 AND 500),
  actor_telegram_id text NOT NULL,
  month text NOT NULL,
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  reserved_micros bigint NOT NULL CHECK(reserved_micros BETWEEN 1 AND 30000000),
  actual_micros bigint CHECK(actual_micros BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  FOREIGN KEY(actor_telegram_id,month) REFERENCES video_budget_accounts(actor_telegram_id,month),
  CHECK((actual_micros IS NULL)=(settled_at IS NULL))
);
CREATE INDEX video_budget_month ON video_budget_reservations(actor_telegram_id,month);

-- Survives workspace deletion as a billing/deduplication receipt, like image operations.
CREATE TABLE video_generation_operations (
  operation_key text PRIMARY KEY REFERENCES video_budget_reservations(operation_key),
  workspace_id uuid NOT NULL,
  target_key text NOT NULL CHECK(char_length(target_key) BETWEEN 1 AND 500),
  model text NOT NULL CHECK(model='bytedance/seedance-2.5'),
  output_path text NOT NULL CHECK(char_length(output_path) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','submitted','completed','ambiguous','failed')),
  job_id text CHECK(job_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='completed')=(result IS NOT NULL)),
  CHECK(status NOT IN ('submitted','completed') OR job_id IS NOT NULL),
  CHECK(status NOT IN ('started','ambiguous') OR job_id IS NULL),
  CHECK((status IN ('failed','ambiguous'))=(error_code IS NOT NULL))
);
