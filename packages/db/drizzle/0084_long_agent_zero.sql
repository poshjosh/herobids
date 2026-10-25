CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" text,
	"channel" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"message_class" text,
	"delivery_status" text NOT NULL,
	"delivery_detail" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"conversation_id" text NOT NULL,
	"participant_type" text NOT NULL,
	"participant_id" text NOT NULL,
	CONSTRAINT "conversation_participants_pk" PRIMARY KEY("conversation_id","participant_type","participant_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"peer_key" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "peer_messaging_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_conversation_created" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_participant" ON "conversation_participants" USING btree ("participant_type","participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_peer_key" ON "conversations" USING btree ("peer_key") WHERE "conversations"."kind" = 'agent_agent';--> statement-breakpoint
CREATE INDEX "idx_conversations_owner_last_message" ON "conversations" USING btree ("owner_user_id","last_message_at" DESC NULLS LAST);