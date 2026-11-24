CREATE TABLE "agent_outbound_message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"outbound_message_id" text NOT NULL,
	"source_document_id" text NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_agent_id" text,
	"copied_document_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"delivery_status" text NOT NULL,
	"delivery_ref" text,
	"delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_documents" ADD COLUMN "source_document_id" text;--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_message_attachments_message_id" ON "agent_outbound_message_attachments" USING btree ("outbound_message_id");