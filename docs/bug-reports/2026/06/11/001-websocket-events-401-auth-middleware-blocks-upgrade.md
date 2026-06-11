- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-11
- **Summary:** `GET /events` WebSocket upgrade requests were rejected with HTTP 401 by the global auth middleware, making real-time UI updates completely non-functional.

## Root Cause

The global `authPlugin` `onRequest` hook checks for an `Authorization: Bearer <token>` header on every request not in the `isPublicRoute` whitelist. The `/events` endpoint uses WebSocket and validates auth via a `?token=<jwt>` query parameter because browsers cannot send custom headers on WebSocket upgrade requests. Since `/events` was not whitelisted, the auth hook intercepted and rejected all upgrade requests before they reached the WebSocket handler.

During the 2026-06-11 evaluation session, **69 consecutive 401 responses** were logged, meaning the UI had no live event feed for the entire observation window.

## Fix

Added `/events` to `isPublicRoute` in `apps/api/src/plugins/auth.ts`. The WebSocket handler in `apps/api/src/routes/events.ts` already performs its own JWT validation via `?token=` — the middleware exemption does not bypass security.

## Files Changed

- `apps/api/src/plugins/auth.ts`

## Verification

`pnpm lint` passes. The `/events` path is now skipped by the middleware and reaches the WebSocket handler, which validates `?token=` independently.
