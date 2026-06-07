-- 016/017: Add AI model config to users, create datasets table
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_model_config" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"venue" text,
	"symbol" text,
	"interval" text,
	"from" timestamp with time zone,
	"to" timestamp with time zone,
	"file_path" text,
	"row_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasets_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasets_user_id" ON "datasets" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasets_status" ON "datasets" ("status");
