ALTER TABLE "capability_grants" DROP CONSTRAINT "uq_capability_grants_active";--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_credential_id_user_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_grants_active" ON "capability_grants" USING btree ("agent_id","connection_id","capability_family") WHERE status = 'active';