-- Drop the operator backtesting capability's dedicated tables.
-- Backtesting has been removed from the platform; these tables are backtest-only
-- and safe to drop. The shared journal_events.backtest_run_id column is intentionally
-- retained as a harmless nullable vestige (dropping it would risk the live journal table).
DROP TABLE IF EXISTS "replay_market_events";
DROP TABLE IF EXISTS "backtest_runs";
DROP TABLE IF EXISTS "replay_corpora";
