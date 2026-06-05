# Bug Report: API Client Conditional Content-Type Review

- **Status:** CLOSED
- **Severity:** Low
- **Date:** 2026-06-04
- **Summary:** Reviewed the only remaining unstaged change in `apps/web/src/lib/api-client.ts`, which narrows the default `Content-Type: application/json` header to requests that actually include a request body. No actionable regression was confirmed from the current caller set.

## Root Cause

- The unstaged diff changes the shared web API client so `Content-Type: application/json` is only sent when `init.body !== undefined`.
- A caller scan across the web app shows two stable groups:
  - requests with JSON bodies already use `JSON.stringify(...)` and still receive the JSON content type
  - bodyless requests are simple GET/DELETE/POST calls that do not send JSON payloads and do not currently depend on a body parser contract
- No callers currently send `FormData`, `Blob`, `URLSearchParams`, or other non-JSON body types through this helper.

## Fix

- No code change recommended from this review.
- Treat the change as a cleanup that avoids attaching a JSON content type to bodyless requests.

## Files Changed

- None.

## Verification

- Reviewed the exact unstaged diff in `apps/web/src/lib/api-client.ts`.
- Scanned all current web API client call sites and confirmed that requests with bodies still use `JSON.stringify(...)`.
- Confirmed there are no current `FormData`, `Blob`, `URLSearchParams`, or other non-JSON body call sites using the helper.