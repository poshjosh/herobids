# 002 — reset.sh builds stale image (no git pull before docker compose up)

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-21
- **Summary:** After running `infra/hetzner/scripts/reset-and-run.sh`, the admin dashboard showed the previous day's API version (`0.0.1-2026.06.20-a`) instead of the current one (`0.0.1-2026.06.21-c`).

## Root Cause

`reset.sh` runs `docker compose up -d --build` on the server without first pulling the latest code from git. The server's `/opt/herobids` directory retained the previous commit, so Docker rebuilt images from stale source and the old `package.json` version was baked in.

By contrast, `push.sh` correctly does `git fetch --all && git reset --hard origin/main` before rebuilding.

`parseAppVersion()` in `apps/api/src/routes/admin.ts` reads the version at startup from the `package.json` that is baked into the Docker image (`/app/apps/api/package.json`), so building from stale code produces a permanently stale version string until the image is rebuilt from the correct code.

## Fix

Added a `git fetch --all && git reset --hard origin/main` step immediately before `docker compose up -d --build` in the `RESET` heredoc inside `reset.sh`, mirroring the behaviour already present in `push.sh`.

## Files Changed

- `infra/hetzner/scripts/reset.sh`

## Verification

Run `infra/hetzner/scripts/reset-and-run.sh` after bumping `package.json` version; the admin dashboard `/api/admin/system` response should return the version from the latest commit on `origin/main`.
