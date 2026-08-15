# 002 — Creem cancel/upgrade subscription calls use a wrong request shape

- **Status:** FIXED
- **Severity:** HIGH
- **Date:** 2026-08-15
- **Discovered:** User cancelled a starter subscription on staging and got `Billing provider error: property at_period_end should not exist`
- **Environment:** staging (Hetzner, staging.openaidom.com)
- **Component:** `apps/api/src/billing/creem-provider.ts`

## Summary

`CreemProvider.cancelSubscription()` and `CreemProvider.upgradeSubscription()` were implemented against an assumed request shape rather than Creem's actual REST contract (the original design doc, `docs/features/2026/06/06/003-phase-5f-billing/002-multi-provider-plan.md`, flagged this as an unverified risk since no REST reference or SDK source was available at the time). Fetching Creem's real OpenAPI spec (`docs.creem.io/api-reference`) shows both calls are wrong:

- **Cancel** — `POST /v1/subscriptions/{id}/cancel` expects `{ mode: 'immediate' | 'scheduled', onExecute?: 'cancel' | 'pause' }`. Our code sends `{ at_period_end: boolean }`, which Creem's backend rejects outright ("property at_period_end should not exist").
- **Upgrade** — there is no `/subscriptions/{id}/upgrade` endpoint in Creem's API at all. The only subscription-mutation endpoint is `POST /v1/subscriptions/{id}` with body `{ items: [{ product_id, price_id?, units? }], update_behavior }`. Our code posts to a nonexistent `/upgrade` path with a top-level `product_id`.

No test in `creem-provider.test.ts` asserts the outbound request body/path for either call, so neither defect was caught before reaching staging.

## Impact

- Users cannot cancel a Creem-billed subscription via the app (confirmed failing on staging, 502 surfaced to the user).
- Users cannot upgrade/downgrade a Creem-billed subscription via the app (not yet exercised on staging, but will fail identically — likely 404 — the first time it's attempted).

## Fix

`apps/api/src/billing/creem-provider.ts`:

- `cancelSubscription`: now posts `{ mode: 'scheduled', onExecute: 'cancel' }` when `atPeriodEnd` is true, or `{ mode: 'immediate' }` when false — matching `CancelSubscriptionRequestEntity`.
- `upgradeSubscription`: now posts to `/subscriptions/{id}` (no `/upgrade` suffix) with `{ items: [{ product_id }], update_behavior }` — matching `UpdateSubscriptionRequestEntity`.

Both shapes were confirmed against Creem's published OpenAPI spec (`docs.creem.io/api-reference/endpoint/cancel-subscription`, `.../update-subscription`).

Added regression tests in `creem-provider.test.ts` that stub `fetch` and assert the exact request body/path for both calls (immediate and scheduled cancel; prorated and non-prorated upgrade) — closing the coverage gap that let the original defect reach staging.

## Verification

- `pnpm lint` passes.
- `apps/api/src/billing/*.test.ts` — 63 tests pass, including 4 new cancel/upgrade payload assertions.

## Follow-up — upgrade still risked double-billing (found in code review)

The initial `upgradeSubscription` fix posted `items: [{ product_id: newProductId }]` with no item `id`. Per Creem's `UpdateSubscriptionRequestEntity` spec, an item without an `id` is **created**, not updated — so a plan change would append a second billable subscription item instead of replacing the existing one.

Reworked `upgradeSubscription` in `creem-provider.ts` to avoid guessing:

1. `PaymentProvider.upgradeSubscription()` now takes the subscription's *current* provider product/price id in addition to the target one (threaded through `provider-manager.ts` and the `/billing/upgrade-subscription` route, which already had `subscription.externalPriceOrProductId` on hand).
2. `CreemProvider.upgradeSubscription()` first does `GET /subscriptions/{id}` (new `get()` helper) and matches exactly one item whose `product_id`/`price_id` equals the current id.
3. If zero or more than one item matches, or the matched item has no `id`, it throws `CreemSubscriptionItemMismatchError` instead of updating — refusing to guess rather than risking a duplicate billable item.
   - Note: the retrieve-subscription call uses `GET /subscriptions?subscription_id={id}` (query param), not `GET /subscriptions/{id}` (path) — verified against Creem's actual OpenAPI spec after an initial path-based guess was caught before being tested live.
4. The subsequent `POST /subscriptions/{id}` now includes `items: [{ id: matchedItem.id, product_id: newProductId }]`, which replaces the existing item.

Stripe's adapter already had this exact pattern (`stripe-client.ts:updateSubscriptionPrice` fetches the subscription first and includes the existing item id) — Creem now matches it. `MockProvider`/`StripeProvider` signatures were updated to accept the new parameter (Stripe ignores it, since its client resolves the item id independently).

## Verification (follow-up)

- `pnpm lint` passes.
- `apps/api/src/billing/*.test.ts` and `apps/api/src/routes/billing.test.ts` — 83 tests pass, including new coverage for: matched-item update, no-match, ambiguous-match, and matched-item-missing-id cases.

