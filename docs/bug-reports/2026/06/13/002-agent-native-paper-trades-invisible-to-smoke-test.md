# 002 — agent-native paper trades invisible to smoke test

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-13
- **Summary:** The trade smoke test timed out even after a direct paper trade succeeded because the harness and API visibility endpoints were still centered on bot-owned records. The test also relied on creating a momentum bot, which was an unreliable path for a deterministic smoke check and exposed Hyperliquid ticker rate limits in paper mode.

## Root Cause

Two issues overlapped:

1. The smoke test goal asked the agent to create a bot and wait for a strategy-driven trade. That is not the most direct or reliable validation path because agents can trade directly via `submit_decision`, and bot-driven paper trading on Hyperliquid hit ticker rate limits in clean runs.
2. After switching to the direct decision path, the trade still appeared to fail because the API surfaces used by the harness only queried bot-owned records:
   - `GET /agents/:id/decisions` returned decisions from bots created by the agent, but not decisions submitted directly by the agent.
   - `GET /agents/:agentId/capabilities/trading/state` aggregated only bot positions.
  - Related trading activity, outcome, and position routes had the same bot-only assumption.

The direct trade was present in the database, but the harness could not see it and timed out.

## Fix

- Updated `scripts/ts/agent-trade-test.ts` to validate trading through the canonical direct `submit_decision` path instead of creating a momentum bot.
- Updated agent trading API routes to include both actor ownership models:
  - direct agent records where `actorType = 'agent'` and `actorId = agentId`
  - bot records owned by the agent where `actorType = 'bot'` and `actorId IN agentBotIds`
- Extended route tests to cover agent-native decision and position visibility.

## Files Changed

- `scripts/ts/agent-trade-test.ts`
- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/capabilities/trading.ts`
- `apps/api/src/routes/agents.test.ts`
- `apps/api/src/routes/capabilities/trading.test.ts`

## Verification

- `pnpm vitest run apps/api/src/routes/agents.test.ts apps/api/src/routes/capabilities/trading.test.ts`
- `TIMEOUT_MS=600000 scripts/shell/tests/agent-trade-test.sh`

Final clean-stack smoke test result:

```text
✓ Decision recorded — id=0d6bfbb5-380a-4ca5-9726-7e41dd325856
✓ Open position confirmed — count=1 totalPnl=0.000000
PASS — agent submitted a trade within the timeout window.
```