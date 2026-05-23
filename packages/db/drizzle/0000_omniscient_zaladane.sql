CREATE TABLE "balance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"venue" text NOT NULL,
	"balances" jsonb NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"venue" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_data" text NOT NULL,
	"encryption_meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_instance_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"intent" text NOT NULL,
	"target_size" numeric NOT NULL,
	"limit_price" numeric,
	"context_hash" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"trading_instance_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"planned_orders" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"trading_instance_id" text NOT NULL,
	"venue_ref_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"fee" numeric,
	"fee_currency" text,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"venue" text NOT NULL,
	"type" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"tick_size" numeric NOT NULL,
	"lot_size" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_instance_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_instance_id" text NOT NULL,
	"execution_plan_id" text,
	"venue_ref_id" text,
	"client_order_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric,
	"status" text DEFAULT 'pending' NOT NULL,
	"filled_quantity" numeric DEFAULT '0' NOT NULL,
	"avg_fill_price" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_instance_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "venue_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"venue" text NOT NULL,
	"label" text NOT NULL,
	"venue_account_ref" text,
	"credential_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_balance_snapshots_venue_account_id" ON "balance_snapshots" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_balance_snapshots_snapshot_at" ON "balance_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_decisions_trading_instance_id" ON "decisions" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_decisions_created_at" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_decision_id" ON "execution_plans" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_trading_instance_id" ON "execution_plans" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_fills_order_id" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_fills_trading_instance_id" ON "fills" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_fills_filled_at" ON "fills" USING btree ("filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_instruments_venue_symbol" ON "instruments" USING btree ("venue","symbol");--> statement-breakpoint
CREATE INDEX "idx_journal_events_trading_instance_id" ON "journal_events" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_journal_events_type" ON "journal_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_journal_events_created_at" ON "journal_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_orders_trading_instance_id" ON "orders" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_orders_venue_ref_id" ON "orders" USING btree ("venue_ref_id");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_portfolios_user_id" ON "portfolios" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_positions_trading_instance_id" ON "positions" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_positions_venue_account_id" ON "positions" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_positions_open" ON "positions" USING btree ("trading_instance_id","closed_at");--> statement-breakpoint
CREATE INDEX "idx_trading_instances_user_id" ON "trading_instances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_trading_instances_status" ON "trading_instances" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trading_instances_active_venue_account" ON "trading_instances" USING btree ("venue_account_id") WHERE "trading_instances"."status" != 'stopped';--> statement-breakpoint
CREATE INDEX "idx_venue_accounts_user_id" ON "venue_accounts" USING btree ("user_id");