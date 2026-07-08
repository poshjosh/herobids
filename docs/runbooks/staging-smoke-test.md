# Staging Smoke-Test Checklist

Run this checklist after every staging deploy to verify the environment is healthy.

**Prerequisites:** You have the staging server IP and the staging domain (`staging.herobids.com`). Get the IP via:
```bash
cd infra/hetzner
terraform workspace select staging
terraform output -raw server_ipv4
```

## 1. API Health Endpoint

```bash
# From your local machine (goes through Caddy + TLS):
curl -sf https://staging.herobids.com/health

# Or via SSH if TLS is not yet provisioned:
ssh root@<STAGING_IP> 'curl -sf http://localhost:3000/health'
```

**Expected:** HTTP 200 with a JSON body containing `status: "ok"` (or equivalent healthy response).

**If it fails:** Check `./scripts/logs.sh --env staging -- api migrate`. Ensure `.env.staging` is uploaded. See the troubleshooting table in `infra/hetzner/README.md`.

---

## 2. Web App Loads

Open `https://staging.herobids.com` in a browser.

**Expected:**
- The page loads without certificate errors (Caddy issued a valid Let's Encrypt cert).
- The login/sign-up UI renders.
- No CORS or mixed-content errors in the browser console.
- The web app can reach the staging API (check the Network tab for successful `/health` or `/api/` calls).

**If it fails:**
- Certificate error → DNS A record missing or pointing to wrong IP. Verify `dig staging.herobids.com`.
- Blank page / JS errors → Check `./scripts/logs.sh --env staging -- web`.
- API unreachable from browser → Verify `VITE_API_ORIGIN` in `docker-compose.staging.yaml` matches `https://staging.herobids.com`.

---

## 3. OAuth Redirect Flow (if OAuth is configured)

1. Navigate to `https://staging.herobids.com`.
2. Click the OAuth login button (Google, etc.).
3. Verify the redirect URL in the browser address bar starts with the correct OAuth provider domain and contains a `redirect_uri` parameter pointing to `https://staging.herobids.com`.
4. Complete the OAuth flow and confirm you are redirected back to the staging web app.

**Expected:** The full OAuth round-trip succeeds. The `redirect_uri` uses `staging.herobids.com`, NOT `herobids.com`.

**If it fails:**
- Wrong redirect URI → The OAuth provider (Google Cloud Console, etc.) must have `https://staging.herobids.com/api/auth/callback/google` (or equivalent) registered as an authorized redirect URI.
- `AUTH_PUBLIC_BASE_URL` mismatch → Verify `docker-compose.staging.yaml` sets `AUTH_PUBLIC_BASE_URL=https://staging.herobids.com`.

---

## 4. Billing Page

1. Log into the staging web app.
2. Navigate to the billing/subscription page.

**Expected:**
- The page renders without errors.
- Behavior matches the configured staging billing mode:
  - **Mock mode (default):** The page should show mock/test billing UI. No real charges are possible.
  - **Provider test mode:** If staging uses Stripe/Creem test mode, the checkout flow should work end-to-end without real charges.

**If it fails:**
- Page crash → Check `./scripts/logs.sh --env staging -- api` for billing-related errors.
- Wrong provider → Verify `BILLING_PRIMARY_PROVIDER` in `.env.staging`.

---

## 5. Worker Boot

```bash
./scripts/logs.sh --env staging -- worker | head -50
```

**Expected:**
- Worker logs show `NODE_ENV=staging` or environment selection confirming staging.
- No startup guard failures (no `strategy.fatal`, `strategy.config_invalid`, or billing guard rejection).
- Worker connects to the staging database and Redis.
- Streaming/polling loops start without errors.

**If it fails:**
- Startup guard rejection → Check that `.env.staging` satisfies all staging guard requirements. Staging does NOT enforce the production billing guard, so `BILLING_PRIMARY_PROVIDER=mock` is valid.
- DB connection error → Verify the staging server has its own Postgres volume (not connecting to production DB). Check `./scripts/logs.sh --env staging -- postgres`.

---

## 6. Telegram Webhook (if configured)

Only applicable if staging has a Telegram bot token and webhook secret configured in `.env.staging`.

1. Verify the webhook registration log on worker boot:
   ```bash
   ./scripts/logs.sh --env staging -- worker | grep -i telegram
   ```
2. Send a test message to the staging Telegram bot.
3. Confirm the worker receives and processes it.

**Expected:** Webhook URL points to `https://staging.herobids.com/api/telegram/webhook` (or equivalent). The staging bot responds to commands.

**If it fails:**
- Wrong webhook URL → Check that `TELEGRAM_WEBHOOK_BASE_URL` (or equivalent env var) is set to `https://staging.herobids.com` in `.env.staging`.
- No response → Check worker logs for Telegram-related errors.

---

## 7. Database Migrations

```bash
ssh root@<STAGING_IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml run --rm migrate'
```

**Expected:** Migrations complete without errors. If already up to date, the output says "No migrations to run" (or equivalent).

**If it fails:** Check `./scripts/logs.sh --env staging -- migrate` for error details. Common causes: missing `.env` on server, DB not ready yet.

---

## Quick Summary

| # | Check | Command / Action | Expected |
|---|-------|-----------------|----------|
| 1 | API health | `curl -sf https://staging.herobids.com/health` | HTTP 200 |
| 2 | Web app | Open `https://staging.herobids.com` in browser | Page loads, no cert errors |
| 3 | OAuth | Log in via OAuth provider | Redirects to staging domain |
| 4 | Billing | Navigate to billing page | Renders without errors |
| 5 | Worker | `./scripts/logs.sh --env staging -- worker \| head -50` | No guard failures, loops start |
| 6 | Telegram | Send message to staging bot (if configured) | Bot responds |
| 7 | Migrations | `ssh root@<IP> '... docker compose ... run --rm migrate'` | No errors |

---

## After All Checks Pass

- Staging is healthy and ready for pre-production validation.
- Proceed with any planned smoke tests, deploy rehearsals, or config validation.
- If you discovered issues, fix them before touching production.

## Related Docs

- [Hetzner Deployment README](../../infra/hetzner/README.md) — provisioning, deploy workflow, troubleshooting
- [Staging Environment Setup Plan](../../features/2026/07/08/003-staging-environment-setup/001-plan.md) — full feature plan
- [Configuration Guide](../../best-practices/configuration.md) — operator vs instance config
