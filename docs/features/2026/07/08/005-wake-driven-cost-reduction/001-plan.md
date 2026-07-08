# 020 — Wake-Driven Cost Reduction Plan

**Status:** Draft  
**Created:** 2026-07-08  
**Source inputs:**
- `docs/features/pending/020-wake-driven-cost-reduction/000-analysis.md`
- Production data from 8 agents on 2026-07-08
- Code trace of `apps/worker/src/market-intelligence/monitor.ts`, `apps/worker/src/agent-wake-scheduler.ts`, `apps/worker/src/agent.ts`
- Runtime/orchestration constraints from `docs/features/2026/07/08/004-orchestration/002-implementation-plan.md`

## Problem

After deploying 010-llm-cost-reduction (tick gate fingerprint expansion), LLM costs did not decrease. Investigation revealed the tick gate is working correctly — **54% skip rate on scheduled ticks** — but scheduled ticks account for only 29% of all ticks. The other 71% are wake-triggered and always fire the LLM.

The primary wake source is the market monitor's **discovery delta** system (`apps/worker/src/market-intelligence/monitor.ts`). Every 15 seconds it evaluates the top set of tokens from Redis, finds newly-entered tokens, and publishes a wake signal broadly enough that the tick gate rarely gets a chance to suppress cost.

### Evidence (2026-07-08 production)

| | Count | % of total ticks |
|---|---|---|
| Wake-triggered ticks (always → LLM) | 716 | 71% |
| Scheduled ticks skipped by gate | 160 | 16% |
| Scheduled ticks that ran LLM | 137 | 13% |
| **Total** | 1,013 | 100% |

Discovery delta events: ~69/hour. Delivered broadly enough that several agents are effectively wake-driven most of the time.

### Current pipeline

```
Every 15s: evaluateDiscoveryDeltas()
  → Reads "top set" from market-intel:discovery:latest
  → Finds newly-entered tokens (not in previous snapshot)
  → For each new token (per-symbol dedupe: 10 min):
      → For each target agent:
          → emit market.discovery.detected
          → enqueueWake() → per-agent bucket (coalescing: 3s)

Every 3s: flushPendingWakes()
  → For each pending bucket:
      → Check single per-agent cooldown
      → Publish agent.wake to Redis stream

Agent runtime:
  → Reads outbound stream messages
  → agent.wake sets wakePending=true and schedules an earlier tick
  → Wake-driven tick bypasses context-hash suppression and runs the LLM
```

## Design

### Design Constraints

1. The plan must remain **scheduler-agnostic**. It cannot depend on local Docker behavior and must work the same for Docker, Nomad, and future runtime backends.
2. Shared wake/context delivery must keep using the **existing outbound Redis stream**. Do not add a separate side-channel key for context-only market events.
3. Per-agent wake preferences are **control-plane state**, not runtime env. Updating them must **not** require restarting or rescheduling the agent runtime.
4. Operator-wide wake policy belongs under **`marketIntelligence`**, because the worker-owned market monitor consumes that config directly.
5. Per-agent wake preferences belong on **`agents`**, not on bots and not in legacy trading-instance config.

### Architecture: Layered Wake Policy

Three layers, each operating at a different point in the pipeline:

```
┌────────────────────────────────────────────────────────────┐
│  Layer 3: Agent subscription filter                        │
│  "Should this agent receive this monitor-owned source?"   │
│  If no → do not emit event or wake for that source         │
├────────────────────────────────────────────────────────────┤
│  Layer 2: Source-scoped throttle and coalescing            │
│  "How often can this source wake this agent?"             │
│  Separate bucket + cooldown per (agentId, source)          │
├────────────────────────────────────────────────────────────┤
│  Layer 1: Delivery mode                                    │
│  "Wake now, wake later, or context only?"                 │
│  Uses the existing outbound Redis stream in all cases      │
└────────────────────────────────────────────────────────────┘
```

