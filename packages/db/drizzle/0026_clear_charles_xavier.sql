-- Merge connections + trading_bindings, drop agent_credentials
-- ============================================================================

-- 1. Add new columns to connections (absorbed from trading_bindings)
ALTER TABLE "connections" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "profile" jsonb;--> statement-breakpoint

-- 2. Copy data from trading_bindings into connections
UPDATE "connections" c SET
  "provider_ref" = tb."binding_ref",
  "profile" = tb."binding_profile"
FROM "trading_bindings" tb
WHERE tb."connection_id" = c."id";--> statement-breakpoint

-- 3. Drop old FK constraints pointing at trading_bindings
ALTER TABLE "bots" DROP CONSTRAINT IF EXISTS "bots_trading_binding_id_trading_bindings_id_fk";--> statement-breakpoint
ALTER TABLE "capability_grants" DROP CONSTRAINT IF EXISTS "capability_grants_binding_id_trading_bindings_id_fk";--> statement-breakpoint

-- 4. Drop old indexes that reference the renamed columns
DROP INDEX IF EXISTS "idx_bots_trading_binding_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_capability_grants_binding_id";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_capability_grants_active";--> statement-breakpoint

-- 5. Rename columns (preserves data)
ALTER TABLE "bots" RENAME COLUMN "trading_binding_id" TO "connection_id";--> statement-breakpoint
ALTER TABLE "capability_grants" RENAME COLUMN "binding_id" TO "connection_id";--> statement-breakpoint
ALTER TABLE "user_credentials" RENAME COLUMN "venue" TO "provider";--> statement-breakpoint

-- 6. Add new FKs to connections
ALTER TABLE "bots" ADD CONSTRAINT "bots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint

-- 7. Create new indexes
CREATE INDEX "idx_bots_connection_id" ON "bots" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_connection_id" ON "capability_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_grants_active" ON "capability_grants" USING btree ("agent_id","connection_id","capability_family") WHERE status = 'active';--> statement-breakpoint

-- 8. Validate the new FKs (after data integrity is confirmed)
ALTER TABLE "bots" VALIDATE CONSTRAINT "bots_connection_id_connections_id_fk";--> statement-breakpoint
ALTER TABLE "capability_grants" VALIDATE CONSTRAINT "capability_grants_connection_id_connections_id_fk";--> statement-breakpoint

-- 9. Drop the old tables
DROP TABLE "agent_credentials" CASCADE;--> statement-breakpoint
DROP TABLE "trading_bindings" CASCADE;--> statement-breakpoint