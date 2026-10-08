# Bug Report: actor-event-relay integration test fails when a stale lease key survives a prior interrupted run

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-10-08
- **Summary:** `actor-event-relay.integration.test.ts` asserted `expected +0 to be 1` on
  `redis.xrange(streamKey, '-', '+')` because `ActorEventRelay.tick()` silently no-ops when
  the global `lease:actor-event-relay` Redis key is already held by another worker ID —
  which happens if a previous run of this test suite was interrupted (CI kill, crash, timeout)
  before its `afterAll` cleanup ran, since the lease has a 30s TTL and is not namespaced per
  test run.

## Root Cause

`ActorEventRelay.holdLease()` (`apps/worker/src/agents/actor-event-relay.ts`) uses a single
global Redis key, `lease:actor-event-relay`, to coordinate a singleton relay across workers
(`SET ... NX`). This is correct production behaviour — it's intentionally designed to make a
second worker's `tick()` a no-op while another worker holds the lease, so the outbox is never
double-processed.

The integration test (`apps/worker/src/__tests__/integration/actor-event-relay.integration.test.ts`)
only cleared this key (and the paired `actor-event-relay:cursor` key) in `afterAll`. If an
earlier run of the suite was interrupted before reaching `afterAll` (CI timeout/kill, a crash in
an earlier test in the same `--pool=forks --poolOptions.forks.singleFork` process), the lease
key is left behind under a different `workerId` and survives for up to its 30s TTL. Any run of
this test that starts within that window acquires the lease test instance normally fails:
`holdLease()` returns `false` on the very first call, `tick()` returns before scanning the feed,
and the stream never receives the republished row — producing exactly the observed
`entries.length` of `0` instead of `1`.

This was reproduced deterministically: manually setting `lease:actor-event-relay` to a
different worker ID before running the test reproduces the exact failure (`expected +0 to be 1`
at the same assertion). Clearing it beforehand makes the test pass reliably. The relay's
production logic itself is correct; the test's own cleanup ordering is the defect.

## Fix

Added a `beforeAll` in the test file that deletes `lease:actor-event-relay` and
`actor-event-relay:cursor` before the test runs, in addition to the existing `afterAll`
cleanup. This makes the test resilient to any stale state left behind by a prior interrupted
run, rather than only cleaning up after a successful run.

## Files Changed

- `apps/worker/src/__tests__/integration/actor-event-relay.integration.test.ts`

## Verification

- Reproduced the failure by manually setting `lease:actor-event-relay` to a foreign worker ID
  against a throwaway Redis container, then running the test — it failed with the exact
  reported assertion error.
- Applied the fix, re-ran the same reproduction (lease pre-set to a foreign worker ID before
  the test starts) — test passed.
- `pnpm lint` passes (`tsc --noEmit`, exit 0).
- Ran the full `apps/worker/src/__tests__/integration` suite with
  `--fileParallelism=false --pool=forks --poolOptions.forks.singleFork` (the same flags
  `pnpm test:functional` uses) against a throwaway Redis — all non-DB-skipped tests pass
  (4 files passed, 1 skipped for missing `DATABASE_URL` which is expected in this
  Redis-only run).