### Config Model

**Operator config** (`config/default.yaml`) — platform-wide wake policy for the market monitor:

```yaml
marketIntelligence:
  wakeCoalescingWindowMs: 3000
  wakeCooldownMs: 30000        # fallback for unknown sources only
  wakePolicy:
    watch_threshold:
      mode: wake
      cooldownMs: 15000
    discovery_delta:
      mode: batched
      cooldownMs: 300000
    regime_change:
      mode: batched
      cooldownMs: 120000
```

Notes:
- `wakeCoalescingWindowMs` stays operator-owned and global.
- `wakeCooldownMs` remains as the fallback for unknown sources and backward compatibility.
- Phase 1 can ship with `discovery_delta: batched`; Phase 2 adds the option to move discovery to `mode: context` without changing the transport.

**Per-agent preferences** (`agents.wake_preferences` JSONB, exposed via API/UI as `wakePreferences`) — control-plane state:

```json
{
  "subscribedSources": ["watch_threshold", "regime_change"]
}
```

Notes:
- If `subscribedSources` is absent, the agent receives all monitor-owned sources.
- Phase 3 stores this on `agents`, not `bots`.
- The worker mirrors active preferences into a Redis projection that the market monitor can read without querying Postgres on every evaluation cycle.
- Updating `wakePreferences` must take effect without restarting the runtime.

### Recipient Resolution

Do not use one generic `getActiveAgentIds()` path for every source.

1. `watch_threshold`
   - Evaluate from the watch key owner as today.
   - Before emitting the event or wake, consult the Redis preference projection to confirm the owner still subscribes to `watch_threshold`.

2. `discovery_delta` and `regime_change`
   - Resolve recipients from a Redis projection of active agents plus their subscribed monitor-owned sources.
   - Do not infer discovery/regime recipients from watch keys.

3. Other wake producers
   - This plan only changes **market-monitor-owned** sources.
   - Other producers may opt into the same projection later, but that is not required for this feature.

### Wake Delivery Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| `wake` | Emit the underlying market event and enqueue a normal wake bucket for that source. | Stop-loss, take-profit, urgent actionable signals |
| `batched` | Emit the underlying market event immediately, but keep the source bucket scheduled so the wake only emits when that source becomes eligible. No dependency on the agent's local tick timer. | Discovery deltas and regime changes when we still want bounded wake-ups |
| `context` | Emit the underlying market event to the outbound stream, but do **not** emit `agent.wake`. The runtime records it as pending market context, includes it in the prompt on the next tick, and includes a digest of the pending events in the tick-gate fingerprint so the next scheduled tick is not skipped as unchanged context. | Informational market deltas that do not justify immediate LLM work |

## Part A — Source-Scoped Cooldowns and Coalescing (Phase 1)

### Why

The current monitor uses a single per-agent cooldown and a single per-agent pending wake bucket. That is the wrong unit for a source-aware policy:

- a low-urgency discovery event can throttle a watch-threshold wake
- a watch-threshold wake can cause discovery events to inherit urgent semantics
- mixed-source coalescing forces `primarySource` first-wins behavior that prevents correct per-source throttling

### Approach

Replace the single per-agent wake bucket with **one bucket per `(agentId, source)`** and one last-wake timestamp per `(agentId, source)`.

This keeps coalescing and cooldown logic source-local and makes source-specific policy correct.

### Changes

**`apps/worker/src/market-intelligence/monitor.ts`**
- Replace the current `market-monitor:wake:${agentId}` bucket with a source-scoped key such as `market-monitor:wake:${agentId}:${source}`
- Replace the single last-wake key with `market-monitor:wake:last:${agentId}:${source}`
- Preserve coalescing within the same source bucket
- Use `marketIntelligence.wakePolicy.<source>.cooldownMs` for known sources
- Fall back to `marketIntelligence.wakeCooldownMs` for unknown sources

