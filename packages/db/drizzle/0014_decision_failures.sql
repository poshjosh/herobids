-- Create decision_failures table for durable failed-decision persistence
CREATE TABLE IF NOT EXISTS decision_failures (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decision_id TEXT,
  instrument_id TEXT,
  venue TEXT,
  venue_account_id TEXT,
  failure_code TEXT NOT NULL,
  failure_message TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  retryable BOOLEAN NOT NULL DEFAULT false,
  details JSONB,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decision_failures_actor ON decision_failures (actor_type, actor_id);
CREATE INDEX idx_decision_failures_failed_at ON decision_failures (failed_at);
