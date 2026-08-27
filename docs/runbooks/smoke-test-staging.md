# Staging Smoke-Test Checklist

Run this checklist after every staging deploy to verify the environment is healthy.

## Automated Smoke Test

The automated script covers SSH connectivity, container health, API health, worker logs, and DB migrations:

```bash
cd infra/hetzner
./scripts/smoke-test.sh --env staging
```

Expected: 13 passed, 0 failed, 3 skipped. Exit code 0.

If any check fails, the script prints the specific failure and the command to diagnose it (typically `./scripts/logs.sh --env staging -- <service>`).

## Manual Checks

These require a browser or interactive access — run them after the automated test passes.

### Web App

Open `https://staging.openaidom.com` in a browser.

**Expected:** Page loads without certificate errors, login UI renders, no CORS errors.

**If it fails:** Check DNS (`dig staging.openaidom.com`), Caddy logs (`./scripts/logs.sh --env staging -- caddy`), or verify `VITE_API_ORIGIN` in `docker-compose.staging.yaml`.

### OAuth Redirect Flow (if OAuth is configured)

1. Navigate to `https://staging.openaidom.com` and log in via OAuth.
2. Verify the `redirect_uri` points to `staging.openaidom.com`, NOT `openaidom.com`.

**Expected:** Full OAuth round-trip succeeds.

**If it fails:** Verify the OAuth provider has `https://staging.openaidom.com/api/auth/callback/...` registered as an authorized redirect URI, and `AUTH_PUBLIC_BASE_URL` matches.

### Billing Page

Log in and navigate to the billing page.

**Expected:** Page renders. Mock mode shows test UI (no real charges). Test mode should complete checkout without real charges.

### Telegram Webhook (if configured)

Send a test message to the staging bot and confirm the worker responds.

**Expected:** Bot responds. Webhook URL uses `staging.openaidom.com`.

### Telegram Webhook (if configured)

Send a test message to the staging bot and confirm the worker responds.

**Expected:** Bot responds. Webhook URL uses `staging.openaidom.com`.

---

## Quick Reference

| Check | Automated? | Command |
|---|---|---|
| SSH, containers, API, worker, DB | ✅ | `./scripts/smoke-test.sh --env staging` |
| Web app, OAuth, billing, Telegram | ❌ | Browser / manual interaction |

---

## After All Checks Pass

- Staging is healthy and ready for pre-production validation.
- Proceed with any planned smoke tests, deploy rehearsals, or config validation.
- If you discovered issues, fix them before touching production.

## Related Docs

- [Hetzner Deployment README](../../infra/hetzner/README.md) — provisioning, deploy workflow, troubleshooting
- [Staging Environment Setup Plan](../../features/2026/07/08/003-staging-environment-setup/001-plan.md) — full feature plan
- [Configuration Guide](../../best-practices/configuration.md) — operator vs instance config
