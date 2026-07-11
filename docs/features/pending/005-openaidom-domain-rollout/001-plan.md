# Plan: Lowest-Risk Rollout for `openaidom.com`

**Status:** Proposed  
**Created:** 2026-07-11  
**Goal:** Move the public Herobids deployment from `herobids.com` to `openaidom.com` with the lowest practical risk, using the existing Hetzner infrastructure and a staging-first rehearsal.

---

## Summary

This plan assumes:
- The app, API, worker, database, Redis, and Hetzner servers remain the same.
- We are changing the public domain only.
- Internal names such as `herobids`, Docker image names, package names, database names, and systemd units are **not** being renamed in this rollout.

The safest rollout is:
1. Rehearse the full move on staging with `staging.openaidom.com`.
2. Prepare production DNS and third-party dashboards ahead of time.
3. Perform a narrow production cutover window where the canonical app origin changes from `herobids.com` to `openaidom.com`.
4. Verify OAuth, billing, and webhooks immediately after deploy.
5. Keep the old domain only as a redirect or temporary fallback, not as a fully supported second app origin.

---

## Current Constraints

The current production setup has a few important constraints that shape the rollout order:

1. The API is configured with a single `AUTH_PUBLIC_BASE_URL` and a single `AUTH_FRONTEND_ORIGIN`.
2. CORS currently allows a single configured frontend origin.
3. The SPA build uses a single `VITE_API_ORIGIN` for auth initiation.
4. Billing success/cancel URLs are derived from the configured frontend origin.
5. Telegram and payment-provider webhooks are bound to specific public URLs.

Because of this, the lowest-risk plan is **not** to run `herobids.com` and `openaidom.com` as two equal first-class app origins at the same time. With the current code, one domain should be canonical during the cutover.

---

## Rollout Principles

1. Rehearse the exact cutover pattern on staging before touching production.
2. Change DNS with low TTLs so rollback is fast.
3. Update OAuth and billing dashboards before flipping canonical production URLs.
4. Change production deploy config and webhook endpoints in one controlled window.
5. Keep rollback simple: restore old env values, reverse-proxy hostnames, and provider callback targets.

---

## Planned Repo Changes

The rollout will likely require changes in these repo surfaces:

| Area | Likely files |
|---|---|
| Terraform domain defaults | `infra/hetzner/variables.tf`, `infra/hetzner/staging.tfvars`, `infra/hetzner/production.tfvars`, `infra/hetzner/*.example` |
| Reverse proxy | `Caddyfile.staging`, `Caddyfile.prod` |
| Deploy overlays | `docker-compose.staging.yaml`, `docker-compose.prod.yaml` |
| Environment files | `infra/hetzner/.env.staging`, `infra/hetzner/.env.prod` |
| Docs and legal/public contact info | `apps/web/src/features/public-pages/content/**`, `infra/hetzner/README.md`, `infra/hetzner/docs/setup-domain.md` |

These changes should be prepared and reviewed before the production cutover window.

---

## Phase 0: Preconditions and Freeze

Complete these before any hostname changes:

1. Confirm ownership and DNS control of `openaidom.com`.
2. Decide final production hostnames:
   - Minimum: `openaidom.com`
   - Optional aliases: `www.openaidom.com`, `app.openaidom.com`
   - Staging: `staging.openaidom.com`
3. Decide old-domain policy:
   - Recommended: keep `herobids.com` temporarily as an HTTP redirect only.
   - Avoid keeping it as a fully functional second app origin during the cutover.
4. Set DNS TTLs to a low value, ideally `300`, at least 24 hours before production cutover.
5. Freeze unrelated production config changes during the cutover window.
6. Take backups of:
   - current production `.env.prod`
   - current staging `.env.staging`
   - current OAuth redirect/origin settings
   - current billing webhook settings
   - current Telegram webhook configuration

---

## Phase 1: Staging Rehearsal on `staging.openaidom.com`

This is the most important risk-reduction step. Do not cut production before this is green.

### 1. DNS

1. Create `staging.openaidom.com` `A` record pointing to the current staging server IP.
2. Add `AAAA` only if staging is already serving IPv6 correctly.
3. Keep staging TTL low during validation.

