-- Local identities — email + scrypt password for non-OAuth users.
CREATE TABLE "local_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "password_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "idx_local_identities_user_id" ON "local_identities" ("user_id");
