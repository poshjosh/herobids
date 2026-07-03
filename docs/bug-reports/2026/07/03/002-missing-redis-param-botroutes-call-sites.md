# 002-missing-redis-param-botroutes-call-sites.md

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-03
- **Summary:** Commit `cc25925` added a `redis: Redis` parameter to `botRoutes()` function signature but missed updating 6 call sites across tests, causing 4 unit test failures and 1 functional test failure.
- **Root Cause:** The `botRoutes` function signature changed from `(app, queue, db, plansConfig?)` to `(app, queue, db, redis, plansConfig?)`. The `redis` parameter was inserted at position 4, shifting `plansConfig` to position 5. Call sites that still passed `plansConfig` as the 4th argument ended up with `redis = plansConfig` and `plansConfig = undefined`, causing the plan-gated transaction code path to be skipped. The `else` branch (no-plans-config) then failed because the DB mock was set up for the transaction path.
- **Fix:** Added `mockRedis` (for unit tests) and `redisClient` (for functional test helper) as the 4th argument to all `botRoutes()` call sites.
- **Files Changed:**
  - `apps/api/src/routes/blueprints.test.ts` — 5 call sites + added `mockRedis` definition
  - `apps/api/src/__tests__/functional/helpers.ts` — 1 call site
  - `apps/api/src/routes/bots.test.ts` — already fixed in commit `cc25925`
- **Verification:** `pnpm test` passes with 0 failures; `scripts/shell/tests/run-all-tests.sh --e2e` shows Unit tests PASS, Integration tests PASS, Functional tests PASS.
