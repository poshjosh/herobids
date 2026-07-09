- **Status:** OPEN
- **Severity:** Medium
- **Date:** 2026-07-09
- **Summary:** The `preserves a new wake enqueued while a flush is in flight` test in `wake-scheduler.test.ts` fails because the Redis mock is missing `sismember` (and `smembers`), which were added to `monitor.ts` to gate watch evaluation on `agent:sessions:active` membership.
- **Root Cause:** `evaluateWatches()` in `monitor.ts` calls `redis.sismember('agent:sessions:active', agentId)` to skip watch evaluation for agents without an active session. The `makeRedisMock()` factory in `wake-scheduler.test.ts` never had this method, so `evaluate()` throws `TypeError: redis.sismember is not a function`, the evaluation cycle fails silently, no new wake is enqueued, and the post-flush assertion `expect(pendingWakeRaw).toBeTruthy()` fails.
- **Reproduction:** `pnpm test -- --run apps/worker/src/market-intelligence/wake-scheduler.test.ts`
- **Fix Required:**
  1. Add a backing `sset: Map<string, Set<string>>` to `makeRedisMock()`.
  2. Expose `sadd` and `sismember` (and optionally `smembers` to match `monitor.test.ts`) on the mock.
  3. In the failing test, register the agent in `agent:sessions:active` via `redis._sset.set('agent:sessions:active', new Set([agentId]))` so that `evaluateWatches()` proceeds past the active-session guard and enqueues a new wake while the first flush is in flight.
  4. Confirm `evaluate()` resolves before `deferred.resolve()` so the generation CAS fires correctly.
- **Files to Change:**
  - `apps/worker/src/market-intelligence/wake-scheduler.test.ts` — `makeRedisMock()` + the failing test setup
- **Related:** `apps/worker/src/market-intelligence/monitor.ts:207` (`sismember` call), `monitor.test.ts:95` (correct mock with `sismember`)
