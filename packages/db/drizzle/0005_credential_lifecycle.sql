-- Backfill: null out dangling credential references that predate the FK.
-- Raises a WARNING with affected account IDs so operators can review/repair.
DO $$
DECLARE
  orphan_ids text;
  orphan_count integer;
BEGIN
  SELECT count(*), string_agg("id", ', ') INTO orphan_count, orphan_ids
    FROM "venue_accounts"
    WHERE "credential_id" IS NOT NULL
      AND "credential_id" NOT IN (SELECT "id" FROM "credentials");
  IF orphan_count > 0 THEN
    RAISE WARNING '[0005_credential_lifecycle] Nulling % venue_accounts row(s) with dangling credential_id. Affected IDs: %', orphan_count, orphan_ids;
  END IF;
END $$;

UPDATE "venue_accounts" SET "credential_id" = NULL
  WHERE "credential_id" IS NOT NULL
    AND "credential_id" NOT IN (SELECT "id" FROM "credentials");

-- Index for FK lookups and findCredentialDependents queries
CREATE INDEX "idx_venue_accounts_credential_id" ON "venue_accounts" ("credential_id");

ALTER TABLE "venue_accounts" ADD CONSTRAINT "venue_accounts_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
