-- c4.9f — Drop the 16 core trading tables.
--
-- Trading has been extracted from herobids into Traderton behind the REST
-- boundary; herobids holds ZERO trading reads/writes (ripgrep-verified). Traderton
-- is the sole authority for these tables. This drops them from the herobids DB.
--
-- PLATFORM-KEEP (NOT dropped): market_assessment_runs/artifacts/requests (c4.9h —
-- agent preset-review/strategy-selection runtime), connections, agents, billing*,
-- blueprints*, skills*, and all other platform tables.
--
-- CASCADE handles inter-table FK ordering (the trading tables reference each other
-- and reference the KEEP connections/users; CASCADE drops the trading-side FK
-- constraints). IF EXISTS keeps the migration idempotent / safe on a fresh
-- (greenfield) DB where reset-and-run replays all migrations from an empty volume.
DROP TABLE IF EXISTS "fills" CASCADE;
DROP TABLE IF EXISTS "positions" CASCADE;
DROP TABLE IF EXISTS "orders" CASCADE;
DROP TABLE IF EXISTS "execution_plans" CASCADE;
DROP TABLE IF EXISTS "decision_failures" CASCADE;
DROP TABLE IF EXISTS "llm_decision_artifacts" CASCADE;
DROP TABLE IF EXISTS "decision_contexts" CASCADE;
DROP TABLE IF EXISTS "decisions" CASCADE;
DROP TABLE IF EXISTS "balance_snapshots" CASCADE;
DROP TABLE IF EXISTS "journal_events" CASCADE;
DROP TABLE IF EXISTS "reconciliation_events" CASCADE;
DROP TABLE IF EXISTS "token_safety_overrides" CASCADE;
DROP TABLE IF EXISTS "bots" CASCADE;
DROP TABLE IF EXISTS "venue_accounts" CASCADE;
DROP TABLE IF EXISTS "user_credentials" CASCADE;
DROP TABLE IF EXISTS "instruments" CASCADE;
