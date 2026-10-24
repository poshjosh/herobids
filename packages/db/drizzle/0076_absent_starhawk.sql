CREATE TABLE "chat_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"provider" text NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"verified_at" timestamp with time zone,
	"consent_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_chat_addresses_user_agent_provider" UNIQUE NULLS NOT DISTINCT("user_id","agent_id","provider")
);
--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD COLUMN "delivery_provider" text;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "decision_approvals" ADD COLUMN "resolution_provider" text;--> statement-breakpoint
ALTER TABLE "chat_addresses" ADD CONSTRAINT "chat_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_addresses" ADD CONSTRAINT "chat_addresses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_addresses_provider_address" ON "chat_addresses" USING btree ("provider","address");--> statement-breakpoint
CREATE INDEX "idx_chat_addresses_agent_provider" ON "chat_addresses" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_delivery" ON "agent_outbound_messages" USING btree ("delivery_provider","delivery_address","provider_message_id");