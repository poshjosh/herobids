# E2E Playwright Tests Consistently Time Out

**Date**: 2026-06-27
**Severity**: MEDIUM
**Status**: Open

## Summary

All 19 Playwright E2E tests in `tests/e2e/journeys/` fail with ~1-minute timeouts per test. This affects the full `run-all-tests.sh --e2e` validation workflow.

## Reproduction

```bash
scripts/shell/tests/run-all-tests.sh --e2e
# Or directly:
cd tests/e2e && BASE_URL=http://localhost:5173 pnpm test
```

## Observed Behavior

All tests time out after ~60 seconds. The first test (`01-signup-create-agent.spec.ts`) fails with a timeout during the registration flow. The stack (api, worker, web) starts correctly and the web UI is accessible at `http://localhost:5173`.

## Expected Behavior

E2E tests should pass, verifying key user journeys through the web UI.

## Investigation Notes

- The web UI is accessible (curl returns HTML)
- The API is healthy (smoke tests pass)
- Registration via the actual browser (manual UAT) works correctly
- Unit, integration, functional, and API smoke tests all pass (29/29)
- The failures are consistent across multiple runs
- WebSocket `/api/events` endpoint returns 404 through the Docker nginx proxy (nginx doesn't proxy WebSocket connections to the API)

## Possible Root Causes

1. Playwright browser environment issues in Docker
2. Network/proxy configuration between Playwright and the web container
3. Timing/synchronization issues in the test helpers
4. Nginx proxy doesn't forward WebSocket connections needed by the web UI

## Impact

Blocks the `--e2e` flag of `run-all-tests.sh`. Does not affect unit, integration, functional, or API smoke tests.