**`config/default.yaml`**
- Add `marketIntelligence.wakePolicy`
- Keep existing `wakeCoalescingWindowMs` and `wakeCooldownMs` as the shared defaults/fallbacks

**`packages/domain/src/config/schema.ts`**
- Extend `MarketIntelligenceConfigSchema`, not `AgentRuntimeConfigSchema`
- Add a schema for `wakePolicy` keyed by known monitor-owned sources

### Acceptance criteria

- Discovery delta wakes respect a 5-minute cooldown per agent **for `discovery_delta` only**
- Watch threshold wakes still respect a 15-second cooldown per agent **for `watch_threshold` only**
- Interleaved `watch_threshold` and `discovery_delta` events no longer throttle each other
- Unknown wake sources still fall back to the existing default cooldown behavior
- Existing tests pass, and new tests cover source-scoped cooldown behavior

## Part B — Batched and Context Delivery Modes (Phase 2)

### Why

Source-scoped cooldowns are the quick win, but they do not change the more important fact: discovery deltas are often informational and do not always justify an immediate LLM invocation.

We need a delivery policy that can:

1. keep urgent sources wakeable
2. delay moderate-urgency sources without relying on agent-local timer knowledge
3. deliver informational sources as prompt context only, without introducing a second transport

### Approach

**Transport rule:** the underlying market event always continues to use the existing outbound Redis stream.

Then delivery mode decides only whether and how `agent.wake` is emitted.

**Market monitor side**
- `mode: wake`
  - emit the market event
  - enqueue a source-scoped wake bucket with the normal coalescing window
- `mode: batched`
  - emit the market event
  - enqueue a source-scoped wake bucket that remains scheduled until the source is eligible to wake that agent
- `mode: context`
  - emit the market event
  - do not enqueue `agent.wake`

**Agent runtime side**
- extend `applyRuntimeMessage()` so monitor-owned market events can be stored as structured pending market context rather than falling through as generic platform messages
- compute a stable digest of pending context-only market events before the tick-gate decision
- include that digest in the context-hash fingerprint so a new context-only event can force the next scheduled tick to run even when price/position state is unchanged
- render pending market context events in the prompt
- clear the pending market context after the tick completes

### Changes

**`apps/worker/src/market-intelligence/monitor.ts`**
- In `evaluateDiscoveryDeltas()` and `evaluateRegimeChanges()`, always emit the underlying market event
- Choose `wake` / `batched` / `context` from `marketIntelligence.wakePolicy.<source>.mode`
- For `context`, skip `enqueueWake()` entirely
- For `batched`, keep the source bucket scheduled until the source is eligible to emit a wake

**`apps/worker/src/runtime-composition.ts`**
- Add structured runtime storage for pending market-monitor context events
- Teach `applyRuntimeMessage()` to parse and record `market.discovery.detected` and `market.regime.changed` as structured context
- Add a prompt block that renders pending market context events in a compact, actionable form

**`apps/worker/src/tick-gates.ts` and `apps/worker/src/tick-gate-state.ts`**
- Add a stable digest for pending market context events
- Include that digest in the decision-context hash

**`apps/worker/src/agent.ts`**
- Compute the pending market-event digest before the skip decision
- Include pending market context in the prompt on the next tick
- Clear that pending context after the tick, similar to current single-tick wake context cleanup

**`config/default.yaml` and `packages/domain/src/config/schema.ts`**
- Add `mode` to each known wake-policy source

### Acceptance criteria

- `mode: context` sources never emit `agent.wake`
- Context-only market events appear in the next tick prompt
- A new context-only market event prevents the next scheduled tick from being skipped as `context_unchanged`
- `mode: batched` emits wakes from the source-scoped bucket without requiring the market monitor to know the agent's local next-tick timer
- `mode: wake` preserves current wake semantics for urgent sources

## Part C — Per-Agent Wake Subscriptions (Phase 3)

### Why

