-- Migration 0015: Agent MVP communication layer
-- Adds: preset to agents, telegram_chat_id to users, agent_outbound_messages table

ALTER TABLE "agents" ADD COLUMN "preset" text;
--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "telegram_chat_id" text;
--> statement-breakpoint

CREATE TABLE "agent_outbound_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "agents"("id"),
  "session_id" text,
  "authored_by" text NOT NULL,
  "subject" text,
  "body" text NOT NULL,
  "context_ref" text,
  "delivery_status" text NOT NULL DEFAULT 'pending',
  "telegram_message_id" text,
  "telegram_chat_id" text,
  "delivery_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_agent_id" ON "agent_outbound_messages" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_authored_by" ON "agent_outbound_messages" ("authored_by");
--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_created_at" ON "agent_outbound_messages" ("created_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_session_id" ON "agent_outbound_messages" ("session_id");
