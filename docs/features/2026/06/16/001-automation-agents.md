# 001 — Unified Agent Model with Technical + Intelligence Capabilities

A single Agent concept with two optional capability dimensions: `technical`
(rule-based indicators and discovery) and `intelligence` (LLM reasoning). At
least one must be configured. The combination determines behavior and cost.

**Depends on:** Indicator suite (RSI, MACD, S/R, CHOCH, volume trend) in
`@herobids/market-data`, existing regime evaluation, existing discovery pipeline.

---

## Background

HeroBids currently supports:
- **Bots** — single-instrument executors configured with explicit venue + symbol
- **AI Agents** — LLM-driven actors that reason via tools and prompts

### Problems

1. **No zero-cost multi-instrument trading.** Users who want rule-based automation
   across multiple instruments must create N bots manually or pay for LLM-driven
   agent reasoning.
2. **Cost barrier.** In key target markets (India, Pakistan, Nigeria), LLM costs
   per decision cycle are prohibitive for small accounts.
3. **Instrument selection requires human knowledge.** Bots must be told exactly
   what to trade. There is no system that discovers instruments using rules alone.
4. **Artificial taxonomy.** Separating "AI Agent" from "Automation Agent" creates
   unnecessary product complexity. Users don't think in types — they think in
   capabilities.

### Insight

An agent is just an entity with agency. What gives it agency is configurable:
- Technical rules (indicators, filters, regime gates)
- LLM intelligence (reasoning, judgment, creativity)
- Both together (cheap pre-filter → expensive reasoning)

No need for separate actor types. One agent, two optional knobs.

---

## Scope

### In Scope

- Unified agent config with optional `technical` and `intelligence` sections
- Multi-instrument discovery and scanning (when `technical.filters` present)
- Indicator-based scoring (RSI, MACD, volume, S/R, CHOCH, confidence aggregation)
- Regime gate integration (existing `evaluateRegime()`)
- Signal bias parameter (`trend-following` | `mean-reverting`)
- LLM enrichment: structured indicator data fed into agent context when both
  `technical` and `intelligence` are present
- Self-configuration: AI agents can add/modify their own `technical` section
- Paper/shadow/live execution modes
- Constraint: agents cannot create other agents (only users create agents)

### Out of Scope

- Sentiment provider (Twitter/social) — follow-up
- UI redesign — separate feature spec
- Bot deprecation — deferred, bots continue to work
- Custom indicator plugins — only built-in indicators
- Agent-to-agent communication — not needed under unified model

---

## Design

### Capability Matrix

| `technical` | `intelligence` | Behavior | Cost | Use Case |
|---|---|---|---|---|
| ✅ | ❌ | Indicators discover + decide | ~$0 | Budget users, strategy testing |
| ❌ | ✅ | LLM reasons + decides (current AI Agent) | $$$ | Full AI reasoning |
| ✅ | ✅ | Indicators pre-filter → LLM decides | $ | Cost-optimized AI trading |

At least one section must be present. Validation rejects configs with neither.

### Runtime Loop

```
Every scanInterval (when technical present) or wakeInterval (intelligence only):

  ┌─ TECHNICAL PHASE (if technical configured) ────────────────┐
  │ 1. Discover candidates (filtered by venue/volume/liquidity) │
  │ 2. Regime gate → block new entries if market is choppy      │
  │ 3. For each candidate:                                      │
  │    a. Fetch candles (batched, rate-limited)                  │
  │    b. Compute indicators (RSI, MACD, volume, CHOCH, S/R)    │
  │    c. Aggregate confidence (weighted)                        │
  │    d. Apply signal bias                                      │
  │ 4. Rank by confidence                                        │
  │ 5. For open positions: evaluate exit indicators              │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ DECISION PHASE ───────────────────────────────────────────┐
  │ IF intelligence configured:                                 │
  │   Feed ranked candidates + indicator scores + positions     │
  │   into LLM context → LLM makes final decision              │
  │ ELSE:                                                       │
  │   Decide directly: top N by confidence → go_long            │
  │   Exit positions below threshold → go_flat                  │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ EXECUTION PHASE ──────────────────────────────────────────┐
  │ 6. Submit decisions via execution infrastructure             │
  │ 7. Plan → orders → fills → persist                          │
  └─────────────────────────────────────────────────────────────┘
```

