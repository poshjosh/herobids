- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-13
- **Summary:** `list_positions` tool returned empty for agents that traded directly (without bots), even when positions existed in the DB with `actorType='agent'`.

## Root Cause

`BotRepository.getOpenPositionsByCreator` only queried positions where `actorType='bot'`, by looking up bot IDs owned by the creator and filtering with `inArray(positions.actorId, botIds)`. When an agent submits a decision via agent-native resolution (`AgentIntakeResolver`), the resulting position is persisted with `actorType='agent'`, `actorId=<agentId>`. These positions were invisible to the `list_positions` tool, causing the agent's scout to believe no positions were open, even when the agent had active trades.

Observed in production: agents `534e9792` and `228d8bd0` both submitted `go_long` decisions (SOL and BTC) on their first tick. The positions were created under `actorType='agent'`. On subsequent ticks, `list_positions` returned empty, and the scout's hold rationale stated "no open positions" — a contradiction with the agent's own Redis memory which showed open trades.

## Fix

**File:** `packages/db/src/repositories.ts` — `BotRepository.getOpenPositionsByCreator`

Extended the query to include a second condition when `creatorType === 'agent'` and no `botId` filter is applied:

```
WHERE
  (actorType = 'bot' AND actorId IN (<botIds>) AND closedAt IS NULL)
  OR
  (actorType = 'agent' AND actorId = <agentId> AND closedAt IS NULL)
```

When no bots exist (`botIds` is empty), the bot arm is omitted and only the agent-direct condition is used. When a `botId` filter is present (scoping the query to a specific bot), agent-direct positions are excluded (bot-scoped query).

## Files Changed

- `packages/db/src/repositories.ts`

## Verification

Lint passes (`pnpm lint`). Unit tests pass (23/23).
