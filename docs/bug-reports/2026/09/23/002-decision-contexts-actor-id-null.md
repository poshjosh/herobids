# Bug Report 002 — `decision_contexts.actor_id` written NULL (actor identity dropped)

- **Status:** OPEN
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

The engine already passes the correct values up the stack:
`decision-intake.ts` calls `persistDecisionContext({ actorType: deps.actorType, actorId: deps.actorId, … })`,
and `deps.actorType`/`deps.actorId` are populated for agent-direct decisions
(the same values that correctly land in `decisions`). The actor identity is
simply not forwarded in the worker's `persistDecisionContext` adapter, nor
declared on the `InsertDecisionContext`/`PersistDecisionContextParams` type used
there. (The bot path at `trading-actor.ts:2283` has the same omission.)

## Fix (proposed)

Forward `actorType`/`actorId` through
`persistDecisionContext` → `backtestingRepo.insertDecisionContext(...)` in
`packages/worker/src/agent-trading-actor.ts` (and the bot actor
`trading-actor.ts`), declaring the fields on `InsertDecisionContext` so the
repository writes them instead of defaulting.

## Files Changed

- `traderton/packages/worker/src/agent-trading-actor.ts` — pass `actorType`/`actorId`
- `traderton/packages/worker/src/trading-actor.ts` — same (bot path)
- `traderton/packages/db/src/backtesting-repository.ts` — accept + write `actorType`/`actorId`

## Verification

- Insert a decision context for an agent-direct decision; `actor_id` = agent id, `actor_type = 'agent'`.
- `pnpm lint` / actor tests green.

## Related

- `traderton/packages/engine/src/decision-intake.ts:161` (correct values already computed)
- traderton `packages/db/src/schema/decision-contexts.ts` (`actorId text('actor_id')`)