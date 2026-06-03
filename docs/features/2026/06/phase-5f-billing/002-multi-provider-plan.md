# Phase 5f-2: Multi-Provider Billing (Creem Primary, Stripe Fallback)

## Objective

Refactor the existing Stripe-only billing implementation into a provider-agnostic architecture with Creem as the primary payment provider and Stripe as a configurable fallback. The system should fail over transparently on outbound calls while maintaining provider-specific webhook handling.

## Context

- Creem is a Merchant of Record with a REST API at `https://api.creem.io/v1` (test: `https://test-api.creem.io/v1`)
- Creem authenticates via `x-api-key` header
- Creem creates checkouts via `POST /checkouts` using a `product_id` (not a price ID)
- Creem webhook signature: HMAC-SHA256 of raw body, delivered in `creem-signature` header
- Creem cancels subscriptions via API (`subscriptions.cancel({ subscriptionId })`) — supports immediate or end-of-period
- Creem **has a Customer Portal** — customers get a magic link email after payment; can also be generated programmatically via REST API (`Portal` endpoint with `customerId`)
- Creem supports **programmatic subscription upgrades/downgrades** via `subscriptions.upgrade({ subscriptionId, productId, updateBehavior })` with proration options (`proration-charge-immediately`, `proration-none`)
- Creem creates customers implicitly during checkout — no explicit customer creation API call needed; `customer_id` is returned in the success redirect and webhook payloads
- Creem webhook events: `checkout.completed`, `subscription.active`, `subscription.paid`, `subscription.canceled`, `subscription.scheduled_cancel`, `subscription.past_due`, `subscription.expired`, `subscription.trialing`, `subscription.paused`, `subscription.update`
- Creem retry policy: HTTP 200 expected; retries at 30s, 1min, 5min, 1hr
- Stripe remains fully functional as implemented in 001-plan.md

## Design Decisions

### Provider port interface

A `PaymentProvider` interface defines the contract. Each provider implements it. A `PaymentProviderManager` orchestrates primary + fallback failover for outbound calls only.

### Fallback semantics

- **Outbound calls** (checkout creation, subscription cancellation, portal generation, upgrades): try primary, on `ProviderUnavailableError` retry on fallback.
- **Webhooks**: NOT fallback-capable. Each provider has its own webhook endpoint (`/billing/webhook/creem`, `/billing/webhook/stripe`). Both normalize events into the same `EntitlementSync` flow.
- **Portal**: Both providers support portal URLs. Creem generates a portal link via REST API (requires `customerId`). Stripe uses its billing portal sessions.

### Subscription ownership

Each subscription belongs to exactly one provider. The `billing_subscriptions` table gains a `provider` column. Cancellation is routed to the provider that owns the subscription. A user cannot have active subscriptions in both providers simultaneously.

### Product mapping

- Stripe uses price IDs (`price_xxx`) mapped via `billing.stripe.planPrices`
- Creem uses product IDs (`prod_xxx`) mapped via `billing.creem.planProducts`
- Both map to the same internal plan IDs (`free`, `pro`, etc.)

## Implementation Order

### 1. Extend billing config for multi-provider support

Primary files:
- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/index.ts`
- `config/default.yaml`
- `apps/api/src/config.ts`

Changes:
- Add `primaryProvider` and `fallbackProvider` fields to `BillingConfigSchema` (`'creem' | 'stripe'`)
- Add a `creem` sub-object to billing config:
  - `apiKey` (override: `CREEM_API_KEY`)
  - `webhookSecret` (override: `CREEM_WEBHOOK_SECRET`)
  - `apiBaseUrl` (default: `https://api.creem.io/v1`)
  - `planProducts`: record of internal plan ID → Creem product ID
- Rename existing Stripe fields into a `stripe` sub-object for symmetry:
  - `billing.stripe.secretKey`
  - `billing.stripe.webhookSecret`
  - `billing.stripe.planPrices`
  - `billing.stripe.customerPortalConfigurationId`
- Cross-validate: if a provider is referenced as primary or fallback, its required credentials must be present
- Keep `checkoutSuccessUrl` and `checkoutCancelUrl` at the top level (provider-agnostic)

### 2. Define the payment provider port interface

Primary files:
- new `apps/api/src/billing/provider-port.ts`