### 2. Staging Deploy Config

Update staging config to make `staging.openaidom.com` the canonical staging origin:

1. Set `app_domain = "staging.openaidom.com"` in staging Terraform vars.
2. Update staging Caddy hostnames to `staging.openaidom.com`.
3. Update staging compose/env values:
   - `AUTH_PUBLIC_BASE_URL=https://staging.openaidom.com`
   - `AUTH_FRONTEND_ORIGIN=https://staging.openaidom.com`
   - `VITE_API_ORIGIN=https://staging.openaidom.com`
   - `TELEGRAM_WEBHOOK_URL=https://staging.openaidom.com/api/telegram/webhook`

### 3. OAuth Staging Update

Before testing login, add the staging domain to the OAuth provider configuration:

1. Authorized JavaScript origin: `https://staging.openaidom.com`
2. Redirect URI: `https://staging.openaidom.com/auth/google/callback`

### 4. Billing Staging Update

If staging uses real or test billing providers:

1. Add or switch webhook endpoints to `https://staging.openaidom.com/api/billing/webhook` or provider-specific equivalents.
2. Verify checkout returns land back on `https://staging.openaidom.com/billing`.
3. Use test mode only.

### 5. Webhook Staging Update

1. Re-register Telegram webhook to `https://staging.openaidom.com/api/telegram/webhook`.
2. If any other public webhooks exist, repoint them in staging too.

### 6. Staging Smoke Test

All of these must pass:

1. `GET /health`
2. SPA loads at `https://staging.openaidom.com`
3. Google OAuth login completes end-to-end
4. Email login link redirects to the new staging host
5. Billing checkout success/cancel returns to the new staging host
6. Billing webhooks are accepted and processed
7. Telegram webhook receives and processes a test message

If staging fails on any of these, stop and fix staging before touching production.

---

## Phase 2: Production Preparation Before Cutover Day

Do this before the actual production flip.

### 1. DNS Preparation

Create production DNS records in advance:

1. `openaidom.com` → production server IPv4
2. `www.openaidom.com` → production server IPv4, if used
3. `app.openaidom.com` → production server IPv4, if used
4. `AAAA` records only if production already serves IPv6 correctly

Creating these records early is low risk because they do not affect the old domain.

### 2. Production Config Preparation

Prepare but do not yet activate the production config changes in the repo:

1. `app_domain = "openaidom.com"`
2. Production Caddy hostnames changed to `openaidom.com` and chosen aliases
3. `AUTH_PUBLIC_BASE_URL=https://openaidom.com`
4. `AUTH_FRONTEND_ORIGIN=https://openaidom.com`
5. `VITE_API_ORIGIN=https://openaidom.com`
6. `TELEGRAM_WEBHOOK_URL=https://openaidom.com/api/telegram/webhook`
7. Public-facing email/contact text updated where needed

### 3. OAuth Production Preparation

Before the production deploy window:

1. Add `https://openaidom.com` as an authorized origin.
2. Add `https://openaidom.com/auth/google/callback` as an authorized redirect URI.
3. If using `www` or `app`, add only the exact hostnames that will actually be used.
4. Do **not** remove `herobids.com` entries until production verification is complete.

### 4. Billing Production Preparation

Prepare the provider dashboards before deploy:

1. Stripe:
   - create or prepare webhook endpoint for `https://openaidom.com/api/billing/webhook/stripe`
   - confirm product/price mapping remains unchanged
2. Creem:
   - create or prepare webhook endpoint for `https://openaidom.com/api/billing/webhook/creem`
   - confirm return flows allow `https://openaidom.com`
3. Confirm customer portal return URL policy allows the new domain.
4. Leave the old webhook endpoint in place until the production cutover succeeds, if the provider supports this.

### 5. Webhook Production Preparation

1. Prepare Telegram webhook change command or operator runbook.
2. List every public webhook that references `herobids.com` and prepare its new target.

---

## Phase 3: Production Cutover Window

This should be a short, operator-driven window after staging is proven green.

