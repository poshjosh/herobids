# 002 — Plan downgraded to free immediately after upgrade due to Creem checkout webhook being treated as subscription entitlement

- **Status:** FIXED
- **Severity:** HIGH
- **Date:** 2026-08-04
- **Discovered:** Post-deploy verification of billing webhook fixes
- **Environment:** staging (Hetzner, staging.openaidom.com)

## Summary

A paid Creem checkout could produce two entitlement-driving events:

1. `subscription.active` (real subscription object, authoritative)
2. `checkout.completed` (checkout object, non-authoritative for subscription lifecycle)

The code normalized non-top-up `checkout.completed` to `subscription.created`, so entitlement sync treated it like a subscription event. This could create a second subscription row keyed by checkout ID and write an incorrect plan transition (downgrade to free) depending on event ordering/status mapping.

## Symptoms

- Billing UI could show an active paid subscription while account-level plan state regressed to free.
- `user_plans` could show a rapid `starter -> free` transition sequence.
- `billing_subscriptions` could include a row tied to a checkout ID (instead of only real subscription IDs).

## Root Cause

In `apps/api/src/billing/creem-provider.ts`, event mapping treated non-top-up `checkout.completed` as a subscription entitlement event:

```typescript
case 'checkout.completed':
  return 'subscription.created';
```

This is incorrect for entitlement sync. A checkout payload is not the authoritative subscription lifecycle event stream.

## Fix

### 1) Ignore non-top-up `checkout.completed` for entitlement sync

**File:** `apps/api/src/billing/creem-provider.ts`

- Removed mapping of `checkout.completed` to `subscription.created`.
- Top-up checkouts remain supported through the existing explicit branch:
  - `event_type === 'checkout.completed'` with `metadata.checkoutKind === 'top_up'` -> `top_up.completed`
- Non-top-up checkout events now throw `UnknownWebhookEventTypeError` and are safely ignored by webhook routes with HTTP 200.

### 2) Add regression tests

**File:** `apps/api/src/billing/creem-provider.test.ts`

- Added test: non-top-up `checkout.completed` throws `UnknownWebhookEventTypeError`.
- Added test: top-up `checkout.completed` still normalizes to `top_up.completed`.

**File:** `apps/api/src/routes/billing.test.ts`

- Added endpoint-level test: a signed non-top-up `checkout.completed` POST to `/billing/webhook/creem` returns `200` and never calls `EntitlementSync.processEvent`, guarding the route catch block that swallows `UnknownWebhookEventTypeError`.

## Non-fixes (intentional)

- No cap-overwrite logic was added in entitlement sync.
- No change was made to `resolvePlanFromStatus` activation statuses.
- No migration/schema change was required.

Reason: this bug is at Creem webhook normalization boundaries; the minimal safe fix is to stop treating checkout completion as a subscription entitlement event.

## Verification

- `pnpm lint` passed.
- `pnpm test -- apps/api/src/billing/creem-provider.test.ts` passed, including new regression cases.

## Follow-up (data hygiene)

If staging/production already contains checkout-ID rows in `billing_subscriptions`, run a one-time cleanup script/query after review.
