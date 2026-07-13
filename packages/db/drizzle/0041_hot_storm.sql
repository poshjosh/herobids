CREATE TABLE "agent_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"original_store_key" text NOT NULL,
	"extracted_text_store_key" text,
	"extraction_status" text DEFAULT 'not_needed' NOT NULL,
	"lifecycle_state" text DEFAULT 'staged' NOT NULL,
	"materialized_session_id" text,
	"caption_or_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_documents_agent_id" ON "agent_documents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_documents_created_at" ON "agent_documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_documents_user_id" ON "agent_documents" USING btree ("user_id");