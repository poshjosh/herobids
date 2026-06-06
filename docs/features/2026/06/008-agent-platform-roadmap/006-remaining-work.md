# Remaining Work

**Created:** 2026-06-05 (catch-up audit)
**Last verified:** 2026-06-06 (session — R1.1 item 1 done; R2.2 closed won't-fix; R3.2 done; CX.1 done)
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

This document tracks everything that is not yet `done` across all phases. Each item is scoped to the exact file(s) that need to change and describes precisely what needs to happen. Items are ordered by dependency — work items that unblock others come first.

---

## Phase 1 Remaining

### R1.1 — Rename `tradingInstanceId` field to `botId`

**Blocked by:** nothing

The deprecated type aliases (`TradingInstanceConfigSchema`, `TradingInstanceConfig`) have been removed from `packages/domain/src/config/schema.ts` and `packages/domain/src/config/index.ts`. All importers now use `BotConfigSchema` / `BotConfig`.

**Still remaining:** the field name `tradingInstanceId` (not the type) must be renamed to `botId` across the codebase. Wider than originally noted — it is used in engine internals as well as domain interfaces.

**Files:**
- `packages/domain/src/models/decision.ts` line 16 — rename field `tradingInstanceId` → `botId`
- `packages/domain/src/agent-protocol.ts` line 23 — rename field `tradingInstanceId` → `botId`
- `packages/engine/src/planner.ts` lines 15, 215 — rename field + usages
- `packages/engine/src/journal.ts` — rename parameter `tradingInstanceId` → `botId` in all event builder functions (8 functions)
- `packages/engine/src/paper-executor.test.ts` line 21, 153, 159 — update test fixtures
- Any other callers in `packages/engine/`, `apps/worker/` — update to `botId`

**Commit:** `feat(phase-1): rename tradingInstanceId field to botId across domain and engine`

---

## Phase 2 Remaining

### R2.2 — SandboxEnforcer on code_execute path — **WON'T FIX**

**Decision:** Closed. `CapabilityPolicyEngine.checkAccess()`, `recordStart()`, and `recordEnd()` already enforce rate limiting, concurrency, and output byte tracking on the `code_execute` path. Per-execution stdout is bounded by `MAX_OUTPUT` derived from the capability grant's `maxResponseBytes`. Session-level download budget enforcement would require hooking the network layer inside the sandbox subprocess — out of scope for the in-process `SandboxEnforcer`. `SandboxEnforcer` correctly handles session wall-clock limits at the session level; per-execution enforcement belongs to `CapabilityPolicyEngine`, which already applies it. No further work needed.

---

## Phase 3 Remaining

### R3.2 — Add running bot statuses to agent prompt context — **DONE**

Implemented: the broker populates `managedBots` (id, status, strategyPreset, symbol) in every `CONTEXT_SNAPSHOT` it sends to the agent. `agent.ts` receives it and stores it in `sessionMetrics.managedBots`. `buildProgressContext()` includes the bot list in the prompt when non-empty. Tests in `agent-broker.test.ts` and `agent-protocol.test.ts` cover the payload shape.

---

## Cross-Cutting

### CX.1 — Stale capability cache in agent-message-broker — **DONE**

Implemented: `processInbound` now computes `policySig = JSON.stringify(agent.toolPolicy)` on every call (using a freshly fetched agent record) and passes it to `getCapabilityEngine`. The cache entry is rebuilt whenever `policySig` differs from what was cached. Permission changes take effect on the next inbound message without requiring a worker restart.

---

## Priority Order

```
R1.1 (rename tradingInstanceId field → botId)  — no deps, clean up before next feature work
```

R2.2, R3.2, CX.1 are resolved (see above).

---

## Definition of Done for This Document

This document is complete (and can be archived) when every item above is removed, replaced by a `done` entry in the corresponding plan's Progress table.
