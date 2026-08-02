# Bug Report: Agent Delete 500 — market_assessment_requests FK + Raw SQL Leak

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-08-02
- **Discovered:** Staging — user attempted to delete agent "thyper", received 500 with raw query in response body.
- **Summary:** Deleting an agent that has `market_assessment_requests` rows fails with a FK violation. The raw Postgres error (including the SQL query text) is exposed to the client because neither the route handler nor the Fastify app has error handling.

## Symptoms

`DELETE /agents/:id` (thyper) → 500 with raw query exposed:
```
update or delete on table "agents" violates foreign key constraint 
"market_assessment_requests_agent_id_agents_id_fk" on table "market_assessment_requests"
```
The error includes the full SQL query and parameter values.

## Root Cause

Two compounding issues:

1. **Uncleared FK:** `market_assessment_requests.agent_id` references `agents.id` with no `ON DELETE` clause (defaults to `NO ACTION`). The DELETE route never cleans up `market_assessment_requests` before the final `DELETE FROM agents`.

2. **No error sanitization:** The DELETE route has no `try-catch`. There is no `setErrorHandler` registered on the Fastify instance. Fastify's default error serialization dumps the raw `Error.message` — including PostgreSQL query text and parameter values — directly into the 500 response body.

This is the 5th iteration of the same FK-constraint whack-a-mole pattern (see prior reports: 2026-06-06, 2026-06-15, 2026-06-15, 2026-07-07).

## Fix

**Two-layer fix:**

**Layer 1 — Defense-in-depth (prevents ALL future query leaks):**
Added a `setErrorHandler` in `apps/api/src/index.ts` that:
- Catches all unhandled route errors
- Strips internal details (SQL, stack traces) from client responses
- Returns a generic `{ error: "internal_error", correlationId }` 500
- Logs the full error with correlation ID server-side

**Layer 2 — Fix the FK gap:**
Added `market_assessment_requests` cleanup to the DELETE route before the final `DELETE FROM agents`. The route now deletes `market_assessment_requests` rows for the agent before deleting the agent itself, resolving the FK violation.

## Files Changed

- `apps/api/src/error-handler.ts` — Extracted reusable `registerGlobalErrorHandler()` (sanitises all thrown errors, only passes through validation errors and already-sent replies)
- `apps/api/src/index.ts` — Imports and calls `registerGlobalErrorHandler(app)` instead of inline handler
- `apps/api/src/routes/agents.ts` — Added `marketAssessmentRequests` import and cleanup step 7.5 in the DELETE route
- `apps/api/src/error-handler.test.ts` — 10 tests covering validation passthrough, reply.sent passthrough, thrown error sanitisation (FK violations, Drizzle queries, stack traces, 4xx statusCode leaks), unique correlation IDs, and edge cases
- `apps/api/src/routes/agents.test.ts` — Consolidated deletion-order test verifies `marketAssessmentRequests` before `agents` and `agents` as last delete
- `docs/bug-reports/2026/08/02/002-agent-delete-market-assessment-requests-fk-500.md` — This report

## Verification

1. Agent with `market_assessment_requests` rows can now be deleted without FK error. ✅
2. Unhandled errors from any route no longer expose raw SQL or stack traces to the client:
   - Fastify validation errors pass through safely with `validation_error`.
   - Fastify-generated 4xx (malformed JSON, etc.) preserve their status code but return sanitised `client_error` body with correlationId.
   - App-thrown 4xx preserve their status code but return sanitised `client_error` body.
   - All 5xx/unhandled errors return sanitised `internal_error` with correlationId.
3. `pnpm lint` passes.
4. Tests added:
   - `apps/api/src/routes/agents.test.ts` — Consolidated deletion-order test verifies `marketAssessmentRequests` before `agents` and `agents` as last delete.
   - `apps/api/src/error-handler.test.ts` — 11 tests covering validation passthrough, reply.sent passthrough, thrown error sanitisation (FK violations, Drizzle queries, stack traces, 4xx status preservation with sanitised body), real Fastify-generated 4xx (malformed JSON), unique correlation IDs, and edge cases.
