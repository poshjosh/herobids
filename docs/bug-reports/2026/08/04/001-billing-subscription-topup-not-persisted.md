# 001 — Creem webhooks silently dropped due to `eventType` vs `event_type` field name mismatch

- **Status:** OPEN
- **Severity:** HIGH
- **Date:** 2026-08-04
- **Discovered:** Agent evaluation session — user subscribed to starter plan + topped up $5 via Creem; billing page showed no change
- **Root cause confirmed:** 2026-08-04 14:45 UTC via controlled webhook test on staging
- **Environment:** staging (Hetzner, `staging.openaidom.com`)

## Summary

User completed a Creem checkout for a **starter** plan subscription and a **$5 top-up**. Both showed "payment successful" (`?session=success` redirect). The billing page continued to show `free` plan with `$0.00` hard cap and "over budget." Investigation confirmed **zero database changes** — no subscription record, no plan change, no top-up credit, no webhook event record.

**Root cause:** The `CreemWebhookPayload` TypeScript interface (`apps/api/src/billing/creem-provider.ts:235-237`) declares the top-level event type field as `event_type` (snake_case), but Creem's actual webhook payloads use `eventType` (camelCase). When `event.event_type` is `undefined`, the `mapCreemEventType()` function hits its `default` branch and throws `UnknownWebhookEventTypeError`. The route handler catches this and returns `200 {"received": true}` with a silenced debug log — the webhook is acknowledged but **never processed**.

This affects **all Creem webhook event types** — subscription creation, subscription updates, payment failures, and top-up completions. Every Creem webhook since the provider was implemented has been silently dropped.

