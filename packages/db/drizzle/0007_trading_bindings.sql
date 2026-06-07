CREATE TABLE "trading_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "connection_id" text NOT NULL,
  "provider" text NOT NULL,
  "label" text NOT NULL,
  "binding_ref" text,
  "status" text DEFAULT 'active' NOT NULL,
  "binding_profile" jsonb,
  "source_venue_account_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trading_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "trading_bindings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action
);

CREATE UNIQUE INDEX "uq_trading_bindings_connection_id" ON "trading_bindings" USING btree ("connection_id");
CREATE INDEX "idx_trading_bindings_user_id" ON "trading_bindings" USING btree ("user_id");
CREATE INDEX "idx_trading_bindings_connection_id" ON "trading_bindings" USING btree ("connection_id");
CREATE INDEX "idx_trading_bindings_provider" ON "trading_bindings" USING btree ("provider");
CREATE INDEX "idx_trading_bindings_status" ON "trading_bindings" USING btree ("status");

INSERT INTO "connections" ("id", "user_id", "credential_id", "provider", "label", "status", "meta", "created_at", "updated_at")
SELECT
  "id",
  "user_id",
  "credential_id",
  "venue",
  "label",
  'active',
  jsonb_build_object(
    'source', 'venue_account',
    'venueAccountRef', "venue_account_ref",
    'venueProfile', "venue_profile"
  ),
  "created_at",
  "updated_at"
FROM "venue_accounts"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "trading_bindings" ("id", "user_id", "connection_id", "provider", "label", "binding_ref", "status", "binding_profile", "source_venue_account_id", "created_at", "updated_at")
SELECT
  "id",
  "user_id",
  "id",
  "venue",
  "label",
  "venue_account_ref",
  'active',
  "venue_profile",
  "id",
  "created_at",
  "updated_at"
FROM "venue_accounts"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "trading_bindings" ("id", "user_id", "connection_id", "provider", "label", "binding_ref", "status", "binding_profile", "source_venue_account_id", "created_at", "updated_at")
SELECT
  c."id",
  c."user_id",
  c."id",
  c."provider",
  c."label",
  c."id",
  'active',
  c."meta",
  NULL,
  c."created_at",
  c."updated_at"
FROM "connections" AS c
INNER JOIN "capability_grants" AS cg
  ON cg."connection_id" = c."id"
LEFT JOIN "trading_bindings" AS tb
  ON tb."connection_id" = c."id"
WHERE cg."capability_family" = 'trading'
  AND tb."id" IS NULL
GROUP BY c."id", c."user_id", c."provider", c."label", c."meta", c."created_at", c."updated_at"
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "capability_grants" ADD COLUMN "binding_id" text;

UPDATE "capability_grants" AS cg
SET "binding_id" = tb."id"
FROM "trading_bindings" AS tb
WHERE cg."connection_id" = tb."connection_id";

ALTER TABLE "capability_grants" ALTER COLUMN "binding_id" SET NOT NULL;
ALTER TABLE "capability_grants" DROP CONSTRAINT "capability_grants_connection_id_connections_id_fk";
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_binding_id_trading_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."trading_bindings"("id") ON DELETE restrict ON UPDATE no action;
DROP INDEX IF EXISTS "uq_capability_grants_active";
CREATE UNIQUE INDEX "uq_capability_grants_active" ON "capability_grants" USING btree ("agent_id","binding_id","capability_family") WHERE status = 'active';
DROP INDEX IF EXISTS "idx_capability_grants_connection_id";
CREATE INDEX "idx_capability_grants_binding_id" ON "capability_grants" USING btree ("binding_id");
ALTER TABLE "capability_grants" DROP COLUMN "connection_id";

ALTER TABLE "bots" ADD COLUMN "trading_binding_id" text;

UPDATE "bots" AS b
SET "trading_binding_id" = tb."id"
FROM "trading_bindings" AS tb
WHERE b."venue_account_id" = tb."source_venue_account_id";

ALTER TABLE "bots" ALTER COLUMN "trading_binding_id" SET NOT NULL;
ALTER TABLE "bots" ADD CONSTRAINT "bots_trading_binding_id_trading_bindings_id_fk" FOREIGN KEY ("trading_binding_id") REFERENCES "public"."trading_bindings"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "idx_bots_trading_binding_id" ON "bots" USING btree ("trading_binding_id");