### Config Schema

```typescript
const TechnicalConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),       // Explicit allowlist
    excludeSymbols: z.array(z.string()).optional(),
  }),
  regime: RegimeParamsSchema.optional(),
  indicators: IndicatorConfigSchema.default({}),
  candles: z.object({
    interval: z.enum(['5m', '15m', '1H', '4H', '1D']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }).default({}),
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),
  scanIntervalMs: z.number().int().min(10_000).default(60_000),
  scanBatchSize: z.number().int().min(1).max(50).default(5),
});

const IntelligenceConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  goal: z.string(),                 // Free-text agent goal/instructions
  maxTokens: z.number().int().optional(),
  wakeIntervalMs: z.number().int().min(10_000).optional(),
  // ... existing AI agent config fields
});

const IndicatorConfigSchema = z.object({
  rsi: z.object({
    enabled: z.boolean().default(true),
    period: z.number().int().min(2).default(14),
    healthyMin: z.number().default(40),
    healthyMax: z.number().default(70),
    overbought: z.number().default(80),
    weakBelow: z.number().default(30),
  }).default({}),
  macd: z.object({
    enabled: z.boolean().default(true),
    fast: z.number().int().default(12),
    slow: z.number().int().default(26),
    signal: z.number().int().default(9),
  }).default({}),
  volume: z.object({
    enabled: z.boolean().default(true),
    strongRatio: z.number().default(1.5),
    weakRatio: z.number().default(0.5),
    recentBars: z.number().int().default(4),
    avgBars: z.number().int().default(20),
  }).default({}),
  choch: z.object({
    enabled: z.boolean().default(false),
    swingLookback: z.number().int().default(5),
    minSwingPct: z.number().default(0.01),
    minSwings: z.number().int().default(4),
    confirmBars: z.number().int().default(2),
    rejectOnBearish: z.boolean().default(false),
  }).default({}),
  supportResistance: z.object({
    enabled: z.boolean().default(false),
    lookback: z.number().int().default(50),
    breakoutThreshold: z.number().default(0.005),
  }).default({}),
  confidence: z.object({
    rsiWeight: z.number().default(0.15),
    macdCrossoverWeight: z.number().default(0.20),
    macdIncreasingWeight: z.number().default(0.10),
    volumeWeight: z.number().default(0.15),
    breakoutWeight: z.number().default(0.15),
    chochBullishWeight: z.number().default(0.15),
    chochBearishPenalty: z.number().default(0.10),
    priceActionWeight: z.number().default(0.10),
    minConfidence: z.number().default(0.45),
    minReasons: z.number().int().default(2),
  }).default({}),
});

const UnifiedAgentConfigSchema = z.object({
  technical: TechnicalConfigSchema.optional(),
  intelligence: IntelligenceConfigSchema.optional(),
  risk: z.object({
    maxPositions: z.number().int().min(1).default(5),
    maxPositionSizePct: z.number().min(0).max(100).default(10),
    dailyMaxLossPct: z.number().min(0).max(100).optional(),
    stopLossPct: z.number().min(0).optional(),
    takeProfitPct: z.number().min(0).optional(),
  }).default({}),
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
    positionSizeMode: z.enum(['fixed', 'percent_equity']).default('percent_equity'),
    fixedPositionSize: z.string().optional(),
  }).default({}),
}).refine(
  (data) => data.technical != null || data.intelligence != null,
  { message: 'At least one of technical or intelligence must be configured' },
);
```

