# 019 — Agent trade test: FATAL "API not reachable" because Docker stack was not running

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-13
- **Summary:** `scripts/shell/tests/agent-trade-test.sh` exited immediately with a FATAL error because the Docker stack was not running and `DOCKER_COMPOSE_UP` was not set to `1`.

## Root Cause

Operational: the Docker stack (postgres, redis, api, worker) had not been started before invoking the trade test. The script correctly detects the unreachable API and emits:

```
✗ FATAL: API at http://localhost:3000 is not reachable.
  Start the stack manually, or re-run with DOCKER_COMPOSE_UP=1 to auto-start it.
```

This is expected behaviour — there is no code defect. The previous `DOCKER_COMPOSE_UP=1` attempts visible in the terminal history likely failed due to either:
- A fresh image build that was interrupted or exceeded the shell timeout.
- The stale-image issue documented in [018](./018-api-container-stale-image-skill-seeding-crash.md) (the API container was running an unfixed image).

Both root causes from bug 018 have since been resolved.

## Fix

Started the Docker stack manually:

```bash
docker compose up -d
```

All services came up healthy (postgres, redis, migrate completed successfully, api healthy, worker and web started).

## Verification

After `docker compose up -d`:

```
curl -sf http://localhost:3000/health
{"status":"ok","timestamp":"2026-06-13T20:37:39.025Z"}
```

Full trade test run:

```
scripts/shell/tests/agent-trade-test.sh

Phase 1: Stack health    ✓ API is reachable at http://localhost:3000
Phase 2: Setup           ✓ Registered and logged in
                         ✓ Provider link created
                         ✓ Agent created and verified
                         ✓ Trading capability bound
                         ✓ Agent start requested
Phase 3: Watching agent  Agent status=active, decision submitted (go_long BTC 0.01)
                         ✓ Decision recorded
                         ✓ Open position confirmed
Phase 3.5: Assertions    ✓ All decisions non-rejected
                         ✓ Journal has 5 events
                         ✓ Position visibility consistent
Phase 4: Teardown        ✓ Agent stopped and deleted

PASS — agent submitted a trade and execution was confirmed.
```

## Files Changed

None — operational fix only.

## Related

- [017-agent-trade-test-sh-cli-env-overridden-by-env-file.md](./017-agent-trade-test-sh-cli-env-overridden-by-env-file.md)
- [018-api-container-stale-image-skill-seeding-crash.md](./018-api-container-stale-image-skill-seeding-crash.md)

## Prevention

Before running the trade test, either:
1. Ensure the stack is running: `docker compose up -d`
2. Or pass the auto-start flag: `DOCKER_COMPOSE_UP=1 scripts/shell/tests/agent-trade-test.sh`
