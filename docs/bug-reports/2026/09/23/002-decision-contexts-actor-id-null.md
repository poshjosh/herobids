# Bug Report 002 — `decision_contexts.actor_id` written NULL (actor identity dropped)

- **Status:** CLOSED — NOT migration-caused (pre-existing gap; not fixed)
- **Severity:** Low
- **Date:** 2026-09-23
- **Environment:** development; local docker compose cross-stack

## Summary

All 16 rows in traderton `decision_contexts` have `actor_id = NULL`, even though
the sibling `decisions` table carries the correct `actor_id`
(`9da44485-…`). The decision context is the append-only record of *why* a
decision was made; losing actor attribution there breaks actor-scoped joins and
audit queries (`idx_decision_contexts_actor_id` is dead weight).

## Root Cause

The live write path is
`packages/worker/src/agent-trading-actor.ts:3219` → `backtestingRepo.insertDecisionContext({ decisionId, venueAccountId, contextHash, context })`.
It **omits** `actorType` and `actorId`, so the repository's defaults
(`actorType ?? 'system'`, `actorId ?? null`) apply → `actor_type = 'system'`,
`actor_id = NULL`.

## Migration causation assessment — **NOT caused by the migration**

Git-archeology tracing the agent-direct write lineage shows the omission
**pre-dates the herobids→traderton extraction**:

- Pre-migration herobids (`8c199782`, phase-5d) `apps/worker/src/trading-actor.ts`
  `persistDecisionContext` called `insertDecisionContext({ decisionId, tradingInstanceId,
  contextHash, context })` — **no actor fields**.
- The pre-migration engine `decision-intake.ts` in the same commit also **did not**
  pass `actorType`/`actorId` to `persistDecisionContext`.
- `BacktestingRepository.insertDecisionContext` has always defaulted
  `actorType ?? 'system'` / `actorId ?? null` — identical in pre-migration
  herobids and post-extraction traderton (`git show 4494303`).

So the actor identity was already being dropped in herobids before the boundary
existed; traderton inherited the same lossy writer unchanged. The migration did
not introduce or worsen it.

## Outcome

Stopped per instruction ("if not caused by migration — stop"). No fix applied.
This is tracked for a potential future data-fidelity improvement outside the
migration-regression sweep.

## Related

- Pre-migration evidence: `git show 8c199782` (`apps/worker/src/trading-actor.ts`, `packages/engine/src/decision-intake.ts`)
- `traderton/packages/engine/src/decision-intake.ts:161` (now passes actor fields — but the worker adapter still drops them)
- traderton `packages/db/src/schema/decision-contexts.ts` (`actorId text('actor_id')`)