ALTER TABLE "agent_outbound_messages" ADD COLUMN "message_class" text;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD COLUMN "email_delivery_status" text;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD COLUMN "email_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD COLUMN "email_delivery_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "notification_policy" jsonb;