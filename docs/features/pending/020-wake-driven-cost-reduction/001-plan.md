# 020 — Wake-Driven Cost Reduction Plan

**Status:** Draft  
**Created:** 2026-07-08  
**Source inputs:**
- `docs/features/pending/020-wake-driven-cost-reduction/000-analysis.md`
- Production data from 8 agents on 2026-07-08
- Code trace of `market-intelligence/monitor.ts`, `agent-wake-scheduler.ts`, `agent.ts`

## Problem

After deploying 010-llm-cost-reduction (tick gate fingerprint expansion), LLM costs did not decrease. Investigation revealed the tick gate is working correctly — **54% skip rate on scheduled ticks** — but scheduled ticks account for only 29% of all ticks. The other 71% are wake-triggered and always fire the LLM.

The primary wake source is the market monitor's **discovery delta** system (`market-intelligence/monitor.ts`). Every 15 seconds it evaluates the "top set" of tokens from Redis, finds newly-entered tokens, and publishes a wake signal to ALL active agents. Each wake triggers an LLM call.

### Evidence (2026-07-08 production)

| | Count | % of total ticks |
|---|---|---|
| Wake-triggered ticks (always → LLM) | 716 | 71% |
| Scheduled ticks skipped by gate | 160 | 16% |
| Scheduled ticks that ran LLM | 137 | 13% |
| **Total** | 1,013 | 100% |

Discovery delta events: ~69/hour. Delivered to all 8 agents. Per-agent wake cooldown (30s) caps at ~2 wake-driven LLM calls per minute per agent from ALL sources combined.

### Current pipeline

```
Every 15s: evaluateDiscoveryDeltas()
  → Reads "top set" from market-intel:discovery:latest
  → Finds newly-entered tokens (not in previous snapshot)
  → For each new token (per-symbol dedupe: 10 min):
      → For each of 8 agents:
          → enqueueWake() → per-agent bucket (coalescing: 3s)

Every 3s: flushPendingWakes()
  → For each agent bucket (per-agent cooldown: 30s):
      → Publish AgentWakePayload to Redis stream

Agent picks up wake → wakePending=true → scheduleNextTick
  → minIntervalMs check (15s) → LLM call
```

## Design

### Architecture: Layered Wake Policy

Three layers, each operating independently at a different point in the pipeline:

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: Subscription filter (instance config)     │
│  "Does this agent want this wake source?"            │
│  If no → drop, zero cost                            │
├─────────────────────────────────────────────────────┤
│  Layer 2: Source-specific throttle (operator config) │
│  "How often can this source wake an agent?"          │
│  Within cooldown → coalesce, deliver later           │
├─────────────────────────────────────────────────────┤
│  Layer 1: Delivery mode (operator config)            │
│  "Wake, batch, or context-only?"                     │
│  Context-only → attach to next tick, don't wake      │
└─────────────────────────────────────────────────────┘
```

### Config Model (Two-Layer)

**Operator config** (`config/default.yaml`) — platform-wide defaults:

```yaml
agentRuntime:
  marketMonitor:
    wakePolicy:
      watch_threshold:
        mode: wake           # always wake the agent immediately
        cooldownMs: 15000    # max 4 wakes/min from this source
      discovery_delta:
        mode: batched        # wake after cooldown or next scheduled tick
        cooldownMs: 300000   # max 1 wake/5min from this source
      regime_change:
        mode: batched
        cooldownMs: 120000   # max 1 wake/2min
      scanner:
        mode: wake
        cooldownMs: 15000
