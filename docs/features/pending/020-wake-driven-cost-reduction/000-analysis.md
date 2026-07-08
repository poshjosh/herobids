
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