-- Scope billing subscription identity to (provider, external_subscription_id).
-- Previously external_subscription_id had a global unique constraint; with
-- multi-provider billing two providers could theoretically share the same
-- subscription ID string and one would corrupt the other's row.

ALTER TABLE "billing_subscriptions"
  DROP CONSTRAINT IF EXISTS "billing_subscriptions_external_subscription_id_key";

ALTER TABLE "billing_subscriptions"
  ADD CONSTRAINT "uq_billing_subscriptions_provider_external_id"
  UNIQUE ("provider", "external_subscription_id");
