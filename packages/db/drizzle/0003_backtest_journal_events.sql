ALTER TABLE "journal_events" ADD COLUMN "backtest_run_id" text;--> statement-breakpoint
CREATE INDEX "idx_journal_events_backtest_run_id" ON "journal_events" USING btree ("backtest_run_id");
