-- Billing tables: customer links, subscriptions, webhook event deduplication.

CREATE TABLE IF NOT EXISTS "billing_customers" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL UNIQUE REFERENCES "users"("id"),
  "stripe_customer_id" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_billing_customers_user_id" ON "billing_customers" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_billing_customers_stripe_customer_id" ON "billing_customers" USING btree ("stripe_customer_id");

CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL UNIQUE,
  "plan_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "canceled_at" timestamp with time zone,
  "trial_end" timestamp with time zone,
  "last_stripe_event_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_billing_subscriptions_user_id" ON "billing_subscriptions" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_billing_subscriptions_stripe_subscription_id" ON "billing_subscriptions" USING btree ("stripe_subscription_id");
CREATE INDEX IF NOT EXISTS "idx_billing_subscriptions_status" ON "billing_subscriptions" USING btree ("status");

CREATE TABLE IF NOT EXISTS "billing_webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "status" text DEFAULT 'processed' NOT NULL,
  "error" text,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_billing_webhook_events_event_type" ON "billing_webhook_events" USING btree ("event_type");