A controlled test confirmed the root cause:
- Webhook sent with `eventType` (camelCase, Creem's actual format) → `200 {"received": true}`, zero DB changes ❌
- Webhook sent with `event_type` (snake_case, what the code expects) → `200 {"received": true}`, `billing_webhook_events` row created, `top_up_credit` ledger entry created, balance updated ✅

### Secondary finding: Caddy routing gap (FIXED)

Three POST requests to `/billing/webhook/creem` (**without** the `/api` prefix) were observed from the local dev ngrok relay. Neither `Caddyfile.staging` nor `Caddyfile.prod` had `handle /billing/*` or `handle /telegram/*` blocks. These gaps have been fixed as defense-in-depth but were **not the cause** of this bug — the real Creem webhooks use the `/api` prefix which Caddy routes correctly.

## Symptoms

### User Experience
1. Clicked **Subscribe** for starter plan → completed Creem checkout → redirected to `/billing?session=success&subscription_id=sub_5YG1a0Mhnb4JbJ8PN2TUUa&product_id=prod_2muSl3xna4UWLN6O9nJcjR`
2. Clicked **$5 top-up** → completed Creem checkout → redirected to `/billing?session=success&order_id=ord_3FXbtreerVChkYHyhMb5Hk&product_id=prod_13TZZ9AsdyFtGoY2BqVYAy`
3. Billing page still showed `free` plan, `$0.00` hard cap, "over budget"

### Database — Zero Changes

| Table | Before | After |
|---|---|---|
| `billing_webhook_events` | 0 rows | **0 rows** |
| `billing_subscriptions` | 0 rows | **0 rows** |
| `billing_customers` | 0 rows | **0 rows** |
| `users.plan_id` | `free` | **`free`** |
| `billing_accounts.active_plan_id` | `free` | **`free`** |
| `billing_accounts.hard_cap_microusd` | 0 | **0** |
| `billing_periods.included_credit_microusd` | 0 | **0** |
| `billing_periods.credit_applied_microusd` | 0 | **0** |

### API Logs

- **Three requests** to `/billing/webhook/creem` (without `/api` prefix) — returned 200, 1.5–5.7ms response times, `user-agent: axios/1.13.1`. Identified as **local dev ngrok relay**, not Creem.
- **Zero requests** to `/api/billing/webhook/creem` (the Creem-registered URL) found in the evaluation window.
- **Zero** application-level logs (`warn`, `error`, `debug`, `info`) from the webhook handler or `EntitlementSync`.

## Root Cause

### `CreemWebhookPayload` interface uses `event_type` but Creem sends `eventType`

`apps/api/src/billing/creem-provider.ts:235-237`:
```typescript
interface CreemWebhookPayload {
  id?: string;
  event_type: string;   // ← expects snake_case
  ...
}
```

The `verifyWebhook` method parses the JSON body directly into this interface:
```typescript
const event = JSON.parse(payload) as CreemWebhookPayload;
return this.normalizeEvent(event);
```

`normalizeEvent` accesses `event.event_type` (line 111, 129, 138). When Creem sends the payload with `eventType` (camelCase), `event.event_type` is `undefined`. The code path:

1. Line 111: `event.event_type === 'checkout.completed'` → `false` (undefined !== 'checkout.completed')
2. Falls through to line 129: `mapCreemEventType(event.event_type)` → `mapCreemEventType(undefined)`
3. `mapCreemEventType` hits `default:` → throws `UnknownWebhookEventTypeError(undefined)`

The route handler catches this:
```typescript
if (err instanceof UnknownWebhookEventTypeError) {
    app.log.debug({ eventType: err.eventType }, 'Ignoring unsupported Creem event type');
    return reply.status(200).send({ received: true });
}
```

Returns `200 {"received": true}` — Creem marks the webhook as delivered, but **nothing was processed**.

### Why no debug log was found

The staging YAML declares `app.logLevel: debug`, but Pino (Fastify's logger) defaults to `info` level. Debug messages are suppressed at runtime. The `"Ignoring unsupported Creem event type"` log was never emitted, making the failure completely silent.

### Controlled test confirmation

| Test | Payload field | Result |
|---|---|---|
| 1 | `"eventType": "checkout.completed"` (Creem's actual format) | 200, zero DB changes ❌ |
| 2 | `"event_type": "checkout.completed"` (what code expects) | 200, webhook event created, $5 credit applied ✅ |

Test 2 produced:
- `billing_webhook_events`: 1 row (`creem:evt_5QPka50r6EuwzaglJQpda`, status `processed`)
- `billing_ledger_entries`: 1 row (`top_up_credit`, 5,000,000 microUSD)
- `billing_periods.balance_microusd`: -363,720 → +4,634,480

### This affects ALL Creem webhook types

The `event_type`/`eventType` mismatch prevents **all** Creem webhook processing:
- `subscription.active` / `checkout.completed` → subscription creation (plan upgrade)
- `subscription.paid` / `subscription.update` → subscription updates
- `subscription.canceled` → subscription cancellation
- `subscription.past_due` → payment failure handling
- `checkout.completed` (top_up) → top-up credit

Every Creem webhook since the provider was implemented has been silently dropped.

### Additional bug: account stays `hard_limited` after top-up

After the top-up credit is applied, `recomputeSpendState` runs but the account remains `hard_limited` because `hard_cap_microusd: 0`. The user has $4.63 in balance but can't spend it because the free plan's hard cap is $0. This is a separate issue — even after the `event_type` fix, the user still can't use the credit for LLM spending without a plan upgrade (which itself requires a working webhook).

### Why the test suite didn't catch this

| Test | Gap |
|---|---|
| `caddy-routing-smoke-test.sh` | Only tests OAuth routing; never tests billing/webhook paths |
| `staging-config-validation.test.ts` | Only checks Caddyfile domain isolation; never validates route block coverage |
| `creem-provider.test.ts` / `entitlement-sync.test.ts` | Unit tests with no Caddy/HTTP layer |
| `billing.test.ts` | Tests Fastify handlers directly; no Caddy |
| `run-all-tests.sh` E2E | Playwright browser UI; never simulates real webhook delivery |

### Why prior fix 002 and 003 are not relevant

Both operate downstream of `EntitlementSync.processEvent()` — which was never reached.

## Fix

### 1. Fix Creem webhook field name mismatch (PRIMARY FIX — not yet applied)

**File:** `apps/api/src/billing/creem-provider.ts`

In `verifyWebhook()`, normalize the field name before passing to `normalizeEvent`:

```typescript
const raw = JSON.parse(payload);
// Creem sends "eventType" (camelCase) but our interface uses "event_type" (snake_case).
// Normalize so both forms work.
const event: CreemWebhookPayload = {
  ...raw,
  event_type: raw.event_type ?? raw.eventType ?? '',
};
return this.normalizeEvent(event);
```

Or alternatively, update the `CreemWebhookPayload` interface to accept both:

```typescript
interface CreemWebhookPayload {
  id?: string;
  event_type?: string;
  eventType?: string;   // Creem's actual field name
  ...
}
```

And in `normalizeEvent`, read `event.eventType ?? event.event_type`.

### 2. Add Caddy route blocks ✅ DONE

Added `handle /billing/*` and `handle /telegram/*` to both `Caddyfile.staging` and `Caddyfile.prod`. Defense-in-depth — not the root cause but prevents SPA fallthrough for misrouted requests.

### 3. Add tests ✅ DONE

- `caddy-routing-smoke-test.sh` — webhook routing checks
- `staging-config-validation.test.ts` — required Caddy route block assertions (45/45 pass)
- `smoke-test.sh` — webhook routing smoke check

### 4. Fix Pino log level to respect `app.logLevel` (RECOMMENDED)

Staging config sets `app.logLevel: debug` but Pino defaults to `info`. The `UnknownWebhookEventTypeError` debug log was suppressed, making this bug completely silent. Either configure Pino to respect the app log level, or promote the "Ignoring unsupported event type" message to `warn` level so it's always visible.

## Additional Consideration

Even after the webhook fix, the `free` plan's `hard_cap_microusd: 0` prevents LLM spending regardless of balance. A plan upgrade webhook must succeed first to set a non-zero hard cap. Both the subscription and top-up webhooks are affected by the same `eventType`/`event_type` mismatch.

## Open Questions

1. **Verify actual Creem webhook field name** — check the raw body of a real Creem webhook delivery (not the dashboard resend UI) to confirm it uses `eventType`. The dashboard may format it differently from the actual webhook POST.
2. **Apply code fix and re-deploy** — then trigger fresh subscription + top-up checkouts
3. **Verify plan upgrade works** — after the fix, a Creem `subscription.active` webhook should set `users.plan_id = 'starter'`, `billing_accounts.active_plan_id = 'starter'`, and a non-zero `hard_cap_microusd`

## Evidence References

- `Caddyfile.staging` / `Caddyfile.prod` (pre-fix): No `/billing/*` or `/telegram/*` handle blocks
- `docker/nginx.conf` (lines 38–42): SPA `try_files` fallback returns 200
- `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md:125`: Documents correct webhook URL with `/api` prefix
- `scripts/shell/tests/caddy-routing-smoke-test.sh`: Prior Caddy routing bug (auth) — same class, different path
- `apps/api/src/billing/provider-port.ts:40-45`: `NormalizedEventType` has exactly 5 values, all handled
- `apps/api/src/billing/entitlement-sync.ts:56-67`: `handleEvent` switch handles all 5 types
- `apps/api/src/routes/billing.ts:430-470`: Webhook route handler
- `packages/db/src/billing-repository.ts:234-270`: `isEventProcessed`/`recordEventProcessed`/`recordEventFailed`
- Staging DB evidence: `.ignore/eval/2026/08/04/*/db/`
- API access logs: `.ignore/eval/2026/08/04/*/logs/api.log`
