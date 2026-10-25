-- C1 cutover (DEC-01 to DEC-04): opt-outs move from chat_addresses.status to chat_suppressions, and a cleared
-- address is no row (no '' values). Hand-edited: the data steps run before the legacy columns are dropped.
CREATE TABLE "chat_suppressions" (
	"provider" text NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_suppressions_provider_address_pk" PRIMARY KEY("provider","address")
);
--> statement-breakpoint
INSERT INTO "chat_suppressions" ("provider", "address", "status")
SELECT DISTINCT ON ("provider", btrim("address")) "provider", btrim("address"), "status"
FROM "chat_addresses"
WHERE "status" <> 'active' AND btrim("address") <> ''
ORDER BY "provider", btrim("address"), ("status" = 'revoked') DESC
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "chat_addresses" WHERE "status" <> 'active' OR btrim("address") = '';--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" DROP COLUMN "telegram_message_id";--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" DROP COLUMN "telegram_chat_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "telegram_chat_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "telegram_chat_id";