Not every agent wants every market-monitor source. Discovery and regime changes are cross-agent fan-out sources, so a subscription filter is a direct cost lever.

This filter must live in control-plane state and must not require runtime restart, especially now that runtimes can be scheduled remotely.

### Approach

Add a dedicated `wake_preferences` JSONB field on `agents`, expose it via API/UI as `wakePreferences`, and mirror effective preferences for active agents into Redis for the market monitor.

This phase filters **monitor-owned** sources only.

### Changes

**Database / API**
- Add `wake_preferences` JSONB to `agents`
- Add `wakePreferences` to agent create/update/read payloads

**Worker / Redis projection**
- Add a worker-owned projection of active agent wake preferences in Redis
- Update that projection when:
  - an agent session starts
  - an agent session stops
  - an agent's `wakePreferences` change
- Apply updates without restarting the runtime

**`apps/worker/src/market-intelligence/monitor.ts`**
- Replace the generic discovery/regime recipient path with a Redis-backed lookup of active agent subscriptions
- For watch-threshold events, consult the same projection before emitting the event or wake

**`apps/web/src/` (agent form)**
- Add agent-level wake source checkboxes for the monitor-owned sources

### Acceptance criteria

- Agent without `wakePreferences.subscribedSources` receives all monitor-owned sources
- Agent with `subscribedSources: ["watch_threshold"]` receives watch-threshold events only and does not receive discovery/regime events
- Changing `wakePreferences` via API updates effective routing without restarting or rescheduling the agent runtime
- UI exposes the agent-level subscription controls for the monitor-owned sources

## Non-Goals

- Do not change the market monitor evaluation interval in this feature
- Do not change the discovery delta snapshot format or top-set selection logic
- Do not change the agent-side `wake.minIntervalMs`; wake scheduling inside the runtime remains separate
- Do not redesign non-monitor wake producers in this feature
- Do not add scheduler-specific wake logic; the design must remain backend-agnostic

## Test Plan

### Part A
- Per-source cooldown lookup returns the correct value for each known source
- Unknown source falls back to the default cooldown
- Cooldown is respected independently per `(agentId, source)`
- Interleaved source traffic does not cross-throttle other source buckets

### Part B
- `mode: context` emits the underlying market event but never emits `agent.wake`
- `mode: batched` keeps the wake in the source bucket until the source becomes eligible
- The runtime records context-only market events as structured pending context
- The market-event digest changes when new context-only events arrive
- The next scheduled tick does not skip as `context_unchanged` when that digest changes
- `mode: wake` remains unchanged for urgent sources

### Part C
- Agent without `wakePreferences` receives all monitor-owned sources
- Agent with a restricted `subscribedSources` list receives only those sources
- Discovery/regime recipient resolution comes from the Redis projection, not watch-key scanning
- Updating `wakePreferences` via API changes effective routing without a runtime restart

## Rollout Notes

- **Phase 1** is the quickest cost win and can ship independently
- **Phase 2** builds on Phase 1's config model and transport, without introducing a second delivery channel
- **Phase 3** adds the user-facing control layer and a Redis projection for active preferences
- All phases remain compatible with Docker and Nomad runtime backends because they use worker-owned control-plane state plus the existing outbound Redis stream
- The final rollout should preserve current behavior by default: known sources start with explicit configured modes/cooldowns, and agents without `wakePreferences` continue receiving all monitor-owned sources

## Implementation Task List

### Part A — Source-Scoped Cooldowns and Coalescing

| # | Task | Status |
|---|------|--------|
| A1 | Replace single per-agent wake bucket with source-scoped `(agentId, source)` bucket in `monitor.ts` | DONE |
| A2 | Add `marketIntelligence.wakePolicy` to `config/default.yaml` | DONE |
| A3 | Extend `MarketIntelligenceConfigSchema` in `packages/domain/src/config/schema.ts` | DONE |
| A4 | Write tests for source-scoped cooldown behavior | DONE |

