-- Multi-provider billing: add provider column, rename Stripe-specific columns to generic names.
-- This is a clean break from the 0011 schema (not yet deployed).

-- Drop old billing tables (clean break — no data to preserve)
DROP TABLE IF EXISTS "billing_webhook_events";
DROP TABLE IF EXISTS "billing_subscriptions";
DROP TABLE IF EXISTS "billing_customers";

-- Recreate billing_customers with provider-agnostic columns
CREATE TABLE "billing_customers" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL DEFAULT 'stripe',
  "external_customer_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_billing_customers_user_id" ON "billing_customers" ("user_id");
CREATE INDEX "idx_billing_customers_external_id" ON "billing_customers" ("external_customer_id");
CREATE INDEX "idx_billing_customers_user_provider" ON "billing_customers" ("user_id", "provider");
ALTER TABLE "billing_customers" ADD CONSTRAINT "uq_billing_customers_user_provider" UNIQUE ("user_id", "provider");
ALTER TABLE "billing_customers" ADD CONSTRAINT "uq_billing_customers_provider_external_id" UNIQUE ("provider", "external_customer_id");

-- Recreate billing_subscriptions with provider-agnostic columns
CREATE TABLE "billing_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL DEFAULT 'stripe',
  "external_customer_id" text NOT NULL,
  "external_subscription_id" text NOT NULL UNIQUE,
  "plan_id" text NOT NULL,
  "external_price_or_product_id" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamp with time zone,
  "trial_end" timestamp with time zone,
  "last_event_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_billing_subscriptions_user_id" ON "billing_subscriptions" ("user_id");
CREATE INDEX "idx_billing_subscriptions_external_subscription_id" ON "billing_subscriptions" ("external_subscription_id");
CREATE INDEX "idx_billing_subscriptions_status" ON "billing_subscriptions" ("status");
CREATE INDEX "idx_billing_subscriptions_provider" ON "billing_subscriptions" ("provider");

-- Recreate billing_webhook_events (unchanged structure, just redeclare for consistency)
CREATE TABLE "billing_webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'processed',
  "error" text,
  "processed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_billing_webhook_events_event_type" ON "billing_webhook_events" ("event_type");
