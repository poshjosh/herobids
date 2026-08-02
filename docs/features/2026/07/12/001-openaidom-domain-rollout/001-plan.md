# Plan: OpenAIdom Domain Rollout

**Status:** Done  
**Created:** 2026-07-11  
**Goal:** Make OpenAIdom the only public hostname set for staging and the first production launch, using the existing Hetzner infrastructure without preserving the old `herobids.com` domain.

---

## Summary

### Sequencing with Brand Rollout

The visual branding rollout (`docs/features/2026/07/12/002-openaidom-brand-rollout/001-plan.md`) was completed **before** the domain cutover. All 8 implementation slices (Slices 1–8) — asset pipeline, BrandLogo component, app shell, browser metadata, theme tokens, branded email renderer, email migration, and public-docs copy — are already shipped. Slice 9 (internal documentation) is included in this rollout. The web UI, emails, and public docs already read as OpenAIdom. The domain cutover in this plan is the subsequent step: it changes the hostname that serves the already-branded product.

This plan assumes:
- The app, API, worker, database, Redis, and Hetzner servers remain the same.
- We are changing the public domain only.
- Internal names such as `herobids`, Docker image names, package names, database names, and systemd units are **not** being renamed in this rollout.
- There is no existing production deployment to preserve.
- `staging.herobids.com` and all other `herobids.com` public hostnames can be retired rather than supported in parallel.

The implementation sequence is:
1. Finish the staging hostname cutover to `staging.openaidom.com`.
2. Remove old-domain references from infra, env defaults, dashboards, and public docs.
3. Prepare production to launch for the first time on `openaidom.com`, with `www.openaidom.com` and `app.openaidom.com` as supported aliases.
4. Verify OAuth, billing, and webhooks on the OpenAIdom hostnames only.

---

## Current Constraints

The current production setup has a few important constraints that shape the rollout order:

1. The API is configured with a single `AUTH_PUBLIC_BASE_URL` and a single `AUTH_FRONTEND_ORIGIN`.
2. CORS currently allows a single configured frontend origin.
3. The SPA build uses a single `VITE_API_ORIGIN` for auth initiation.
4. Billing success/cancel URLs are derived from the configured frontend origin.
5. Telegram and payment-provider webhooks are bound to specific public URLs.

Because of this, each environment should have exactly one canonical origin during rollout:

1. staging canonical origin: `https://staging.openaidom.com`
2. production canonical origin: `https://openaidom.com`

Alias hostnames may terminate TLS and route traffic, but auth, billing, webhooks, and docs should all treat the canonical hostname above as the source of truth.

---

## Rollout Principles

1. Complete the staging cutover before the first production launch.
2. Keep DNS TTLs low while changing hostnames.
3. Update OAuth and billing dashboards before activating new canonical URLs.
4. Remove `herobids.com` public-hostname references instead of preserving a parallel old-domain path.
5. Keep rollback simple: revert to the last known-good OpenAIdom staging or production config rather than reintroducing the retired domain.

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

## Phase 0: Resolved Preconditions

These decisions are already resolved and should be treated as locked inputs for implementation:

1. Ownership and DNS control of `openaidom.com` are confirmed.
2. Final production hostnames are locked to:
   - canonical: `openaidom.com`
   - aliases: `www.openaidom.com`, `app.openaidom.com`
   - staging: `staging.openaidom.com`
3. Old-domain policy is locked: remove `herobids.com` public-hostname usage completely. No redirect or fallback is required.
4. DNS TTL is already set to `300` seconds.
5. Production freeze is not a gating concern because production has not launched yet.
6. Staging backup has already been taken. There is no production deployment snapshot requirement yet.


## Phase 1: Staging Cutover on `staging.openaidom.com`

This is the current live environment and the first implementation target.

### 1. DNS

1. `staging.openaidom.com` `A` record already points to the current staging server IP.
2. `staging.openaidom.com` `AAAA` record is already created and should remain part of the rollout.
3. Staging TTL is already `300` and should stay low during validation.

