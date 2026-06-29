# Bug Report: Agent Evaluation — Deduplication, Retry, and Secret Detection Gaps

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-29
- **Summary:** Three high-severity gaps in the Level 1 agent evaluation implementation: (1) scope-aware dedupe was app-level only with no DB constraint, (2) BullMQ retry was configured but never actually worked, (3) evidence was redacted before the security analyzer ran, making secret detection impossible.

## Root Cause

1. **Dedupe gap:** `createRun()` used a transaction-level re-check but no DB-level constraint. Two concurrent transactions could both observe no active run for the same scope and both insert, creating duplicate active runs. The plan explicitly called for a DB-level exclusion/partial unique constraint.

2. **Retry gap:** The API enqueued jobs with `attempts: maxAttempts`, but the repository always created runs with `attempt: 1`, `markRunning()` required `status = 'queued'`, and `runEvaluation()` called `markFailed()` on error which set status to `'failed'` permanently. On BullMQ retry, `markRunning()` found status `'failed'` (not `'queued'`), returned false, and the job handler skipped the run.

3. **Secret detection gap:** `assembleEvidence()` applied `redactJson()` to all evidence before writing it to the artifact store. The security analyzer then read these already-redacted artifacts. A real secret (e.g. `sk-proj-...`) was replaced with `[REDACTED]` before the analyzer ever saw it.

## Fix

1. **Migration 0025**: Added a partial unique index `uq_agent_evaluations_active_scope` on `(agent_id, scope_key) WHERE status IN ('queued', 'running')` to enforce scope dedupe at the DB level.

2. **Retry fix**: Added `markRetrying()` repository method that resets status to `'queued'`, clears `startedAt`, and increments `attempt`. Updated `runEvaluation()` to accept `attemptNumber` and `maxAttempts`, and on error: calls `markRetrying()` when retries remain, `markFailed()` only on the final attempt. Updated `markFailed()` to only transition from `'running'` (not overwrite timed_out). Updated `evaluation-runtime.ts` to pass `attemptNumber`/`maxAttempts` from the BullMQ job.

3. **Pipeline reorder**: Removed redaction from `assembleEvidence()` — evidence is now written raw. The security analyzer runs first, reading raw artifacts. After all analysis is complete, a new Step 3 in `runEvaluation()` redacts the evidence artifacts in-place, then the report is rendered. This ensures secrets are both detected AND not exposed to users.

Additionally: core evidence collection (fills, journal, sessions, positions) now throws on failure instead of silently recording a manifest error. The `RunEvaluationContext` now includes `attemptNumber`, `maxAttempts`, and an optional `redis` field for future snapshot wiring.

## Files Changed

- `packages/db/drizzle/0025_mute_princess_powerful.sql` — partial unique index
- `packages/db/drizzle/meta/_journal.json` — migration entry
- `packages/db/src/schema/agent-evaluations.ts` — updated dedupe comment
- `packages/db/src/agent-evaluation-repository.ts` — added `markRetrying()`, guarded `markFailed()`, guarded `markRunning()`
- `packages/db/src/index.ts` — export `markRetrying`
- `apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts` — removed redaction, core evidence throws on failure
- `apps/worker/src/agent-evaluation/run-evaluation.ts` — reordered pipeline, added retry logic, added post-analysis redaction, threaded redis/attempt fields
- `apps/worker/src/agent-evaluation/evaluation-runtime.ts` — passes `attemptNumber`/`maxAttempts` from BullMQ job
- `apps/worker/src/agent-evaluation/redaction.test.ts` — new (7 tests)
- `apps/worker/src/agent-evaluation/analyzers/security.test.ts` — new (10 tests)
- `apps/worker/src/agent-evaluation/analyzers/core.test.ts` — new (10 tests)
- `apps/worker/src/agent-evaluation/analyzers/trading.test.ts` — new (15 tests)

## Remaining Known Gaps (MEDIUM)

These were identified in the review but are not fixed in this batch:

1. `costs.json` is still a placeholder — agent-level billing data collection not yet wired.
2. Redis snapshot is threaded through the context but no actual Redis client is connected at the worker level.
3. No `container-logs.ts` collector exists under the worker evaluation tree.
4. API route tests (`apps/api/src/routes/agent-evaluations.test.ts`) not yet written.
5. `runEvaluation` orchestrator integration test not yet written.

## Verification

- `pnpm lint` — passes
- `packages/db/src/agent-evidence-loaders.test.ts` — 10 existing tests pass
- `packages/db/src/agent-evaluation-storage-fs.test.ts` — 10 existing tests pass
- `apps/worker/src/agent-evaluation/redaction.test.ts` — 7 new tests pass
- `apps/worker/src/agent-evaluation/analyzers/security.test.ts` — 10 new tests pass
- `apps/worker/src/agent-evaluation/analyzers/core.test.ts` — 10 new tests pass
- `apps/worker/src/agent-evaluation/analyzers/trading.test.ts` — 15 new tests pass
