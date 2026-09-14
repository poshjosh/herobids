-- D1-cred: split the non-trading (platform) half out of user_credentials.
-- Trading venue credentials move behind the Traderton boundary; herobids keeps
-- only platform (Gmail/OAuth/social) credentials here. Mirrors the
-- user_credentials shape exactly. Greenfield — no backfill (starts empty).
CREATE TABLE IF NOT EXISTS platform_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_data TEXT NOT NULL,
  encryption_meta JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
