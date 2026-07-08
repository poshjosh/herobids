
## Prompt 1

Costs are up, find out why

## Response 1

### The Real Cost Driver: Discovery Delta Flood

The root cause of high costs is **not your 010 changes**. It's the market monitor's discovery delta system.

### Data

| | Count | % of total ticks |
|---|---|---|
| **Wake-triggered ticks** (always → LLM) | 716 | **71%** |
| Scheduled ticks skipped by gate | 160 | 16% |
| Scheduled ticks that ran LLM | 137 | 13% |
| **Total** | 1,013 | 100% |

The gate is working correctly on scheduled ticks: **54% skip rate** (160 of 297 scheduled). The problem is that scheduled ticks are only 29% of the total. The other 71% are wake-triggered and **always fire the LLM** — the gate can't block them by design.

### Where the wakes come from

```
market-monitor → "Discovery delta: entered top set" → wake signal → all 8 agents → 8 LLM calls
```

The market monitor fires ~69 discovery delta events per hour. Each goes to every agent. With `wake.minIntervalMs: 15000`, agents coalesce some, but the majority still trigger LLM calls. Three agents (`118cebbc`, `eab9dc08`, `4740025a`) show 86-89% wake-triggered tick rates — they're essentially running the LLM almost continuously.

### What this means

