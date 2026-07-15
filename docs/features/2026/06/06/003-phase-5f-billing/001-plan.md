# Phase 5f: Billing

## Objective

Add Stripe-backed billing to the product control plane without weakening the existing trading-system boundaries.

The key architectural rule for this step is:

- Stripe is the payment system of record.
- OpenAIdom remains the source of truth for feature entitlements enforced inside the API.
- The trading engine, worker runtime, and venue adapters remain billing-agnostic.

This step should turn paid subscription state into durable, user-scoped plan entitlements that the existing auth and plan-guard paths can enforce.

## Scope Assumptions

- First release is user-level subscription billing, not per-agent billing and not usage metering.
- Stripe Checkout plus Stripe Customer Portal are the primary self-serve flows.
- Webhook events, not browser redirects, are authoritative for upgrade, downgrade, renewal, cancellation, and payment-failure state.
- `users.planId` remains a denormalized entitlement cache for fast request-time checks.
- `user_plans` remains the historical record of plan transitions.
- Agent token budgets, usage-based charging, invoices mirrored into OpenAIdom, and tax-specific workflows can stay out of the first billing slice unless GTM requires them immediately.

## Implementation Order

### 1. Add operator billing config and freeze the billing boundary

Primary files:

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/index.ts`
- `config/default.yaml`
- `apps/api/src/index.ts`

Changes:

- Add a `billing` operator-config section rather than scattering Stripe env reads through route code.
- Define a `BillingConfigSchema` with the minimum fields needed for the first release:
  - `enabled`
  - `provider` or fixed Stripe selection
  - `stripeSecretKey`
  - `stripeWebhookSecret`
  - `customerPortalConfigurationId` if used
  - `checkoutSuccessUrl`
  - `checkoutCancelUrl`
  - plan-to-price mapping from internal plan IDs to Stripe price IDs
  - optional public plan metadata needed by the frontend such as display label and billing interval
- Keep plan definitions split by concern:
  - `plans.*` remains the internal entitlement and quota model used by `plan-guards.ts`
  - `billing.*` maps commercial Stripe products and prices onto those plan IDs
- Fail fast at startup if billing is enabled but required Stripe configuration is missing or inconsistent with `plans.defaultPlanId` and the configured plan map.

Dependency:

- First. Billing should follow the same config discipline as auth and plans instead of introducing direct `process.env` access in API routes.

### 2. Add normalized billing persistence and repository helpers

Primary files:

- new `packages/db/src/schema/billing-customers.ts`
- new `packages/db/src/schema/billing-subscriptions.ts`
- new `packages/db/src/schema/billing-webhook-events.ts`
- `packages/db/src/schema/users.ts`
- `packages/db/src/schema/user-plans.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/index.ts`
- new `packages/db/src/billing-repository.ts`
- `packages/db/drizzle/` new migration

Changes:

- Add a user-scoped customer table keyed by OpenAIdom `userId` and Stripe `customerId`.
- Add a subscription table that captures the current commercial subscription state separately from `users.planId`, including fields such as:
  - `userId`
  - `stripeCustomerId`
  - `stripeSubscriptionId`
  - internal `planId`
  - Stripe `priceId`
  - subscription `status`
  - `currentPeriodStart`
  - `currentPeriodEnd`
  - `cancelAtPeriodEnd`
  - `canceledAt`
  - `trialEnd`
  - `lastStripeEventAt`
- Add a webhook-event dedupe table keyed by Stripe event ID so webhook delivery remains duplicate-safe and replay-safe.
- Keep `users.planId` and `user_plans` as entitlement tables rather than trying to replace them with raw Stripe objects.
- Add repository helpers for:
  - looking up or creating the billing customer link
  - projecting webhook events into local subscription state
  - applying a plan transition transaction that updates `users.planId` and appends a `user_plans` row together

Dependency:

- Depends on Step 1 because the schema should reflect the internal billing boundary and internal plan model before route code is added.

### 3. Add Stripe service code and authenticated billing routes in the API

Primary files:

- new `apps/api/src/billing/stripe-client.ts`
- new `apps/api/src/billing/entitlement-sync.ts`
- new `apps/api/src/routes/billing.ts`
- `apps/api/src/schemas.ts`
- `apps/api/src/index.ts`

Changes:

- Add a dedicated billing route module rather than mixing Stripe flows into `routes/auth.ts`.
- Add authenticated routes for:
  - `GET /billing/summary`
  - `POST /billing/checkout-session`
  - `POST /billing/customer-portal`
- Add a public webhook endpoint such as `POST /billing/webhook` that validates Stripe signatures before any state mutation.
- Create Stripe customers lazily when a user first starts checkout or needs portal access.
- Stamp checkout sessions with stable OpenAIdom identity metadata such as `userId` and intended `planId` so webhook handling can resolve ownership without trusting a redirect round-trip.
- Keep browser success and cancel redirects informational only. They should never update entitlements directly.
- Persist bounded webhook metadata for audit and diagnostics rather than depending on Stripe alone for debugging.

Dependency:

- Depends on Step 2 because route handlers need durable customer, subscription, and event-dedupe paths.

### 4. Make webhook-driven entitlement sync authoritative for plan enforcement

Primary files:

- new `apps/api/src/billing/entitlement-sync.ts`
- `apps/api/src/plan-guards.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/dashboard.ts`
- `packages/db/src/billing-repository.ts`
- `packages/db/src/schema/user-plans.ts`
- `packages/db/src/schema/users.ts`

Changes:

- Define one authoritative helper that converts Stripe subscription state into internal entitlement transitions.
- Update `users.planId` and insert a new `user_plans` history row in the same transaction whenever a subscription upgrade, downgrade, cancellation, or payment-failure state changes entitlements.
- Keep quota enforcement in `plan-guards.ts`, but make sure billing-originated state changes flow through the same plan IDs those guards already understand.
- Distinguish payment-state failures from ordinary quota failures in API responses. A user blocked because of billing should not receive the same generic response as a user who simply hit a resource cap.
- Extend either `GET /auth/me` or the new `GET /billing/summary` response so the frontend can render:
  - current plan
  - billing status
  - renewal or period-end date
  - cancellation-at-period-end state
  - whether live mode or other paid features are currently blocked

Dependency:

- Depends on Step 3. The API should not mutate plan entitlements from ad hoc route code or frontend assumptions.

### 5. Add signed-in billing surfaces to the web app

Primary files:

- `apps/web/src/lib/api-client.ts`
- `apps/web/src/app/providers/SessionProvider.tsx`
- new `apps/web/src/features/billing/*`
- `apps/web/src/app/App.tsx`
- `apps/web/src/app/layout/Sidebar.tsx`
- `apps/web/src/features/mission-control/MissionControlPage.tsx`

Changes:

- Add typed client methods for the billing summary, checkout-session creation, and portal-session creation routes.
- Add a billing or account page in the authenticated product app rather than forcing users through opaque external links.
- Replace the current raw `planId` display-only treatment with a richer plan surface that can show:
  - plan label
  - billing status
  - renewal date or cancelation state
  - upgrade CTA
  - manage billing CTA
- Keep the frontend session model stable: user identity still comes from auth, while billing state comes from a dedicated summary response or a clearly extended `auth.me` payload.
- Surface payment-required and downgrade warnings cleanly in the UI where users encounter blocked actions.

Dependency:

- Depends on Steps 3 and 4.

### 6. Add rollout-safe migration and reconciliation behavior

Primary files:

- `packages/db/drizzle/` new migration
- new optional `scripts/ts/*` reconciliation utility if needed
- `apps/api/src/routes/billing.ts`
- `packages/db/src/billing-repository.ts`

Changes:

- Existing users should remain on the configured free plan with no Stripe customer row until they begin a billing flow or are backfilled intentionally.
- Make webhook handling idempotent and monotonic enough to tolerate duplicates and some out-of-order delivery.
- If there are pre-existing Stripe subscriptions outside the app, add a one-off reconciliation script or documented operator procedure rather than baking migration-specific logic into the request path.
- Keep billing failure handling loud. If a webhook cannot be applied safely, store the event as failed and make operator follow-up explicit.

Dependency:

- Depends on the earlier billing persistence and route work.

### 7. Expand tests around billing, entitlement changes, and blocked product actions

Primary files:

- new `apps/api/src/routes/billing.test.ts`
- new `apps/api/src/routes/billing.integration.test.ts`
- `apps/api/src/plan-guards.test.ts`
- `apps/api/src/routes/auth.test.ts`
- `apps/web/src/lib/*` tests if frontend test infrastructure is added in this step
- `packages/db/src/billing-repository.integration.test.ts`

Changes:

- Add focused unit tests for:
  - price ID to internal plan resolution
  - webhook event projection and idempotency
  - entitlement transition rules
  - billing-summary response shaping
- Add API integration tests for:
  - authenticated checkout-session creation
  - authenticated customer-portal session creation
  - invalid Stripe signature rejection
  - duplicate webhook handling
  - upgrade, cancel-at-period-end, and payment-failure plan transitions
  - plan-guard behavior after a billing downgrade
- Add at least one end-to-end manual verification path in Stripe test mode:
  - free user starts checkout
  - webhook upgrades the user
  - paid-only action becomes available
  - cancellation or failed payment downgrades access according to the configured rule

Dependency:

- Final step after the billing state machine and route surfaces exist.

## Concrete API And Data Model Notes

These choices should be treated as the default implementation bias unless GTM decisions force a change:

1. Billing is user-scoped, not trading-instance-scoped.
2. Stripe objects should not be read directly during request-time plan checks.
3. `users.planId` remains the fast entitlement cache used by the auth plugin and plan guards.
4. `user_plans` remains append-only history for plan transitions.
5. Webhooks are the only authoritative source for paid entitlement state changes.
6. `GET /billing/summary` is preferable to overloading `GET /auth/me` with too much payment-specific state, unless frontend simplicity clearly wins.

## Risks And Open Questions

1. **GTM may still defer billing.** If early users remain free-tier beta, implementation can stop after the schema plus webhook-ready API boundary and leave the checkout UI for later.
2. **Plan catalog is still underspecified.** The exact paid plans, billing intervals, and trial policy need product decisions before the Stripe price map is final.
3. **Downgrade semantics need an explicit rule.** Decide what happens on `past_due`, payment failure, or cancellation: immediate downgrade, grace period, or block only selected actions.
4. **Tax and invoice requirements may widen scope.** If tax handling, invoicing exports, or region-specific compliance matter now, the first release needs more than Checkout plus Portal.
5. **Multi-agent ownership does not yet imply multi-seat billing.** The current ownership model is user-scoped; do not accidentally couple billing to future agent or bot relationship modeling before that model is finalized.
6. **Frontend wording matters.** The current web app calls trading instances "agents" in Mission Control. Billing UI should avoid promising future autonomous-agent capabilities that are not yet shipped.

## Test Strategy

### Unit tests

- Billing config parsing and Stripe price-map validation.
- Webhook event classification and idempotency rules.
- Entitlement transition rules from Stripe subscription states to internal `planId` values.
- Billing-summary DTO shaping and blocked-state mapping.

### Integration tests

- Stripe webhook signature validation and duplicate-event suppression.
- Customer creation, checkout session creation, and portal session creation for authenticated users.
- Transactional update of `billing_subscriptions`, `users.planId`, and `user_plans` from webhook events.
- Existing plan guards after upgrade and downgrade transitions.
- Authenticated reads of billing summary and ownership-safe access to customer state.

### Manual verification

- Stripe test-mode checkout for a free user upgrading to a paid plan.
- Stripe Customer Portal flow for cancellation and payment-method changes.
- One blocked-action check before upgrade and one after downgrade.
- Frontend handling of pending, active, cancel-at-period-end, and payment-problem states.

## Suggested Delivery Sequence

If this work is split into reviewable PRs, the clean sequence is:

1. config plus schema plus repository groundwork
2. Stripe client plus webhook route plus entitlement sync
3. checkout plus portal endpoints plus billing summary API
4. frontend billing page and blocked-state UX
5. integration hardening and Stripe test-mode verification notes