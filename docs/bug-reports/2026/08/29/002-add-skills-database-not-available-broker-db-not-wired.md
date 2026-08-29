# Bug Report: add_skills always fails with "Database not available"

- **Status:** FIX APPLIED (pending rebuild/redeploy)
- **Severity:** High
- **Date:** 2026-08-29
- **Environment:** local development (docker compose)
- **Agent:** 3cf5d6b5-4234-4de3-99ab-18577a6be8a9

## Summary

The `add_skills` and `remove_skills` tools always fail with `"Database not available"` (error code `db_unavailable`). This is not a transient connectivity issue — the `AgentMessageBroker` was never given a database reference. Skill mutations are permanently broken for all agents.

## Observed Behavior

1. Agent searches for skill `llmquant-crypto` via `search_skills` — succeeds.
2. Agent calls `add_skills` with the skill ID — fails with `"Database not available"`.
3. Agent retries twice more — same failure each time.
4. After 3 consecutive failures, the `ToolCircuitBreaker` opens the circuit for `add_skills`, blocking further attempts for 5 ticks.
5. Agent incorrectly tells the user this is a "transient platform issue" and suggests waiting for the circuit breaker to reset.

## Root Cause

In `apps/worker/src/index.ts` (line ~1488), the `AgentMessageBroker` constructor receives `undefined` for its `db` parameter, with an explicit comment acknowledging the gap:

```typescript
const agentBroker = new AgentMessageBroker(
  redisClient,
  agentRepo,
  // ... other params ...
  undefined, // db — not wired yet    <── THE BUG
  appConfig.agentRuntime.llm.modelDefaults,
  appConfig.plans,
);
```

The `db` variable is available in scope at this call site — it was simply never passed through.

The failure chain:

1. `add_skills` tool (`tools/skills.ts`) publishes a `MANAGE_AGENT_SKILLS` message to the inbound Redis stream via `ctx.publishToInbound`.
2. `AgentMessageBroker.handleManageAgentSkills()` (`agents/agent-message-broker.ts`, line ~1300) checks `if (!this.db)` and returns `{ error: 'Database not available', errorCode: 'db_unavailable' }`.
3. The tool receives this error via `redis.blpop` on the reply key and returns `{ success: false }`.
4. `toolResultIndicatesFailure()` classifies it as a fault (default `fault: true`), feeding the `ToolCircuitBreaker`.
5. After `failureThreshold: 3` failures (config default), the circuit opens for `reopenAfterTicks: 5`.
6. When the circuit closes, the agent retries and fails identically — an infinite fail/block cycle.

### Why other tools are unaffected

The agent process (`agent.ts`) has a direct DB connection and wires `db` into the `ToolContext`. Tools that use `ctx.db` or `ctx.skillOps` (backed by direct DB) work fine. Only tools that publish to the inbound stream and rely on the broker's DB-dependent handlers are broken.

| Tool | Affected? | Reason |
|------|-----------|--------|
| `add_skills` | Yes | Broker-mediated, needs `this.db` |
| `remove_skills` | Yes | Same broker path |
| `list_skills` | No | Uses `ctx.skillOps` (direct DB in agent.ts) |
| `search_skills` | No | Uses `ctx.skillOps` + `npx skills find` |
| `change_strategy_preset` | No | Broker-mediated path falls through to `ctx.db` which IS wired |
| All other tools | No | Broker handlers don't need `this.db` |

## Fix

Wire the existing `db` instance into the `AgentMessageBroker` constructor in `apps/worker/src/index.ts`:

```diff
- undefined, // db — not wired yet
+ db,
```

## Files Changed

- `apps/worker/src/index.ts` — pass `db` instead of `undefined` to `AgentMessageBroker` constructor

## Verification

- `pnpm lint` passes
- Rebuild and redeploy worker container
- Agent can successfully call `add_skills` and `remove_skills`