### Self-Configuration by AI Agents

An AI Agent (with `intelligence`) can use tools to modify its own config:

```
// Agent adds technical pre-filter to itself
update_own_config({
  technical: {
    filters: { venue: 'hyperliquid', minVolume24hUsd: 50000 },
    indicators: { rsi: { enabled: true }, macd: { enabled: true } },
  },
  execution: { mode: 'paper' }  // Test first
})
```

This enables the "AI agent tests a strategy on live market" use case without
creating child agents. The agent reconfigures itself, observes results, then
commits or reverts.

### Key Constraint: Agents Cannot Create Agents

Only users create agents. This prevents:
- Infinite recursion (agent spawns agent spawns agent)
- Unclear accountability (who authorized this trading?)
- Runaway resource consumption

An AI agent that wants to "test a strategy" either:
- Adds `technical` to its own config (live market testing)
- Calls the `run_backtest` tool (historical testing)

---

## DB Schema Changes

```sql
-- No agent_kind column needed. Capability is determined by config contents.
-- Existing agents table remains as-is.
-- The agents.config JSONB already stores arbitrary config.
-- Validation happens at API write time via UnifiedAgentConfigSchema.
```

No migration required. The config JSONB field gains new validated structure.

---

## API

Existing agent endpoints work unchanged:

```
POST   /agents           — Create agent (config determines capabilities)
PATCH  /agents/:id       — Update config (add/remove technical or intelligence)
POST   /agents/:id/start — Start agent
POST   /agents/:id/stop  — Stop agent
GET    /agents/:id       — Get status, positions, scan results
```

The runtime inspects config at startup to determine which phases to run.

---

## Acceptance Criteria

1. An agent with only `technical` discovers instruments and trades at zero LLM cost
2. An agent with only `intelligence` works exactly as current AI Agents
3. An agent with both runs indicators first, feeds results into LLM context
4. Config validation rejects agents with neither `technical` nor `intelligence`
5. An AI agent can add `technical` to itself via self-config tool
6. Agents cannot create other agents (API rejects, tools unavailable)
7. Regime gate blocks new entries when market is choppy
8. Confidence scoring respects weights, minConfidence, minReasons
9. Signal bias flips RSI/CHOCH interpretation correctly
10. Paper mode produces realistic simulated fills
11. `pnpm lint && pnpm test` pass

---

## Open Questions

1. **Execution infrastructure sharing** — Does the technical-only agent reuse
   `TradingActor` internals per instrument, or manage positions directly? The
   current `TradingActor` is heavyweight (reconciliation, private streams, swap
   recovery). A lighter executor may be appropriate for multi-instrument agents.

2. **Exit strategy for technical-only** — What indicator conditions trigger exits?
   Options: RSI overbought, confidence drops below threshold, trailing stop-loss,
   time-based, or a combination.

3. **Config migration** — Existing AI agents have a different config shape. Do we
   migrate them to `{ intelligence: { ... } }` or support both formats with a
   compatibility layer?

4. **Presets** — Ship named presets ("Momentum Breakouts", "Mean Reversion") as
   default `technical` configs users can select without understanding parameters?

5. **Scan interval vs wake interval** — When both `technical` and `intelligence`
   are present, which interval drives the loop? Likely: technical scanInterval
   drives indicator computation, intelligence wakes on its own schedule and reads
   latest technical results.

---

## Implementation Phases

| Phase | Deliverable |
|---|---|
| 1 | Indicator suite: RSI, MACD, S/R, volume trend, CHOCH in `@herobids/market-data` |
| 2 | Scan engine: multi-candidate scoring module in `@herobids/strategy` |
| 3 | Agent runtime: technical phase in agent actor (discovery → score → decide) |
| 4 | Execution extraction: reusable executor from `TradingActor` |
| 5 | LLM enrichment: indicator results injected into AI agent context |
| 6 | Self-config: AI agent can add/modify its own `technical` section |
