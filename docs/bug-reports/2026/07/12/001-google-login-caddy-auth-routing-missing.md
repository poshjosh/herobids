# Bug Report: Google Login "Nothing Happens" — Caddy `/auth/*` Routing Missing

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-07-12
- **Summary:** Clicking "Login with Google" on the staging login page does nothing because Caddy routes `/auth/*` requests to the web/SPA container instead of the API. The user sees the SPA index.html instead of being redirected to Google OAuth.
- **Root Cause:** The `handle /auth/* { reverse_proxy api:3000 }` directive was added to `Caddyfile.staging` in commit `c84853e4` (2026-07-11), but Caddy was never reloaded/restarted after deployment. The Caddy container is still running with the old config that lacked the `/auth/*` route, so all `/auth/*` requests fall through to the `handle { reverse_proxy web:80 }` catch-all. The SPA serves `index.html` for any unknown route, so the browser renders the login page again — appearing as "nothing happened."
- **Fix:**
  1. **Immediate:** Restart the Caddy container on the staging server so it picks up the updated `Caddyfile.staging`.
  2. **Permanent:** Modified `push.sh` to reload Caddy after every deployment so config changes are always picked up.
- **Files Changed:**
  - `infra/hetzner/scripts/push.sh` — added `docker compose restart caddy` after `up -d`
- **Tests Added:**
  - `tests/staging-config-validation.test.ts` — 6 new tests in sections 10 (Caddyfile auth routing) and 11 (deploy script restarts Caddy):
    - Both Caddyfiles must contain `handle /auth/* { reverse_proxy api:3000 }`
    - The `/auth/*` handle must appear before the catch-all `handle` in both Caddyfiles
    - `push.sh` must restart the Caddy service after `docker compose up -d`
    - The Caddy restart command must reference `COMPOSE_FILES` (not hard-coded paths)
- **Verification:**
  - Before fix: `curl -sI https://staging.herobids.com/auth/google` → `content-type: text/html` (SPA)
  - After fix: `curl -sI https://staging.herobids.com/auth/google` → `HTTP/2 302` redirect to `accounts.google.com`
