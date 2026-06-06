# Remaining Work

**Created:** 2026-06-05 (catch-up audit)
**Last verified:** 2026-06-06 (code audit — most items from 2026-06-05 version were already done)
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

This document tracks everything that is not yet `done` across all phases. Each item is scoped to the exact file(s) that need to change and describes precisely what needs to happen. Items are ordered by dependency — work items that unblock others come first.

---

## Phase 1 Remaining

### R1.1 — Remove deprecated type aliases and rename remaining field names

**Blocked by:** nothing

The bulk of R1.1 is done: `BotId`, `BotConfig`, `BotConfigSchema` all exist. However:

1. **Deprecated aliases still exported and actively imported.** `schema.ts` exports `TradingInstanceConfigSchema` and `TradingInstanceConfig` as `@deprecated` aliases, and `packages/domain/src/config/index.ts` re-exports both. One active importer remains: `apps/worker/src/index.ts` imports `TradingInstanceConfigSchema`.

2. **`tradingInstanceId` field names not renamed.** The field `tradingInstanceId` (not the type) still appears in:
   - `packages/domain/src/models/decision.ts` line 16
   - `packages/domain/src/agent-protocol.ts` line 23

**Files:**
- `packages/domain/src/config/schema.ts` — remove the two `@deprecated` alias exports
- `packages/domain/src/config/index.ts` — remove `TradingInstanceConfigSchema` and `TradingInstanceConfig` from re-exports
- `apps/worker/src/index.ts` — update import from `TradingInstanceConfigSchema` → `BotConfigSchema`
- `packages/domain/src/models/decision.ts` — rename field `tradingInstanceId` → `botId`
- `packages/domain/src/agent-protocol.ts` — rename field `tradingInstanceId` → `botId`
- Any callers of those fields in `packages/engine/`, `apps/worker/` — update to `botId`

**Commit:** `feat(phase-1): remove deprecated TradingInstance* aliases; rename tradingInstanceId field to botId`

---

## Phase 2 Remaining

### R2.2 — Use SandboxEnforcer class on code_execute path (re-scoped)

**Blocked by:** nothing

**Context correction from original description:** The broker does not and should not have a `code_execute` handler — code execution runs in-container inside `agent.ts`, which is correct per ADR 003. The original R2.2 described the wrong file.

The actual gap: `agent.ts` calls `execFileAsync` directly on the `sandbox-exec.sh`/node path, bypassing the `SandboxEnforcer` class (`apps/worker/src/agents/sandbox-enforcer.ts`). The class encapsulates rate limiting, concurrency limiting, and output byte tracking on top of the subprocess execution. Currently those limits are enforced via the `CapabilityPolicyEngine` checks before the call, but `SandboxEnforcer`'s per-execution enforcement is not applied.

**Decision needed before implementing:** Is wrapping `execFileAsync` in `SandboxEnforcer` worth the change, or is `CapabilityPolicyEngine.checkAccess()` + `capabilityEngine.getGrant()` (already in `agent.ts`) sufficient? If `SandboxEnforcer` adds meaningful runtime enforcement beyond what's already there, wire it. If it's redundant, close this item as `won't fix` and document why.

**Files (if implementing):**
- `apps/worker/src/agent.ts` — `case 'code_execute':` block
- `apps/worker/src/agents/sandbox-enforcer.ts` — read API first

**Commit (if implementing):** `feat(phase-2): wrap code_execute subprocess call with SandboxEnforcer`

---

## Phase 3 Remaining

### R3.2 — Add running bot statuses to agent prompt context

**Blocked by:** nothing

**Context:** P&L, elapsed time, and performance score are all injected by `buildProgressContext()` in `agent.ts`. The one missing field from the plan spec is **current bot statuses** (which of the agent's bots are running, stopped, or crashed).

**Files:**
- `apps/worker/src/agent.ts` — `buildProgressContext()` function (around line 542)

**What to do:**
The agent runtime currently has no direct DB access for bot state. The platform injects context via `CONTEXT_SNAPSHOT` messages on the Redis stream. Two options:

1. **Worker injects bot statuses into CONTEXT_SNAPSHOT** — when the worker sends a `CONTEXT_SNAPSHOT` to the agent, include `managedBots: [{ id, status, strategyPreset }]`. The agent stores it like `lastPnlSummary` and includes it in `buildProgressContext()`.
2. **Agent queries via a brokered tool** — add a `list_bots` brokered tool the agent can call when it needs to check its bot states.

Option 1 is simpler and consistent with how P&L is already injected. Option 2 gives the agent on-demand control. For MVP, Option 1 is recommended.

**Commit:** `feat(phase-3): inject managed bot statuses into agent prompt context via CONTEXT_SNAPSHOT`

---

## Cross-Cutting

### CX.1 — Stale capability cache in agent-message-broker

**Blocked by:** nothing  
**Severity:** correctness bug — permission changes are silently ignored in running sessions

**Files:**
- `apps/worker/src/agents/agent-message-broker.ts`

**What to do:**
The broker caches a `CapabilityPolicyEngine` instance per `agentId` and never invalidates it. When the API updates `skillIds` or `toolPolicy` on an agent (via `PATCH`), the change is persisted to DB but the broker continues using the cached (stale) engine until the worker restarts.

Fix: invalidate the cached engine for an agent when the worker receives a notification that the agent's config changed. The simplest approach is a Redis pub/sub channel (`agent:config:updated`) that the API publishes to on every `PATCH`, and the broker subscribes to and clears the relevant cache entry.

Alternatively, give the cache a short TTL (e.g. 60s) so stale grants expire automatically without needing a pub/sub channel.

**Commit:** `fix: invalidate capability engine cache on agent config update`

---

## Priority Order

```
R1.1 (remove deprecated aliases + field rename)  — no deps, clean up before next feature work
R3.2 (bot statuses in prompt)                     — no deps, experience quality
CX.1 (stale capability cache)                     — correctness bug, fix before live usage
R2.2 (SandboxEnforcer decision)                   — needs a decision first, then implement or close
```

---

## Definition of Done for This Document

This document is complete (and can be archived) when every item above is removed, replaced by a `done` entry in the corresponding plan's Progress table.