| Cost driver | Contribution | Fixable by 010? |
|---|---|---|
| Discovery delta wake flood | ~71% of ticks | **No** — wakes bypass tick gate by design |
| Scheduled ticks (gate working) | ~13% of ticks | Already optimized (54% skip rate) |
| Scheduled ticks (gate can't skip) | ~16% of ticks | Some room, but diminishing returns |

### Advice

The 010 changes are working as designed. The path to actual cost reduction is to address the discovery delta pipeline:

1. **Reduce discovery delta sensitivity** — the market monitor currently fires on any token entering a top set. Tightening the threshold or adding a cooldown per-symbol would cut the dominant cost driver.

2. **Per-agent wake filtering** — not every agent needs every discovery delta. A scanner-only agent shouldn't get price alert wakes. Filtering at the wake publish layer would cut cross-agent amplification.

3. **Raise `wake.minIntervalMs`** — currently 15 seconds. Raising to 30 or 60 seconds would coalesce more discovery deltas into fewer LLM calls. The tradeoff is slower reaction to genuine market events.

None of these are tick-gate changes. The tick gate is doing its job — the problem is that 71% of ticks never reach it.

## Prompt 2

How could we reduce costs?

## Response 2

Here's the end-to-end flow that drives your costs:

```
Every 15s: evaluateDiscoveryDeltas()
  → Reads "top set" of tokens from market-intel:discovery:latest
  → Finds newly-entered tokens (not in previous snapshot)
  → For each new token (per-symbol dedupe: 10 min cooldown):
      → For each of 8 agents:
          → enqueueWake() → per-agent bucket (coalescing: 3s window)

Every 3s: flushPendingWakes()
  → For each agent bucket (per-agent cooldown: 30s):
      → Publish AgentWakePayload to Redis stream

Agent picks up wake → wakePending=true → scheduleNextTick
  → minIntervalMs check (15s) → LLM call
```

Key constants in `market-intelligence/monitor.ts`:

| Constant | Value | What it limits |
|----------|-------|----------------|
| `DISCOVERY_COOLDOWN_MS` | 10 min | Same token re-triggering |
| `WAKE_COALESCING_WINDOW_MS` | 3 sec | Batching multiple events into one wake |
| `WAKE_COOLDOWN_MS` | 30 sec | How often an agent can be woken (ALL sources) |
| `MAX_EVENTS_PER_AGENT_PER_MINUTE` | 20 | Per-agent event rate cap (not binding) |
| `wake.minIntervalMs` | 15 sec | Agent-side tick spacing |

The per-agent wake cooldown (30s) means each agent gets at most ~2 wake-driven LLM calls per minute. With 8 agents, that's ~16/min from discovery deltas alone, plus scheduled ticks.

### Option 1: Source-specific wake cooldowns (highest impact, moderate effort)

**Currently** `WAKE_COOLDOWN_MS = 30_000` applies to ALL wake sources equally. A stop-loss watch trigger and a "new memecoin entered top set" both get the same 30-second throttle.

**Change**: Make the cooldown configurable per wake source. Discovery deltas get a 5-minute cooldown. Watch thresholds keep 30 seconds.

```typescript
// In market-intelligence/monitor.ts, flushPendingWakes()
const COOLDOWNS: Record<string, number> = {
  watch_threshold: 30_000,    // stop-loss/TP — keep fast
  discovery_delta: 300_000,   // new tokens — slow down to 5 min
  regime_change: 120_000,     // market regime — 2 min is fine
  scanner: 30_000,           // technical scans — keep fast
};
const effectiveCooldown = COOLDOWNS[wake.primarySource ?? 'watch_threshold'] ?? WAKE_COOLDOWN_MS;
```

**Impact**: Discovery-delta-driven LLM calls drop from ~2/min/agent to ~0.2/min/agent. Overall cost reduction: ~40-50%.

**Files**: `market-intelligence/monitor.ts` only.

---

### Option 2: Make discovery deltas non-wakeable (highest impact, more effort)

Discovery deltas are informational — "a new token appeared." They don't need an immediate LLM response. Deliver them as **context enrichment** on the next scheduled tick instead of as a wake signal.

**Change**: In `evaluateDiscoveryDeltas()`, publish the event to the agent's context stream without calling `enqueueWake()`. The agent sees it on its next normal tick (or next wake from a higher-priority source).

**Impact**: Completely eliminates discovery-delta-driven LLM calls. Cost reduction: ~50-60%.

**Files**: `market-intelligence/monitor.ts` and runtime-composition.ts (to handle discovery delta context without a wake trigger).

---

### Option 3: Per-agent wake source subscription (moderate impact, more effort)

Not every agent cares about every wake source. A perps-trading agent doesn't need to know about new Solana memecoins.

**Change**: Add a `subscribedWakeSources` field to agent config. The market monitor checks it before enqueuing a wake.

**Impact**: Depends on agent configuration. If half your agents are perps-focused, cuts discovery delta cost by 50%.

**Files**: agent config schema, `market-intelligence/monitor.ts`, agent runtime.

---

### Recommendation

**Option 1** is the clear winner — single file change, no new config surface, immediate impact. A 5-minute cooldown on discovery deltas is safe because:
- The 10-minute per-symbol dedupe already prevents re-triggers
- Discovery deltas are low-urgency by nature
- Agents still see them — just at most once every 5 minutes instead of every 30 seconds

## Prompt 3

We would like a comprehensive solution involving as many options as feasible and targeted at a long term solution.

## Response 3

Good question. Let me think through the interactions, caveats, and whether all three together make sense.

The three options actually work at **different layers** of the pipeline and complement each other:

```
┌─────────────────────────────────────────────────────┐
│  Layer 3 (Option 3): Subscription filter           │
│  "Does this agent even want discovery deltas?"      │
│  If no → drop immediately, zero cost               │
├─────────────────────────────────────────────────────┤
│  Layer 2 (Option 1): Source-specific throttle      │
│  "How fast can this source wake an agent?"          │
│  If within cooldown → coalesce, deliver later       │
├─────────────────────────────────────────────────────┤
│  Layer 1 (Option 2): Delivery mechanism             │
│  "Should this be a wake, or just context?"          │
│  If context-only → attach to next tick, no wake     │
└─────────────────────────────────────────────────────┘
```

They don't conflict. But there are important caveats, an implementation order that matters, and alternatives worth considering before committing to all three.

---

## Caveats

### Option 3 (subscriptions) — the sharpest edges

- **Default must be "all sources"**. If existing agents wake up without `subscribedWakeSources`, they must receive everything. Otherwise 8 agents go silent on deployment.
- **Needs a UI**. Without a control in the agent form, this is config-file-only and nobody will use it. That's scope creep — the plan needs to include web changes.
- **Discovery dependency**. `getActiveAgentIds()` currently returns agents with *any* watches. If an agent unsubscribes from discovery deltas but has watch_threshold subscriptions, the function still includes them — and they still get discovery delta wakes. The filter must move from `getActiveAgentIds` to per-source evaluation.

### Option 1 (source-specific cooldowns) — the subtle one

- **Watch threshold at 30s is already borderline**. A stop-loss watch triggers at 30s cooldown → agent wakes → LLM evaluates → submits decision → executor acts. If price moved 2% in those 30 seconds, the stop-loss is already blown. Consider **15s for watch_threshold** and longer for everything else.
- **Cooldowns must be operator-configurable, not hardcoded**. These are tuning parameters that will need adjustment based on real-world data. Put them in default.yaml under `agentRuntime.marketMonitor.wakeCooldownMs`.

### Option 2 (non-wakeable discovery deltas) — the breaking change

- **Some agents may depend on discovery delta wakes**. An agent programmed to "immediately scan every new token" would break if discovery deltas stop waking it. Need a **per-agent opt-in flag** (`discoveryDeltasAsContextOnly`) so existing agents keep current behavior.
- **Staleness risk**. If an agent ticks every 5 minutes and a discovery delta arrives at minute 1, the token's price/liquidity could have shifted significantly by minute 5. Context-only works for informational awareness, not for time-sensitive action.
- **Context enrichment path doesn't exist yet**. Today, wake context flows into `runtimeState.metrics.currentMarketWake`. A non-wake delivery needs a separate path — `runtimeState.metrics.pendingContextEvents` or similar. This is new plumbing.

---

## Alternatives Worth Considering

Before locking into all three, consider these:

**A. Wake priority system** instead of Option 2's binary wake/context split. Three tiers:
- `immediate` — stop-loss, take-profit (tick now)
- `batched` — discovery deltas, regime changes (deliver on next tick or after 60s, whichever comes first)
- `informational` — attached to context, never wakes

More nuanced than Option 2 alone, and subsumes most of Option 1's throttling.

**B. Discovery delta aggregation** in the market monitor. Instead of "token A entered" + "token B entered" as separate events 2 seconds apart, aggregate into "top set update: 5 new tokens, 2 exited" delivered once per evaluation cycle. One wake with 20 tokens costs the same as one wake with 1 token (same LLM call either way), but the agent gets the full picture. This is a market-monitor-only change.

**C. Evaluation frequency tuning**. The 15-second evaluation interval means ~240 evaluations/hour. Each one compares against the previous snapshot and fires on any delta. Raising to 30s halves the event volume. Raising discovery delta evaluation specifically to 60s (independent of watch threshold evaluation) would cut discovery delta volume by 4× with zero code changes beyond config.

**D. Token churn threshold**. Today, any token not in the previous snapshot triggers a wake. Adding a minimum rank or liquidity threshold would filter out noise — only tokens in the top-N or above $X liquidity trigger events.

---

## Recommended Long-Term Architecture

Rather than implementing all three options as separate features, I'd recommend a **layered wake policy** that combines their logic cleanly:

Operator config (config/default.yaml) — platform-wide policy

```yaml
agentRuntime:
  marketMonitor:
    wakePolicy:
      watch_threshold:
        mode: wake           # always wake the agent
        cooldownMs: 15000    # max 4 wakes/min from this source
      discovery_delta:
        mode: context        # attach to next tick, don't wake
        aggregate: true      # batch all deltas since last tick
        cooldownMs: 0        # N/A when mode=context
      regime_change:
        mode: batched        # wake after cooldown expires or next tick
        cooldownMs: 120000   # max 1 wake/2min
      scanner:
        mode: wake
        cooldownMs: 15000
```

**Agent instance config** (per-agent, stored in `trading_instances.config` JSONB, set via API/UI) — NOT in operator config:

```json
{
  "wakePreferences": {
    "subscribedSources": ["watch_threshold", "regime_change"]
  }
}
```

This follows the existing two-layer config pattern from AGENTS.md:

| Layer | What | Controls |
|-------|------|----------|
| Operator config | Default modes + cooldowns per source | All agents by default |
| Instance config | `wakePreferences.subscribedSources` | Which sources *this specific agent* receives |

The market monitor checks both: operator config for the source's mode/cooldown, agent instance config to see if the agent subscribes to that source at all. If `subscribedSources` is absent, the agent gets everything (backward compatible). If present, only listed sources deliver wakes to that agent.

This is essentially all three options expressed as a single config-driven policy. The implementation surfaces are:

1. **Config schema** — `wakePolicy` with source-specific mode/cooldown
2. **Market monitor** — read policy, apply mode (wake/context/batched) and cooldown
3. **Agent runtime** — handle `mode: context` delivery on next tick
4. **Agent config/UI** — per-agent overrides for `subscribedSources`

### Delivery order

| Phase | What | Effort | Impact |
|-------|------|--------|--------|
| **1** | Source-specific cooldowns in market monitor (Option 1 core) | ~1 file | 40-50% cost reduction |
| **2** | `mode: context` delivery for discovery deltas (Option 2 core) | ~3 files | Additional 15-20% |
| **3** | Per-agent subscriptions + UI (Option 3 core) | ~5 files + web | Long-term control |

Phase 1 is the quick win. Phase 2 builds on it. Phase 3 adds the user-facing control layer. Each phase ships independently and provides value on its own — you can stop after Phase 1 if costs are under control.