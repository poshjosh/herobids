-- Backfill chat_addresses from the legacy telegram_chat_id columns (040, Migration step 2).
-- Blank values are trimmed and skipped, matching getEffectiveTelegramChatId. Legacy columns are read only.
-- Re-runnable: NOT EXISTS skips any existing telegram row for the scope, and ON CONFLICT covers a concurrent dual-write.
INSERT INTO "chat_addresses" ("id", "user_id", "agent_id", "provider", "address", "status", "verified_at", "consent_source")
SELECT gen_random_uuid()::text, src."user_id", src."agent_id", 'telegram', src."address", 'active', now(), NULL
FROM (
	SELECT a."user_id", a."id" AS "agent_id", regexp_replace(a."telegram_chat_id", '^\s+|\s+$', '', 'g') AS "address"
	FROM "agents" a
	WHERE a."telegram_chat_id" IS NOT NULL
) src
WHERE src."address" <> ''
	AND NOT EXISTS (
		SELECT 1 FROM "chat_addresses" c
		WHERE c."user_id" = src."user_id" AND c."agent_id" = src."agent_id" AND c."provider" = 'telegram'
	)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "chat_addresses" ("id", "user_id", "agent_id", "provider", "address", "status", "verified_at", "consent_source")
SELECT gen_random_uuid()::text, src."id", NULL, 'telegram', src."address", 'active', now(), NULL
FROM (
	SELECT u."id", regexp_replace(u."telegram_chat_id", '^\s+|\s+$', '', 'g') AS "address"
	FROM "users" u
	WHERE u."telegram_chat_id" IS NOT NULL
) src
WHERE src."address" <> ''
	AND NOT EXISTS (
		SELECT 1 FROM "chat_addresses" c
		WHERE c."user_id" = src."id" AND c."agent_id" IS NULL AND c."provider" = 'telegram'
	)
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "agent_outbound_messages"
SET "delivery_provider" = 'telegram',
	"delivery_address" = "telegram_chat_id",
	"provider_message_id" = "telegram_message_id"
WHERE "telegram_message_id" IS NOT NULL
	AND "delivery_provider" IS NULL;