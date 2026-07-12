# Bug Report: Google Login "Nothing Happens" — Caddy `/auth/*` Routing Missing

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-12
- **Summary:** Clicking "Login with Google" on the staging login page does nothing because of two Caddy routing issues: (1) the `handle /auth/*` directive was missing from the deployed Caddyfile, and (2) after adding it, ALL `/auth/*` requests were routed to the API — including `/auth/callback`, which must be served by the web/SPA container so the `AuthCallbackPage` can receive the OAuth exchange code. Without the `/auth/callback` → web exception, the API returns 404 for that path and the login silently fails.
- **Root Cause:**
  1. The `handle /auth/* { reverse_proxy api:3000 }` directive was added to `Caddyfile.staging` in commit `c84853e4` (2026-07-11), but Caddy was never reloaded/restarted after deployment, so the old config (lacking any `/auth/*` route) remained active.
  2. After restarting Caddy, ALL `/auth/*` requests went to the API — but the OAuth callback flow redirects the browser to `/auth/callback?code=xxx`, which needs the SPA to render `AuthCallbackPage`. The API has no handler for `GET /auth/callback`, so it returned 404.
- **Fix:**
  1. **Immediate:** Restart the Caddy container on the staging server so it picks up the updated `Caddyfile.staging`.
  2. **Caddy routing:** Added explicit `handle /auth/callback { reverse_proxy web:80 }` BEFORE `handle /auth/* { reverse_proxy api:3000 }` in both `Caddyfile.staging` and `Caddyfile.prod`. Caddy evaluates `handle` directives in order, so the more specific `/auth/callback` matches first and goes to the SPA, while `/auth/google`, `/auth/google/callback`, `/auth/exchange`, etc. still go to the API.
  3. **Permanent:** Modified `push.sh` to reload Caddy after every deployment so config changes are always picked up.
- **Files Changed:**
  - `Caddyfile.staging` — added `handle /auth/callback { reverse_proxy web:80 }` before `handle /auth/*`
  - `Caddyfile.prod` — same
  - `infra/hetzner/scripts/push.sh` — added `docker compose restart caddy` after `up -d`
- **Tests Added:**
  - `tests/staging-config-validation.test.ts` — 10 new tests in sections 10 (Caddyfile auth routing) and 11 (deploy script restarts Caddy):
    - Both Caddyfiles must contain `handle /auth/* { reverse_proxy api:3000 }`
    - Both Caddyfiles must contain `handle /auth/callback { reverse_proxy web:80 }`
    - `/auth/callback` must appear before `/auth/*` in both Caddyfiles (order matters — Caddy first-match)
    - The `/auth/*` handle must appear before the catch-all `handle` in both Caddyfiles
    - `push.sh` must restart the Caddy service after `docker compose up -d`
    - The Caddy restart command must reference `COMPOSE_FILES` (not hard-coded paths)
- **Verification:**
  - Before fix: `curl -sI https://staging.herobids.com/auth/google` → `content-type: text/html` (SPA)
  - After fix (phase 1): `curl -sI https://staging.herobids.com/auth/google` → `HTTP/2 302` redirect to `accounts.google.com`
  - After fix (phase 2): Full Google OAuth login flow completes — user is redirected through Google, back to `/auth/callback` (served by SPA), code exchanged for JWT, logged in.
