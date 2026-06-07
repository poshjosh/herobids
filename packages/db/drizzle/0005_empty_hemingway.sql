-- 021: Platform primitives — connections, capability_grants, capability_grant_audit
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"capability_family" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_capability_grants_active" UNIQUE("agent_id","connection_id","capability_family")
);
--> statement-breakpoint
CREATE TABLE "capability_grant_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grant_audit" ADD CONSTRAINT "capability_grant_audit_grant_id_capability_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."capability_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connections_user_id" ON "connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_connections_provider" ON "connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_connections_status" ON "connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_agent_id" ON "capability_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_connection_id" ON "capability_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_status" ON "capability_grants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_capability_grant_audit_grant_id" ON "capability_grant_audit" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grant_audit_created_at" ON "capability_grant_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_capability_grant_audit_actor_id" ON "capability_grant_audit" USING btree ("actor_id");