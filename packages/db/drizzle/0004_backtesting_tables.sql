CREATE TABLE IF NOT EXISTS "backtest_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_type" text NOT NULL,
  "config" jsonb NOT NULL,
  "corpus_id" text,
  "venue" text NOT NULL,
  "symbol" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "metrics" jsonb,
  "error" jsonb,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_decision_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "decision_id" text NOT NULL,
  "context_hash" text NOT NULL,
  "context" jsonb NOT NULL,
  "prompt_payload" text NOT NULL,
  "prompt_version" text NOT NULL,
  "raw_response" text,
  "parsed_decision" jsonb,
  "parse_status" text NOT NULL,
  "parse_error" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "tokens_used" integer NOT NULL DEFAULT 0,
  "latency_ms" integer NOT NULL DEFAULT 0,
  "cached" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_contexts" (
  "id" text PRIMARY KEY NOT NULL,
  "decision_id" text NOT NULL,
  "trading_instance_id" text NOT NULL,
  "context_hash" text NOT NULL,
  "context" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_corpora" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "source" text NOT NULL,
  "venue" text NOT NULL,
  "symbols" text NOT NULL,
  "format_version" integer NOT NULL DEFAULT 1,
  "metadata" jsonb,
  "start_at" timestamp with time zone,
  "end_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_market_events" (
  "id" text PRIMARY KEY NOT NULL,
  "corpus_id" text NOT NULL,
  "venue" text NOT NULL,
  "symbol" text NOT NULL,
  "event_type" text NOT NULL,
  "price" numeric NOT NULL,
  "event_at" timestamp with time zone NOT NULL,
  "data" jsonb
);--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_status" ON "backtest_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_strategy_type" ON "backtest_runs" USING btree ("strategy_type");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_created_at" ON "backtest_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_decision_id" ON "llm_decision_artifacts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_context_hash" ON "llm_decision_artifacts" USING btree ("context_hash");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_decision_id" ON "decision_contexts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_context_hash" ON "decision_contexts" USING btree ("context_hash");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_trading_instance_id" ON "decision_contexts" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_replay_corpora_venue" ON "replay_corpora" USING btree ("venue");--> statement-breakpoint
CREATE INDEX "idx_replay_market_events_corpus_symbol_time" ON "replay_market_events" USING btree ("corpus_id", "symbol", "event_at");--> statement-breakpoint
CREATE INDEX "idx_replay_market_events_corpus_type" ON "replay_market_events" USING btree ("corpus_id", "event_type");
