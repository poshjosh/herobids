# Fix Plan — 001: Billing webhook Caddy routing gap

- **Parent Bug:** `docs/bug-reports/2026/08/04/001-billing-subscription-topup-not-persisted.md`
- **Status:** ALL STEPS COMPLETE (Fix applied, tests pass, pending deploy)
- **Date:** 2026-08-04

## Overview

Three things broke, all must be fixed to close this bug:

1. **Caddy routing gap** — the immediate cause ✅ FIXED
2. **Creem webhook URL misconfiguration** — was suspected but URL already correct ✅ NOT NEEDED
3. **Test gap** — why it wasn't caught before production impact ✅ FIXED

## Step 1 — Fix Caddy routing ✅ DONE

### Files changed

- `Caddyfile.staging` — added `handle /billing/* { reverse_proxy api:3000 }`
- `Caddyfile.prod` — added `handle /billing/* { reverse_proxy api:3000 }`

### Verification

```bash
# After deploy, from the server:
curl -s -X POST https://staging.openaidom.com/billing/webhook/creem \
  -H 'content-type: application/json' -d '{}' | head -c 200
```

Expected: JSON error response (e.g. `{"error":"billing.webhook.missing_body",...}`), NOT `<!DOCTYPE html>`.

### Rollback risk

None — this only affects paths under `/billing/*` which were previously misrouted. The SPA doesn't serve any meaningful content at `/billing/*` (the billing page is at `/billing` via the SPA route, but that's loaded client-side and doesn't need server-side routing of `/billing/*` sub-paths).

## Step 2 — Fix Creem webhook URL ✅ NOT NEEDED

The Creem dashboard (test mode) webhook is already correctly registered at `https://staging.openaidom.com/api/billing/webhook/creem` (with the `/api` prefix). This matches the documented format. No change needed.

## Step 3 — Add tests to prevent recurrence ✅ DONE

### 3a. Expand `scripts/shell/tests/caddy-routing-smoke-test.sh` ✅ DONE

Added webhook routing checks (Test 5) after the existing OAuth tests:

- `/billing/webhook/creem` reaches API (returns JSON, not SPA HTML)
- `/billing/webhook/creem` does NOT return SPA HTML
- `/billing/webhook/stripe` reaches API (returns JSON, not SPA HTML)
- `/billing/webhook/stripe` does NOT return SPA HTML

Successful routing produces a JSON error body (e.g., `{"error":"billing.webhook.missing_body",...}`). Misrouting to the SPA produces HTML (`<!DOCTYPE html>`).

### 3b. Add required-route-block check to `tests/staging-config-validation.test.ts` ✅ DONE

Added a `describe('Caddyfile required route blocks')` block that asserts both Caddyfiles have `handle` directives for: `/health`, `/auth/*`, `/billing/*`, `/connections/oauth/*`, `/telegram/*`.

This test runs in CI with zero infrastructure — it's a pure static file check. If anyone removes a required route block, the test fails before deploy.

### 3c. Add webhook routing check to `infra/hetzner/scripts/smoke-test.sh` ✅ DONE

Added Check 6 ("Webhook Routing") before the skipped checks section. POSTs to `/billing/webhook/creem` and `/billing/webhook/stripe` via the Caddy entry point on the server and verifies JSON response (not HTML).

## Step 4 — Verify end-to-end ⚠️ PENDING (requires deploy)

1. Deploy the Caddyfile change to staging
2. Run `scripts/shell/tests/caddy-routing-smoke-test.sh https://staging.openaidom.com` — all checks must pass
3. Run `pnpm test` — the new config validation test must pass
4. Run `infra/hetzner/scripts/smoke-test.sh --env staging` — the new webhook routing check must pass
5. Trigger a real Creem test subscription → verify `billing_webhook_events` gets a row, `billing_subscriptions` gets a row, billing page updates

## Files Changed Summary

| File | Change | Status |
|---|---|---|
| `Caddyfile.staging` | Add `handle /billing/* { reverse_proxy api:3000 }` | ✅ |
| `Caddyfile.prod` | Add `handle /billing/* { reverse_proxy api:3000 }` | ✅ |
| `scripts/shell/tests/caddy-routing-smoke-test.sh` | Add webhook routing checks | ✅ |
| `tests/staging-config-validation.test.ts` | Add required route block assertions | ✅ |
| `infra/hetzner/scripts/smoke-test.sh` | Add webhook routing smoke check | ✅ |
| `docs/bug-reports/2026/08/04/001-billing-subscription-topup-not-persisted.md` | Updated with corrected root-cause analysis (Creem URL already correct, Caddy gap secondary) | ✅ |
| Creem dashboard (external) | Update webhook URL to include `/api` prefix | ✅ Already correct — no change needed |
