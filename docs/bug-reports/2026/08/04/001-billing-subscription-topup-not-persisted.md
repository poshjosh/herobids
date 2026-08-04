# 001 — Billing subscription and top-up not persisted despite successful payment

- **Status:** OPEN
- **Severity:** HIGH
- **Date:** 2026-08-04
- **Discovered:** Agent evaluation session — user attempted subscribe + top-up, billing page showed no change
- **Environment:** staging (Hetzner, `staging.openaidom.com`)

## Summary

User subscribed to the **starter** plan and added a **$5 top-up** via Creem checkout. Both payments showed "successful" (Creem redirect with `?session=success`). However, the billing page continued to show the account as "over budget" on the `free` plan with `$0.00` hard cap. Investigation revealed **zero database changes** — no subscription record, no plan change, no top-up credit, no webhook event record.

## Symptoms

### User Experience
1. Navigated to `/billing`, clicked **Subscribe** for the starter plan → Creem checkout opened
2. Completed checkout → redirected back to `/billing?session=success&subscription_id=sub_...&product_id=prod_2muSl3xna4UWLN6O9nJcjR`
3. Navigated to `/billing`, clicked a **$5 top-up pack** → Creem checkout opened  
4. Completed top-up → redirected back to `/billing?session=success&order_id=ord_...&product_id=prod_13TZZ9AsdyFtGoY2BqVYAy`
5. Billing page still showed: plan `free`, hard cap `$0.00`, "over budget" warning

### Database State (unchanged)

| Table | Before | After (observed) |
|---|---|---|
| `billing_webhook_events` | 0 rows | **0 rows** |
| `billing_subscriptions` | 0 rows | **0 rows** |
| `billing_customers` | 0 rows | **0 rows** |
| `users.plan_id` | `free` | **`free`** |
| `billing_accounts.active_plan_id` | `free` | **`free`** |
| `billing_accounts.hard_cap_microusd` | 0 | **0** |
| `billing_accounts.status` | `hard_limited` | **`hard_limited`** |
| `billing_periods.included_credit_microusd` | 0 | **0** |
| `billing_periods.credit_applied_microusd` | 0 | **0** |
| `billing_periods.plan_id_snapshot` | `free` | **`free`** |
| `billing_ledger_entries` (by type) | `usage_charge` only | **`usage_charge` only** |

No `top_up_credit`, `plan_change_adjustment`, or `subscription.*` entries appeared in the ledger.

### API Logs — Webhook Endpoint

Three POST requests to `/billing/webhook/creem` were observed, all returning `statusCode: 200`:

| # | content-length | responseTime | creem-signature present |
|---|---|---|---|
| 1 | 2482 | ~5.7ms | yes |
| 2 | 2403 | ~1.9ms | yes |
| 3 | 1948 | ~1.5ms | yes |

**Request characteristics:**
- `user-agent: axios/1.13.1` (not typical of a payment provider webhook)
- `x-forwarded-for: 3.74.66.138`
- `baggage` header contains `sentry-transaction=POST%20%2Fwebhook%2Fyuno`
- `content-type: application/json`
- `via: 1.1 Caddy`

**Application-level logs:** Zero `warn`, `error`, or `debug` logs from the webhook handler were found for the entire evaluation window. The handler produced no observable application-level output.

### What Was NOT Observed

- No rows in `billing_webhook_events` (neither `processed` nor `failed`)
- No `app.log.warn("Creem webhook signature verification failed")` entries
- No `app.log.debug("Ignoring unsupported Creem event type")` entries  
- No `app.log.error("Creem webhook processing failed")` entries
- No worker-side billing/entitlement logs at all

## Configuration Context

`config/staging.yaml`:
```yaml
billing:
  primaryProvider: creem
  fallbackProvider: mock
  creem:
    planProducts:
      starter:
        - creemProductId: "prod_2muSl3xna4UWLN6O9nJcjR"
          interval: month
          displayLabel: "Starter (Monthly)"
          amountCents: 2000
```

Environment variables (verified in both `api` and `worker` containers):
- `CREEM_API_KEY=creem_test_24UpbvzB4ll1clU3sHSGdc` (present)
- `CREEM_WEBHOOK_SECRET=whsec_xV7FXfnN2MJ1DEa93X4Py` (present)

The Creem provider IS configured and the API key IS set.

## Code Paths Checked

The webhook route handler (`apps/api/src/routes/billing.ts:430-470`):
1. Gets the Creem provider from `providerManager` → should succeed (Creem configured)
2. Reads `request.body` as raw string → unknown if this succeeds (no 400 "missing body" log)
3. Calls `creemProvider.verifyWebhook()` to validate HMAC signature → unknown result
4. Calls `entitlementSync.processEvent()` → unknown result
5. If `result.error` → returns 500 (not observed)
6. Otherwise → returns 200 `{ received: true }` (observed)

The `EntitlementSync.processEvent()` method (`apps/api/src/billing/entitlement-sync.ts:29-52`):
1. Checks deduplication via `billingRepo.isEventProcessed(dedupeKey)` → if duplicate, returns `{ processed: false }` (no DB write)
2. Calls `handleEvent()` which dispatches to `handleSubscriptionChange()` or `handleTopUpCompleted()`
3. If `handleEvent` returns `false` (unhandled type) → returns `{ processed: false }` (no DB write)
4. If `handleEvent` throws → calls `recordEventFailed()` → row in `billing_webhook_events` (NOT observed)
5. If `handleEvent` returns `true` → calls `recordEventProcessed()` → row in `billing_webhook_events` (NOT observed)

Given that `billing_webhook_events` has **zero rows**, none of paths 4 or 5 were reached. The only path consistent with zero DB writes + 200 response is path 1 or 3: the event was either treated as a duplicate or returned `false` from `handleEvent`.

## Prior Fixes Ruled Out

- **Bug 002** (`docs/bug-reports/2026/08/03/002-*.md`): Fixes threshold warning display logic and mock top-up error handling. Operates on data already persisted — not reached here because no data was ever persisted.
- **Bug 003** (`docs/bug-reports/2026/08/03/003-*.md`): Fixes `getOrCreateOpenPeriod` to update `includedCreditMicrousd` on plan change. This method is called downstream of `handleSubscriptionChange()` → `getOrCreateBillingAccountForUser()` → runtime billing — none of which were reached.

## Open Questions (for further investigation)

1. Why does `billing_webhook_events` have zero rows despite the webhook route returning 200 three times?
2. What exact Creem event types were sent in those three webhook payloads? (The raw body was not captured in accessible logs.)
3. Why is `user-agent: axios/1.13.1` instead of a Creem-identifying user agent?
4. What is the `POST /webhook/yuno` transaction referenced in the Sentry baggage header?
5. Does the HMAC signature verification pass for these relayed requests? If not, why is there no `warn` log ("Creem webhook signature verification failed")?
6. Is `request.body` arriving as a raw string (required for HMAC verification) or as a parsed JSON object (which would fail the `typeof rawBody !== 'string'` check and return 400)?

## Evidence References

- Staging DB snapshots in `.ignore/eval/2026/08/04/*/db/`
- API access logs in `.ignore/eval/2026/08/04/*/logs/api.log`
- Agent evaluation reports in `.ignore/eval/2026/08/04/*/REPORT.md`
- Staging config: `config/staging.yaml` (billing section)
- Webhook handler: `apps/api/src/routes/billing.ts:430-470`
- Entitlement sync: `apps/api/src/billing/entitlement-sync.ts`
- Creem provider: `apps/api/src/billing/creem-provider.ts`
