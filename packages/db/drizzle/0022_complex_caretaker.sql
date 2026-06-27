CREATE TABLE "llm_pricing_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"models" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_llm_pricing_snapshots_provider_active" ON "llm_pricing_snapshots" USING btree ("provider","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_pricing_snapshots_provider_active" ON "llm_pricing_snapshots" USING btree ("provider") WHERE is_active = true;