Changes:
- Define a `PaymentProvider` interface:
  ```typescript
  interface PaymentProvider {
    readonly name: string;
    createCheckoutUrl(params: CheckoutParams): Promise<string>;
    createPortalUrl(params: PortalParams): Promise<string>;
    cancelSubscription(externalSubscriptionId: string, atPeriodEnd?: boolean): Promise<void>;
    upgradeSubscription(externalSubscriptionId: string, newPlanId: string, prorate: boolean): Promise<void>;
    verifyWebhook(payload: string | Buffer, headers: Record<string, string>): NormalizedWebhookEvent;
  }
  ```
- Define `CheckoutParams`: `{ userId: string; email: string; planId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }`
- Define `PortalParams`: `{ customerId: string; returnUrl: string }`
- Define `NormalizedWebhookEvent`: `{ id: string; type: 'subscription.created' | 'subscription.updated' | 'subscription.canceled' | 'payment.failed'; provider: string; subscriptionId: string; customerId: string; priceOrProductId: string; status: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; canceledAt: Date | null; trialEnd: Date | null; metadata: Record<string, string>; createdAt: Date }`
- Define `ProviderUnavailableError` — thrown when the provider is unreachable or returns a retryable error

### 3. Implement Creem provider adapter

Primary files:
- new `apps/api/src/billing/creem-provider.ts`

Changes:
- Implement `PaymentProvider` for Creem
- `createCheckoutUrl`: `POST /checkouts` with `product_id` from plan mapping, `success_url`, metadata containing `referenceId` (herobids userId) and `planType`
- `createPortalUrl`: call Creem's Portal REST endpoint with `customerId`, return the portal URL
- `cancelSubscription`: call Creem's cancel endpoint (supports immediate or at-period-end)
- `upgradeSubscription`: call Creem's upgrade endpoint with new `productId` and `updateBehavior` (`proration-charge-immediately` or `proration-none`)
- `verifyWebhook`: HMAC-SHA256 verification of raw body against `creem-signature` header, normalize Creem event types into `NormalizedWebhookEvent`
- Handle Creem's test mode: if API key starts with `creem_test_`, use test API base URL (`https://test-api.creem.io/v1`)
- Map internal plan IDs to Creem product IDs via config
- Customer ID tracking: extract `customer_id` from webhook payloads (Creem creates customers implicitly during checkout)

### 4. Refactor existing Stripe code into provider adapter

Primary files:
- `apps/api/src/billing/stripe-client.ts` → rename/refactor to `apps/api/src/billing/stripe-provider.ts`

Changes:
- Implement `PaymentProvider` for Stripe
- `createCheckoutUrl`: existing checkout session logic (creates Stripe customer lazily, then creates checkout session)
- `createPortalUrl`: existing portal session logic (returns URL)
- `cancelSubscription`: call Stripe API to cancel subscription (immediate or at-period-end)
- `upgradeSubscription`: call Stripe API to update subscription's price item
- `verifyWebhook`: existing HMAC verification, normalize Stripe event types into `NormalizedWebhookEvent`
- Keep signature verification and API helpers from the existing `StripeClient`

### 5. Implement payment provider manager

Primary files:
- new `apps/api/src/billing/provider-manager.ts`

Changes:
- `PaymentProviderManager` class:
  - Constructor takes `primary: PaymentProvider` and `fallback: PaymentProvider | null`
  - `createCheckoutUrl`: try primary, on `ProviderUnavailableError` try fallback, else re-throw
  - `createPortalUrl`: try primary, on `ProviderUnavailableError` try fallback
  - `cancelSubscription`: route to the provider that owns the subscription (requires provider column lookup), no fallback for cancellation (wrong provider can't cancel another's subscription)
  - `upgradeSubscription`: route to the owning provider (same as cancel — provider-bound)
- Factory function `createProviderManager(config)` that resolves provider names to instances

### 6. Add `provider` column to billing tables

Primary files:
- `packages/db/src/schema/billing-customers.ts`
- `packages/db/src/schema/billing-subscriptions.ts`
- `packages/db/drizzle/` new migration
- `packages/db/src/billing-repository.ts`

