# 001 — Billing webhook requests routed to SPA instead of API (subscription/top-up silently lost)

- **Status:** OPEN
- **Severity:** HIGH
- **Date:** 2026-08-04
- **Discovered:** Agent evaluation session — user subscribed to starter plan + topped up $5 via Creem; billing page showed no change
- **Environment:** staging (Hetzner, `staging.openaidom.com`)

## Summary

User completed a Creem checkout for a **starter** plan subscription and a **$5 top-up**. Both showed "payment successful" (`?session=success` redirect). The billing page continued to show `free` plan with `$0.00` hard cap and "over budget."

The root cause is a **Caddy reverse-proxy routing gap**: webhook POSTs to `/billing/webhook/creem` are routed to the `web` (nginx/SPA) container instead of the `api` (Fastify) container, because neither `Caddyfile.staging` nor `Caddyfile.prod` contains a `handle /billing/*` block. The SPA's nginx `try_files` fallback returns `200 OK` with `index.html` for any unmatched path, so the webhook is silently acknowledged without ever reaching application code.

The plan document `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md` explicitly instructs registering webhooks at `https://staging.openaidom.com/api/billing/webhook` (with the `/api` prefix), but this requirement was not enforced by configuration.

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

### API Logs — Three Observed Requests, All Returned 200

| # | responseTime | Notes |
|---|---|---|
| 1 | ~5.7ms | `content-length: 2482` |
| 2 | ~1.9ms | `content-length: 2403` |
| 3 | ~1.5ms | `content-length: 1948` |

### Application Logs — Complete Absence

**Zero** application-level logs (`warn`, `error`, `debug`, `info`) from the webhook handler, `EntitlementSync`, or any billing-related code for the entire evaluation window. This is the key signal: the requests never reached the Fastify process.

## Root Cause

### Caddy routes `/billing/webhook/creem` to the SPA, not the API

`Caddyfile.staging` (and `Caddyfile.prod` — identical routing structure):

```caddy
handle /health           { reverse_proxy api:3000 }
handle_path /api/*       { reverse_proxy api:3000 }
handle /auth/callback    { reverse_proxy web:80 }
handle /auth/*           { reverse_proxy api:3000 }
handle /connections/oauth/* { reverse_proxy api:3000 }
handle                   { reverse_proxy web:80 }  # ← catch-all
```

There is **no `handle /billing/*`** block. The path `/billing/webhook/creem` does not match `/health`, `/api/*`, `/auth/callback`, `/auth/*`, or `/connections/oauth/*`. It falls through to the final catch-all `handle { reverse_proxy web:80 }` — the SPA container.

### nginx SPA fallback returns 200 for all unmatched paths

`docker/nginx.conf`:
```nginx
location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache" always;
}
```

The webhook POST to `/billing/webhook/creem` doesn't match any static file, so nginx serves `/index.html` with `200 OK`. The webhook body is discarded. The Creem webhook delivery system sees `200` and marks the event as delivered — but it was delivered to an SPA, not to the billing handler.

### Why response times were 1.5–5.7ms

nginx serving a static `index.html` from disk is extremely fast — consistent with the SPA fallback, inconsistent with a handler that does HMAC verification + multiple DB queries.

### Why `user-agent` was `axios/1.13.1`

The `user-agent: axios/1.13.1` and `sentry-transaction=POST /webhook/yuno` baggage header are properties of the requesting client. These are forwarded transparently by Caddy/nginx and have no bearing on the routing failure — they would have been present regardless of which upstream served the request.

### Why the `?session=success` redirect didn't help

The redirect is decorative only — there is no synchronous reconciliation on page load. Persistence depends **entirely** on the webhook arriving at the correct Fastify handler. A routing miss is a total, silent failure with no fallback.

### Documented webhook URL format (not followed)

`docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md:125`:

> Add or switch webhook endpoints to `https://staging.openaidom.com/api/billing/webhook` or provider-specific equivalents.

The documented URL uses the `/api` prefix. The Creem dashboard's registered webhook URL for the staging test-mode account should be `https://staging.openaidom.com/api/billing/webhook/creem` — not `/billing/webhook/creem`.

### Why prior fix 002 and 003 are not relevant

Both fixes operate on data that is only persisted after a webhook successfully reaches `EntitlementSync.processEvent()` in the Fastify process. Since the webhook never reaches Fastify, neither fix's code path is executed.

### Why the original investigation's "duplicate" and "unhandled event type" hypotheses were wrong

- **Duplicate:** `isEventProcessed` queries `billing_webhook_events` for `WHERE id = eventId AND status = 'processed'`. With 0 rows in the table, this can never return true.
- **Unhandled event type:** `NormalizedEventType` has exactly 5 literal values (`provider-port.ts:40-45`). `EntitlementSync.handleEvent` explicitly handles all 5 in its switch statement (`entitlement-sync.ts:56-67`). The `default: return false` branch is unreachable from a real Creem webhook after normalization.

## Fix

**Option A — Add explicit Caddy route (defense-in-depth, recommended as primary fix):**

Add to `Caddyfile.staging` AND `Caddyfile.prod`, before the catch-all `handle` block:
```caddy
handle /billing/* {
    reverse_proxy api:3000
}
```

**Option B — Fix the Creem webhook URL (also needed):**

In the Creem dashboard (test mode for staging), update the registered webhook URL from `https://staging.openaidom.com/billing/webhook/creem` to `https://staging.openaidom.com/api/billing/webhook/creem`.

**Both A and B should be applied** — Option A protects against future routing gaps for any `/billing/*` path, and Option B ensures the webhook URL matches the documented format.

The same check should be performed for the Stripe webhook if configured.

## Additional Consideration

The `?session=success` redirect on the billing page is purely cosmetic. If webhook delivery fails (e.g., routing gap, network issue, Creem outage), there is no fallback reconciliation. Consider adding a synchronous check on page load: if the URL contains `?session=success` with a `subscription_id` or `order_id`, query the Creem API directly to confirm the subscription/payment status and reconcile if the webhook was missed.

## Evidence References

- `Caddyfile.staging` (lines 1–28): No `/billing/*` handle block
- `Caddyfile.prod` (lines 1–28): Same gap
- `docker/nginx.conf` (lines 38–42): SPA `try_files` fallback returns 200
- `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md:125`: Documents correct webhook URL with `/api` prefix
- `apps/api/src/billing/provider-port.ts:40-45`: `NormalizedEventType` has exactly 5 values, all handled
- `apps/api/src/billing/entitlement-sync.ts:56-67`: `handleEvent` switch handles all 5 types
- `apps/api/src/routes/billing.ts:430-470`: Webhook route handler
- `packages/db/src/billing-repository.ts:234-270`: `isEventProcessed`/`recordEventProcessed`/`recordEventFailed`
- Staging DB evidence: `.ignore/eval/2026/08/04/*/db/`
- API access logs: `.ignore/eval/2026/08/04/*/logs/api.log`