### Ordered Steps

1. Confirm no unrelated deploy is in progress.
2. Confirm low DNS TTLs are active.
3. Verify `openaidom.com` DNS resolves to the current production server IP.
4. Snapshot current production state:
   - current compose overlays
   - current `Caddyfile.prod`
   - current `.env.prod`
   - current OAuth and billing dashboard values
5. Deploy the production config that makes `openaidom.com` canonical.
6. Let Caddy obtain TLS certificates for `openaidom.com` and chosen aliases.
7. Run immediate smoke tests on the new domain.
8. Switch Telegram webhook to the new domain.
9. Switch or enable billing webhooks on the new domain if not already dual-registered.
10. Verify a real OAuth login from the new domain.
11. Verify a real billing flow from the new domain.
12. Verify the old domain behavior:
   - recommended: redirect to `https://openaidom.com`
   - acceptable temporary fallback: leave old domain reachable for a short window, but do not treat it as canonical for login or billing

### Immediate Production Verification

Run these checks in order:

1. `https://openaidom.com/health` returns `200`
2. SPA loads and API calls succeed
3. Google login completes and returns to `https://openaidom.com/auth/callback`
4. Email login link lands on the new domain
5. Billing summary page loads for an authenticated user
6. Checkout success and cancel return to `https://openaidom.com/billing`
7. Provider webhook delivery is successful
8. Telegram webhook is registered and receives a test message

If any of items 3 through 8 fail, treat the cutover as incomplete and either fix immediately or roll back.

---

## Phase 4: Post-Cutover Cleanup

Only do this after production has been stable on `openaidom.com` for at least one monitoring window.

1. Remove `herobids.com` from OAuth origins and redirect URIs if no longer needed.
2. Remove old billing webhook endpoints if the provider had both old and new active.
3. Remove old Telegram webhook references from docs and scripts.
4. Update remaining public/legal/email references from `herobids.com` to `openaidom.com`.
5. Decide whether `herobids.com` remains a redirect indefinitely or is retired.

---

## Rollback Plan

Rollback must be possible without rebuilding infrastructure.

### Trigger Conditions

Roll back if any of the following remain broken after a short repair attempt:

1. Google login fails on production
2. Billing checkout cannot complete
3. Billing webhooks are rejected or not delivered
4. Telegram webhook cannot be restored quickly
5. SPA or API is unhealthy on `openaidom.com`

### Rollback Order

1. Restore production env values:
   - `AUTH_PUBLIC_BASE_URL=https://herobids.com`
   - `AUTH_FRONTEND_ORIGIN=https://herobids.com`
   - `VITE_API_ORIGIN=https://herobids.com`
   - `TELEGRAM_WEBHOOK_URL=https://herobids.com/api/telegram/webhook`
2. Restore `Caddyfile.prod` hostnames to `herobids.com` and current aliases.
3. Redeploy production.
4. Restore OAuth origins and redirect URIs to `herobids.com`.
5. Restore billing webhook endpoints to `https://herobids.com/...`.
6. Re-register Telegram webhook on `https://herobids.com/api/telegram/webhook`.
7. Re-run production smoke tests on the old domain.

Because the servers and application stack do not change, rollback should be fast if the old config snapshots are preserved.

---

## Acceptance Criteria

The rollout is complete when:

1. Staging runs successfully on `staging.openaidom.com`.
2. Production runs successfully on `openaidom.com`.
3. OAuth works end-to-end on the new production domain.
4. Billing checkout, customer portal return, and webhook processing work on the new domain.
5. Telegram webhook works on the new domain.
6. Old-domain handling is deliberate and documented: redirect, temporary fallback, or retirement.
7. Repo docs and deploy defaults no longer point operators at `herobids.com` as the canonical domain.

---

## Recommended Follow-Up

If we later want truly seamless dual-domain support, that should be a separate feature. It would likely require:

1. Multi-origin auth/CORS configuration instead of a single frontend origin.
2. Clear canonical-domain handling in the SPA and API.
3. A deliberate compatibility window where both domains are first-class supported hosts.

That is not necessary for the lowest-risk domain move described here.