## Current State

**Last updated:** 2026-06-06

The codebase is substantially ahead of the plan documentation. A catch-up audit on 2026-06-05 and follow-up sessions have resolved the majority of the original backlog. The actual open work is now very small.

---

### What has been completed (since the original 2026-06-05 assessment)

**Phase 1**
- ~~R1.1~~ — Deprecated type aliases (`TradingInstanceConfigSchema`, `TradingInstanceConfig`) removed from `packages/domain/src/config/schema.ts` and `packages/domain/src/config/index.ts`. All importers updated to `BotConfigSchema` / `BotConfig`. *(Field rename still pending — see below.)*
- ~~R1.2~~ — API route is `bots.ts` (`/bots`); web client uses `/bots` endpoint; `/instances` redirects to `/bots`.
- ~~R1.3~~ — `/bots` web page exists (`BotsPage`), wired into the router.
- ~~R1.4~~ — `paused_by_guardrail` and `critical_execution_failure` alerts are fired in `agent-session-manager.ts` via `PlatformAlertService`. `AgentDetailPage` renders platform messages as 🔔 Safety Alert.
- ~~R1.5~~ — Delete control in `AgentDetailPage` is implemented (confirm dialog → `DELETE /agents/:id`). API route exists in `agents.ts`.

**Phase 2**
- ~~R2.1~~ — `docker-compose.yaml` sets `AGENT_RUNTIME_MODE: docker` and `AGENT_IMAGE: herobids-agent:latest`.
- ~~R2.2~~ — Closed as won't-fix. `code_execute` in `agent.ts` already uses `CapabilityPolicyEngine.checkAccess()`, `recordStart()`, and `recordEnd()` for rate limiting, concurrency, and output byte tracking. `SandboxEnforcer` handles session wall-clock limits at the session level; no additional wrapping is needed.

**Phase 3**
- ~~R3.2~~ — `managedBots` is populated in every `CONTEXT_SNAPSHOT` sent by the broker. `agent.ts` stores it in `sessionMetrics` and `buildProgressContext()` includes bot statuses in the LLM tick.

**Cross-cutting**
- ~~Stale capability cache~~ — Fixed. `getCapabilityEngine()` in `agent-message-broker.ts` computes `policySig = JSON.stringify(agent.toolPolicy)` on every call; the cache entry is rebuilt automatically when the policy changes.

---

### Open work

**R1.1 (partial) — Rename `tradingInstanceId` field → `botId`**

The field name `tradingInstanceId` (not the type) remains in domain interfaces and engine internals. Full list:

| File | What |
|---|---|
| `packages/domain/src/models/decision.ts` line 16 | Rename field |
| `packages/domain/src/agent-protocol.ts` line 23 | Rename field |
| `packages/engine/src/planner.ts` lines 15, 215 | Rename field + usages |
| `packages/engine/src/journal.ts` | Rename parameter in 8 event-builder functions |
| `packages/engine/src/paper-executor.test.ts` lines 21, 153, 159 | Update test fixtures |
| Callers in `packages/engine/`, `apps/worker/` | Update to `botId` |

**Plan quota TOCTOU**

`checkBotLimit` → insert in `POST /bots` is non-atomic. Under concurrent requests a user could exceed their plan's `maxTradingInstances`. Known race condition; fix requires a database-level advisory lock or `INSERT … SELECT … WHERE count < limit` in a single statement.
