-- Promote the non-unique index on oauth_identities (provider, provider_user_id)
-- to a unique index. This ensures no duplicate identity rows can be created
-- for the same external account, even under concurrent first-login requests.

-- Dedup first: if any duplicates exist (from the pre-fix login flow), keep the
-- oldest row per (provider, provider_user_id) and delete the rest.
DELETE FROM "oauth_identities"
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("provider", "provider_user_id") "id"
  FROM "oauth_identities"
  ORDER BY "provider", "provider_user_id", "created_at" ASC
);

DROP INDEX IF EXISTS "idx_oauth_identities_provider_user_id";

CREATE UNIQUE INDEX "uq_oauth_identities_provider_user_id"
  ON "oauth_identities" ("provider", "provider_user_id");