### 2. Staging Deploy Config

Update staging config to make `staging.openaidom.com` the only supported staging origin:

1. Set `app_domain = "staging.openaidom.com"` in staging Terraform vars.
2. Update staging Caddy hostnames to `staging.openaidom.com`.
3. Update staging compose/env values:
   - `AUTH_PUBLIC_BASE_URL=https://staging.openaidom.com`
   - `AUTH_FRONTEND_ORIGIN=https://staging.openaidom.com`
   - `VITE_API_ORIGIN=https://staging.openaidom.com`
   - `TELEGRAM_WEBHOOK_URL=https://staging.openaidom.com/telegram/webhook`
4. Remove `staging.herobids.com` host handling from staging configs and docs instead of leaving it as a secondary hostname.

### 3. OAuth Staging Update

Before testing login, ensure the staging domain is the configured OAuth staging origin:

1. Authorized JavaScript origin: `https://staging.openaidom.com`
2. Redirect URI: `https://staging.openaidom.com/auth/google/callback`
3. Remove `staging.herobids.com` staging callback/origin entries once the new staging flow is verified.

### 4. Billing Staging Update

If staging uses real or test billing providers:

1. Add or switch webhook endpoints to `https://staging.openaidom.com/api/billing/webhook` or provider-specific equivalents.
2. Verify checkout returns land back on `https://staging.openaidom.com/billing`.
3. Use test mode only.
4. Remove any staging billing callback or return URLs that still point to `staging.herobids.com`.

### 5. Webhook Staging Update

1. Re-register Telegram webhook to `https://staging.openaidom.com/telegram/webhook`.
2. If any other public webhooks exist, repoint them in staging too.
3. Remove old staging-domain webhook targets after the new endpoint is confirmed healthy.

### 6. Staging Smoke Test

All of these must pass:

1. `GET /health`
2. SPA loads at `https://staging.openaidom.com`
3. Google OAuth login completes end-to-end
4. Email login link redirects to the new staging host
5. Billing checkout success/cancel returns to the new staging host
6. Billing webhooks are accepted and processed
7. Telegram webhook receives and processes a test message

If staging fails on any of these, stop and fix staging before preparing production.

---

## Phase 2: Production Preparation Before First Launch

Do this before the first public production deployment.

### 1. DNS Preparation

Create or verify production DNS records in advance:

1. `openaidom.com` → production server IPv4
2. `www.openaidom.com` → production server IPv4, if used
3. `app.openaidom.com` → production server IPv4, if used
4. `AAAA` records only if production already serves IPv6 correctly

Creating these records early is low risk because there is no production traffic to disrupt.

### 2. Production Config Preparation

Prepare the production config changes in the repo so the first launch is OpenAIdom-native:

1. `app_domain = "openaidom.com"`
2. Production Caddy hostnames changed to `openaidom.com` and chosen aliases
3. `AUTH_PUBLIC_BASE_URL=https://openaidom.com`
4. `AUTH_FRONTEND_ORIGIN=https://openaidom.com`
5. `VITE_API_ORIGIN=https://openaidom.com`
6. `TELEGRAM_WEBHOOK_URL=https://openaidom.com/telegram/webhook`
7. Public-facing email/contact text updated where needed
8. No production config should continue to reference `herobids.com` hostnames.

### 3. OAuth Production Preparation

Before the production launch window:

1. Add `https://openaidom.com` as an authorized origin.
2. Add `https://openaidom.com/auth/google/callback` as an authorized redirect URI.
3. If using `www` or `app`, add only the exact hostnames that will actually be used.
4. Remove `herobids.com` production OAuth entries before launch unless some external dependency still requires them during validation.

### 4. Billing Production Preparation

Prepare the provider dashboards before deploy:

1. Stripe:
   - create or prepare webhook endpoint for `https://openaidom.com/api/billing/webhook/stripe`
   - confirm product/price mapping remains unchanged
