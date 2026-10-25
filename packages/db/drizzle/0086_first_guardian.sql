ALTER TABLE "agent_outbound_messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_outbound_messages" CASCADE;--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_provider_message" ON "conversation_messages" USING btree ("channel","provider_message_id") WHERE "conversation_messages"."provider_message_id" is not null;