Changes:
- Add `provider` text column to `billing_customers` (which provider created this customer link)
- Add `provider` text column to `billing_subscriptions` (which provider owns this subscription)
- Update repository helpers to filter/route by provider
- Add `findCustomerByUserIdAndProvider` helper
- Migration: add column with default `'stripe'` for existing rows

### 7. Refactor billing routes to use provider manager

Primary files:
- `apps/api/src/routes/billing.ts`
- `apps/api/src/billing/entitlement-sync.ts`

Changes:
- Replace direct `StripeClient` usage with `PaymentProviderManager`
- `POST /billing/checkout-session`: delegate to manager's `createCheckoutUrl`
- `POST /billing/customer-portal`: delegate to manager's `createPortalUrl` (both providers return a URL)
- `POST /billing/cancel-subscription`: new authenticated endpoint — looks up user's active subscription, routes to owning provider
- `POST /billing/upgrade-subscription`: new authenticated endpoint — upgrades to new plan via owning provider
- Split webhook into two endpoints:
  - `POST /billing/webhook/stripe` — Stripe signature verification + normalize + entitlement sync
  - `POST /billing/webhook/creem` — Creem signature verification + normalize + entitlement sync
  - Keep `POST /billing/webhook` as an alias for the primary provider's webhook (backward compatibility)
- Update `EntitlementSync` to accept `NormalizedWebhookEvent` instead of raw Stripe events
- Both webhook endpoints exempt from JWT auth in the auth plugin

### 8. Update frontend billing page

Primary files:
- `apps/web/src/features/billing/BillingPage.tsx`
- `apps/web/src/lib/api-client.ts`

Changes:
- Both providers have portal URLs — always redirect to the portal for subscription management
- Add "Change Plan" button that calls `POST /billing/upgrade-subscription` with new plan ID
- Add "Cancel Subscription" button that calls `POST /billing/cancel-subscription`
- Add confirmation dialog before cancellation ("Your access continues until the end of the billing period.")
- Portal button continues to redirect (works for both Stripe and Creem)

### 9. Tests

Primary files:
- `apps/api/src/billing/creem-provider.test.ts`
- `apps/api/src/billing/provider-manager.test.ts`
- `apps/api/src/billing/entitlement-sync.test.ts` (extend)
- `apps/api/src/billing/billing-config.test.ts` (extend)

Changes:
- Unit tests for Creem webhook signature verification
- Unit tests for Creem event type normalization
- Unit tests for provider manager fallback behavior
- Unit tests for multi-provider config validation
- Unit tests for normalized event → entitlement transition
- Extend existing config tests for the restructured billing config

## Migration Strategy

**Clean break** — the flat `billing.*` config shape from 001-plan.md is not yet deployed, so no backward compatibility is needed.

1. Replace the flat billing config with the nested structure (`billing.stripe.*`, `billing.creem.*`, `billing.primaryProvider`, etc.) in a single commit.
2. The `provider` column on existing billing tables defaults to `'stripe'` for any pre-existing rows.
3. Webhook endpoints: keep `/billing/webhook` as an alias for the primary provider's handler while adding explicit `/billing/webhook/creem` and `/billing/webhook/stripe`.

## Resolved Questions

1. **Creem customer concept**: Customers are created implicitly during checkout. No explicit API call needed. `customer_id` is returned in success redirect query params and webhook payloads. Metadata (especially `referenceId`) links back to our internal userId.

2. **Creem subscription ID**: Returned in success redirect as `subscription_id` query param, and included in all subscription webhook payloads.

3. **Creem plan change**: Creem supports programmatic upgrades/downgrades via `subscriptions.upgrade({ subscriptionId, productId, updateBehavior })`. Single API call with proration options — no need to cancel and re-create.

4. **Creem Customer Portal**: Creem DOES have a customer portal. Customers receive a magic link email after payment. Portal can also be generated programmatically via REST API (pass `customerId`). Customers can cancel subscriptions and request support from the portal.

## Risks

- Dual-provider testing requires test accounts on both platforms.
- Creem's webhook retry policy (30s → 1min → 5min → 1hr) is less aggressive than Stripe's — if webhook delivery is unreliable, we may need a reconciliation job that polls Creem's subscription API periodically.
- Creem's REST API endpoint URLs for subscriptions/portal need to be confirmed against their API reference (docs only show SDK usage patterns, not raw REST paths). We may need to inspect the TypeScript SDK source for exact URLs.