### Part B — Batched and Context Delivery Modes

| # | Task | Status |
|---|------|--------|
| B1 | Add mode-based delivery (wake/batched/context) in `monitor.ts` | DONE |
| B2 | Add structured runtime storage for pending market-monitor context events in `runtime-composition.ts` | DONE |
| B3 | Add stable digest for pending market context events in `tick-gates.ts` | DONE |
| B4 | Compute pending market-event digest before skip decision and render context in prompt in `agent.ts` | DONE |
| B5 | Add `mode` to each known wake-policy source in config and schema | DONE |

### Part C — Per-Agent Wake Subscriptions

| # | Task | Status |
|---|------|--------|
| C1 | Add `wake_preferences` JSONB to `agents` table (DB schema + migration) | PENDING |
| C2 | Add `wakePreferences` to agent create/update/read API payloads | PENDING |
| C3 | Add worker-owned Redis projection of active agent wake preferences | PENDING |
| C4 | Replace generic discovery/regime recipient path with Redis-backed lookup in `monitor.ts` | PENDING |
| C5 | Add agent-level wake source checkboxes in web UI agent form | PENDING |

## Outstanding Issues

### [A1] Source-Scoped Wake Buckets

| # | Severity | Issue |
|---|----------|-------|
| 1 | CRITICAL | `wakePolicy` not passed to `createMarketMonitor()` in `index.ts` — feature dead at runtime. Fix in A2/A3. |
| 2 | HIGH | Config schema (`MarketIntelligenceConfigSchema`) not extended with `wakePolicy` — deferred to A3. |
| 3 | HIGH | `config/default.yaml` not updated with `wakePolicy` section — deferred to A2. |
| 4 | MEDIUM | Missing test for old-format wake bucket backward-compat fallback (source field missing). |
| 5 | LOW | Backward-compat `logger.warn` could be noisy on first deploy; consider `logger.info`.

### [A2/A3] Config YAML and Schema

| # | Severity | Issue |
|---|----------|-------|
| 1 | MEDIUM | Schema uses `z.record(z.string(), ...)` which accepts any string key — typos in source names would pass validation silently. Consider using `z.object({ watch_threshold: ..., discovery_delta: ..., regime_change: ... }).partial()` for compile-time key validation. |
| 2 | MEDIUM | `WakePolicyEntry` interface in monitor.ts doesn't declare `mode` field yet — forward-compat gap for Part B. |
| 3 | LOW | YAML comment references `mode` but no mode entries exist yet (Part B). |
| 4 | LOW | Schema `cooldownMs` minimum of 1000ms is undocumented.

### [B1] Mode-Based Delivery (Monitor Side)

| # | Severity | Issue |
|---|----------|-------|
| 1 | HIGH | Runtime-side work for context-mode events not yet implemented (deferred to B2-B5). `mode: context` at monitor level works but events are silently dropped until runtime support exists. |
| 2 | MEDIUM | Missing test: `regime_change` with `wake` or `batched` mode — only `context` mode tested for regime_change. |
| 3 | LOW | `batched` and `wake` are identical at monitor level (by design — differentiation is in cooldownMs). |
| 4 | LOW | Default config doesn't include `mode` fields — all sources default to `'wake'`.

### [B2/B3/B4] Runtime Context Handling

| # | Severity | Issue |
|---|----------|-------|
| 1 | LOW | Regime pass mismatch in recomputation when positions are open — causes one extra LLM call, errs safely. |
| 2 | LOW | No event ordering stability in `computeMarketEventDigest` (events not sorted before hashing). |
| 3 | LOW | Context provider doesn't handle unknown event types gracefully (else branch casts incorrectly). |
| 4 | LOW | `PendingMarketEvent.type` union not derived from domain constants. |
| 5 | LOW | Root `pnpm lint` silently misses TypeScript errors in referenced projects (pre-existing `composite` + `--noEmit` issue).
