CREATE TABLE "blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config_data" jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"strategy_preset" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "blueprint_id" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "config_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blueprints_user_id" ON "blueprints" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_blueprints_visibility" ON "blueprints" USING btree ("visibility");--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_blueprint_id_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE set null ON UPDATE no action;