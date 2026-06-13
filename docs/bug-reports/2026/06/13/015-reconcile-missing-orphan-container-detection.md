- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-13
- **Summary:** The Docker agent reconcile loop did not detect containers running with no active `agents` DB row (orphan containers). This allowed orphan containers to continue operating silently, submitting decisions that were always rejected (bug #014).

## Root Cause

`DockerAgentManager.reconcile()` checked one direction only:

- `agents` table has `status='active'` but no container → mark crashed ✅

It did not check the reverse:

- Container running but no active `agents` row → ❌ (not handled)

This gap materialises when:
1. The `agents` table is truncated or re-seeded while agent containers keep running (observed on 2026-06-13: postgres/redis/api/worker restarted, but standalone agent containers survived)
2. A container is launched directly via `docker run` without going through `POST /api/agents`

Observed in production: at ~19:40 CEST, all service containers (postgres, redis, api, worker) went offline while agent containers `534e9792`, `d1b34149`, `228d8bd0` continued running. After a restart, the `agents` table was empty. The reconcile loop would not have detected these orphans.

## Fix

**File:** `apps/worker/src/agents/docker-agent-manager.ts` — `reconcile()`

After the existing `activeAgents` loop, added an inverse check: any container in `runningAgentIds` whose `agentId` does not appear in `activeAgentIds` is logged as an orphan and stopped via `this.stop(agentId)`. `stop()` is safe for orphans: `agentRepo.updateAgent` is a no-op when no row exists, and Docker 404 is treated as success.

## Files Changed

- `apps/worker/src/agents/docker-agent-manager.ts`
- `apps/worker/src/agents/docker-agent-manager.test.ts` (4 new test cases)

## Verification

Lint passes. All 4 new orphan reconcile tests pass:
- stops a container with no active agent row
- does not stop a container with a matching active row
- stops only the orphan when mixed (some known, some orphan)
- continues reconciliation when Docker stop fails (error is caught and logged)