```

**Instance config** (`trading_instances.config` JSONB, per-agent, set via API/UI):

```json
{
  "wakePreferences": {
    "subscribedSources": ["watch_threshold", "regime_change", "scanner"]
  }
}
```

If `wakePreferences.subscribedSources` is absent, the agent receives all sources (backward compatible). If present, only listed sources deliver wakes.

### Wake Delivery Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| `wake` | Publish wake immediately (subject to cooldown). Agent wakes and runs LLM. | Stop-loss, take-profit, scanner signals |
| `batched` | Hold until cooldown expires OR next scheduled tick fires. Deliver as wake at that point. | Regime changes, discovery deltas (moderate urgency) |
| `context` | Attach to agent's context stream. Never triggers a wake. Agent sees it on its next tick (wake or scheduled). | Discovery deltas (informational only) |

## Part A — Source-Specific Cooldowns (Phase 1)

### Why

The current `WAKE_COOLDOWN_MS = 30_000` applies uniformly to all wake sources. This means a stop-loss trigger and a "new memecoin" notification share the same throttle. Stop-loss needs sub-30s responsiveness; discovery deltas do not.

### Approach

Replace the single `WAKE_COOLDOWN_MS` constant with a per-source lookup in `flushPendingWakes()`. Cooldowns come from operator config under `agentRuntime.marketMonitor.wakePolicy.<source>.cooldownMs`.

### Changes

**`apps/worker/src/market-intelligence/monitor.ts`**:
- In `flushPendingWakes()`: read `primarySource` from the pending wake, look up its cooldown from config, apply instead of hardcoded `WAKE_COOLDOWN_MS`
- Keep existing `WAKE_COOLDOWN_MS` as fallback for unknown sources

**`config/default.yaml`**:
- Add `agentRuntime.marketMonitor.wakePolicy` with per-source `cooldownMs` defaults

**`packages/domain/src/config/schema.ts`**:
- Add `wakePolicy` schema to `AgentRuntimeConfig`

### Acceptance criteria

- Discovery delta wakes respect a 5-minute cooldown per agent
- Watch threshold wakes still respect a 15-second cooldown
- Unknown wake sources fall back to the existing 30-second default
- Existing tests pass, new tests cover per-source cooldown behavior

## Part B — Batched and Context Delivery Modes (Phase 2)

### Why

Discovery deltas are informational — they don't require immediate LLM response. Delivering them as context on the next tick (rather than triggering a wake) eliminates their cost entirely. The `batched` mode provides an intermediate option for sources that warrant attention but not urgency.

### Approach

**Market monitor side:**
- When `mode: context`, publish the event to a `market-monitor:context:<agentId>` Redis key instead of `enqueueWake()`
- When `mode: batched`, enqueue normally but mark the wake with `deliveryMode: 'batched'` so the flush logic applies the cooldown more aggressively
- When `mode: wake`, current behavior (enqueue + flush with cooldown)

**Agent runtime side:**
- On tick start, read `market-monitor:context:<agentId>`, drain events into `runtimeState.metrics.pendingContextEvents`
- Render pending context events in the prompt alongside other enrichment
- Clear the context key after draining

### Changes

**`apps/worker/src/market-intelligence/monitor.ts`**:
- In `evaluateDiscoveryDeltas()` and `evaluateRegimeChanges()`: check source mode; if `context`, write to context key instead of calling `enqueueWake()`
- In `enqueueWake()`: accept optional `deliveryMode` field on `PendingWake`
- In `flushPendingWakes()`: respect `deliveryMode`

**`apps/worker/src/runtime-composition.ts`**:
- Add `pendingContextEvents` field to `RuntimeSessionMetrics`
- Add `recordPendingContextEvents()` function to drain context key into metrics

**`apps/worker/src/agent.ts`**:
- Before tick gate: drain `market-monitor:context:<agentId>` into runtime state
- Include pending context events in prompt enrichment

**`config/default.yaml`** — add `mode` field per source

**`packages/domain/src/config/schema.ts`** — add `mode` to wake policy schema

### Acceptance criteria

- `mode: context` sources never trigger a wake, regardless of event volume
- Context events appear in the agent's next tick prompt
- `mode: batched` sources respect their cooldown and the next-scheduled-tick delivery rule
- `mode: wake` sources behave identically to current behavior
- Existing wake behavior (watch thresholds, scanner) unchanged

## Part C — Per-Agent Wake Subscriptions (Phase 3)

### Why

Not every agent needs every wake source. A perps-trading agent doesn't need discovery deltas from Solana memecoins. Letting agents opt out of irrelevant wake sources reduces cross-agent amplification and gives creators control over their cost profile.

### Approach

Add `wakePreferences.subscribedSources` to the agent instance config (NOT operator config). If absent, agent receives all sources (backward compatible). If present, only listed sources deliver events.

The market monitor checks the agent's instance config before enqueuing or context-writing for that agent. The check happens in `getActiveAgentIds()` result processing — filter agents by subscription before iterating.

### Changes

**`packages/domain/src/config/schema.ts`**:
- Add `wakePreferences` to agent instance config schema (the one validated at API write time for `trading_instances.config`)

**`apps/worker/src/market-intelligence/monitor.ts`**:
- `getActiveAgentIds()` → return `Array<{ agentId: string; subscribedSources?: string[] }>` instead of `string[]`
- Before enqueuing/context-writing for an agent, check if the source is in `subscribedSources` (or if `subscribedSources` is absent → allow all)

**`apps/web/src/` (agent form)**:
- Add wake source subscription checkboxes to agent configuration UI
- Only shown for agents with trading capability

### Acceptance criteria

- Agent with `subscribedSources: ["watch_threshold"]` receives watch threshold wakes but NOT discovery delta or regime change wakes
- Agent without `subscribedSources` receives ALL wake sources (backward compatible)
- Changing `subscribedSources` via API takes effect on the next market monitor evaluation cycle
- UI allows toggling individual wake sources

## Non-Goals

- Do not change the market monitor evaluation interval (separate tuning concern)
- Do not change the discovery delta snapshot format or top-set selection logic
- Do not change the agent-side `wake.minIntervalMs` (agent tick scheduling is separate)
- Do not remove any existing wake source

## Test Plan

### Part A
- Per-source cooldown lookup returns correct value for each known source
- Unknown source falls back to default
- Cooldown respected in `flushPendingWakes()` — wake suppressed when within window
- Multiple sources interleaved: each source's cooldown tracked independently

### Part B
- `mode: context` writes to context key, does NOT call `enqueueWake()`
- Agent drains context key on tick start and includes events in prompt
- `mode: batched` delivers wake after cooldown or on next scheduled tick
- `mode: wake` unchanged from current behavior

### Part C
- Agent without `subscribedSources` receives all sources
- Agent with `subscribedSources: ["watch_threshold"]` only receives watch threshold events
- Subscription check bypasses rate limiting and enqueuing entirely for filtered sources

## Rollout Notes

- **Phase 1** ships independently — single file change, immediate cost impact (~40-50% reduction)
- **Phase 2** builds on Phase 1's config structure, adds new delivery modes without changing existing behavior
- **Phase 3** adds user-facing control; dependent on Phase 1 config being in place
- All phases are backward compatible — agents without new config fields behave identically to today
- Defaults in operator config should mirror current behavior (all sources `mode: wake`, cooldowns at current values) until explicitly tuned