2. Creem:
   - create or prepare webhook endpoint for `https://openaidom.com/api/billing/webhook/creem`
   - confirm return flows allow `https://openaidom.com`
3. Confirm customer portal return URL policy allows the new domain.
4. Remove obsolete `herobids.com` webhook targets once the OpenAIdom targets are configured.

### 5. Webhook Production Preparation

1. Prepare Telegram webhook change command or operator runbook.
2. List every public webhook that references `herobids.com` and replace it with the corresponding OpenAIdom target.

---

## Phase 3: First Production Launch on `openaidom.com`

This should happen only after staging is green on `staging.openaidom.com`.

### Ordered Steps

1. Confirm no unrelated deploy is in progress.
2. Confirm low DNS TTLs are active.
3. Verify `openaidom.com`, `www.openaidom.com`, and `app.openaidom.com` resolve to the production server IPs.
4. Snapshot the initial production config values that will be deployed for `.env.prod`, `Caddyfile.prod`, and provider dashboards.
5. Deploy the production config that makes `openaidom.com` canonical.
6. Let Caddy obtain TLS certificates for `openaidom.com` and chosen aliases.
7. Run immediate smoke tests on the new domain.
8. Register Telegram and billing webhooks on the new domain.
9. Verify a real OAuth login from the new domain.
10. Verify a real billing flow from the new domain.
11. Verify `www.openaidom.com` and `app.openaidom.com` behave as intended by the production Caddy routing.
12. Verify `herobids.com` public hostnames are no longer referenced by deploy config, dashboards, or public docs.

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

If any of items 3 through 8 fail, treat the launch as incomplete and either fix immediately or roll back the production launch without reviving the old domain.

---

## Phase 4: Post-Cutover Cleanup

Only do this after staging and production have both been stable on the OpenAIdom hostnames for at least one monitoring window.

1. Remove `herobids.com` from OAuth origins and redirect URIs.
2. Remove old billing webhook endpoints and return URLs.
3. Remove old Telegram webhook references from docs and scripts.
4. Update remaining public/legal/email references from `herobids.com` to `openaidom.com`.
5. Remove any remaining `herobids.com` DNS, Caddy, compose, or operator runbook references that were kept temporarily during implementation.

---

## Rollback Plan

Rollback must be possible without rebuilding infrastructure or reintroducing `herobids.com`.

### Trigger Conditions

Roll back the production launch if any of the following remain broken after a short repair attempt:

1. Google login fails on production
2. Billing checkout cannot complete
3. Billing webhooks are rejected or not delivered
4. Telegram webhook cannot be restored quickly
5. SPA or API is unhealthy on `openaidom.com`

### Rollback Order

1. Revert production env values, Caddy hostnames, and provider settings to the last known-good OpenAIdom launch candidate or disable the incomplete production exposure.
2. Redeploy production.
3. Restore Telegram and billing webhooks to the last known-good OpenAIdom configuration.
4. Re-run smoke tests against `openaidom.com` or, if production is withdrawn, keep validation limited to `staging.openaidom.com` until fixes land.

Because the servers and application stack do not change, rollback should be fast without restoring the retired domain.

---

## Acceptance Criteria

The rollout is complete when:

1. Staging runs successfully on `staging.openaidom.com`.
2. Production runs successfully on `openaidom.com`.
3. OAuth works end-to-end on the new production domain.
4. Billing checkout, customer portal return, and webhook processing work on the new domain.
5. Telegram webhook works on the new domain.
6. Old-domain handling is deliberate and documented as full retirement.
7. Repo docs and deploy defaults no longer point operators at `herobids.com` as the canonical domain.

---

## Recommended Follow-Up

If we later want truly seamless dual-domain support, that should be a separate feature. It would likely require:

1. Multi-origin auth/CORS configuration instead of a single frontend origin.
2. Clear canonical-domain handling in the SPA and API.
3. A deliberate compatibility window where both domains are first-class supported hosts.

That is not necessary for the lowest-risk domain move described here.