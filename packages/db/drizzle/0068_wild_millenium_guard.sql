-- L3-P1b (decision-13 soft-reference pattern): drop the two FK constraints from
-- `connections` into Traderton-owned tables. `credential_id` and
-- `resolved_venue_account_id` remain plain nullable text columns (soft
-- references) — the boundary now owns the credential + venue-account lifecycle,
-- so a hard FK into those tables is no longer valid. Forward-only.
ALTER TABLE "connections" DROP CONSTRAINT "connections_credential_id_user_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_resolved_venue_account_id_venue_accounts_id_fk";
