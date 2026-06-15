# 001 — Automation Agents

Rule-based, multi-instrument trading actors that discover instruments, evaluate
technical indicators, and submit decisions without LLM dependency. Enables
near-zero-cost algorithmic trading for cost-sensitive markets.

**Depends on:** Indicator suite (RSI, MACD, S/R, CHOCH, volume trend) in
`@herobids/market-data`, existing regime evaluation, existing discovery pipeline.

---

## Background

HeroBids currently supports two strategy types for bots (`momentum`, `llm`) and
one agent type (AI Agent, LLM-driven). Bots are single-instrument executors that
must be told exactly which instrument to trade. AI Agents can discover and trade
across instruments but cost $0.01–$0.10 per decision cycle in LLM token fees.

The old `aitradingbot` system had a full mechanical strategy stack that could scan
20+ instruments, apply technical indicator filters, rank by confidence, and trade
the top N — all at near-zero cost. This capability has no equivalent in HeroBids.

### Problem Statement

1. **No zero-cost multi-instrument trading.** Users who want rule-based automation
   across multiple instruments must either create N bots manually (knowing exact
   instruments) or pay for an AI Agent.
2. **Cost barrier.** In key target markets (India, Pakistan, Nigeria), LLM costs
   per decision cycle are prohibitive for small accounts.
3. **Instrument selection requires human knowledge.** The current bot model assumes
   the user (or an AI agent) knows which instruments to trade. There is no system
   that discovers instruments autonomously using rules alone.

### Prior Art

The `aitradingbot` project solved this with:
- `MechanicalEngine` — multi-candidate scanner using RSI, MACD, volume, CHOCH,
  support/resistance, VWAP, sentiment, and confidence-weighted scoring
- `HybridEngine` — mechanical pre-filter + LLM final judgment (cost optimization)
- `PlaybookValidator` — post-decision filter (liquidity, position limits, parabolic)
- `evaluateRegimeFromData()` — benchmark regime gate using EMA alignment + ADX

HeroBids already has: regime evaluation, EMA, ADX, VWAP, market structure detection,
token discovery pipeline, and candle fetching from multiple providers.

---

## Scope

### In Scope

- New actor type: Automation Agent (`agent_kind = 'automation'`)
- Multi-instrument scan loop: discover → filter → fetch candles → score → trade
- Indicator-based decision engine (RSI, MACD, volume, S/R, CHOCH, confidence aggregation)
- Regime gate integration (existing `evaluateRegime()`)
- Signal bias parameter (`trend-following` | `mean-reverting`)
- Config schema: `AutomationAgentConfigSchema` (Zod, stored in agent config JSONB)
- Execution: reuses existing execution infrastructure (plan/execute/persist)
- API: Create/start/stop Automation Agents via existing agent endpoints
- Position tracking per instrument within the agent
- Paper/shadow/live execution modes

### Out of Scope

- Sentiment provider (Twitter/social) — defer to follow-up
- Cross-agent cooperation (Automation feeds AI Agent) — Phase 6 follow-up
- Bot internalization / API deprecation — separate decision
- UI changes — separate feature spec
- Backtesting Automation Agent configs — uses existing backtest infrastructure
- Custom indicator plugins — only built-in indicators

---

## Design

### Actor Model

```
┌─────────────────────────────────────────────────────────────────┐
│ Automation Agent (actor — has agency over what to trade)         │
│                                                                 │
│  Config:                                                        │
│    filters: { venue, minVolume24h, minLiquidity, networks }     │
│    regime: { benchmarkSymbol, adxMin, emaAlignment, ... }       │
│    indicators: { rsi, macd, volume, choch, confidence weights } │
│    risk: { maxPositions, maxPositionSize, dailyMaxLoss }        │
│    scanInterval: 60_000 ms                                      │
│    signalBias: 'trend-following' | 'mean-reverting'             │
│                                                                 │
│  Runtime Loop:                                                  │
│    1. Discover candidates (filtered by venue/volume/liquidity)  │
│    2. Regime gate (benchmark check) → block if choppy           │
│    3. For each candidate:                                       │
│       a. Fetch candles (batch, rate-limited)                    │
│       b. Compute indicators (RSI, MACD, volume, CHOCH, S/R)    │
│       c. Aggregate confidence (weighted)                        │
│       d. Apply signal bias interpretation                       │
│    4. Rank by confidence, select top N (within maxPositions)    │
│    5. For open positions not in top N: evaluate exit criteria   │
│    6. Submit decisions via execution layer                      │
│    7. Persist fills, update positions                           │
│    8. Wait scanInterval, repeat                                 │
└─────────────────────────────────────────────────────────────────┘
```

### DB Schema Changes

```sql
-- Extend agents table
ALTER TABLE agents ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'ai';
-- Values: 'ai' | 'automation'

-- Automation agent config stored in existing agents.config JSONB
-- Validated by AutomationAgentConfigSchema at API write time
```

### Config Schema

```typescript
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

const AutomationAgentConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),                           // 'hyperliquid' | 'jupiter'
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),     // For swap venues
    symbols: z.array(z.string()).optional(),      // Explicit allowlist (optional)
    excludeSymbols: z.array(z.string()).optional(),
  }),
  regime: RegimeParamsSchema.optional(),          // Existing schema from market-data
  indicators: IndicatorConfigSchema.default({}),
  candles: z.object({
    interval: z.enum(['5m', '15m', '1H', '4H', '1D']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }).default({}),
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),
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
    fixedPositionSize: z.string().optional(),     // Used when positionSizeMode = 'fixed'
  }).default({}),
  scanIntervalMs: z.number().int().min(10_000).default(60_000),
  scanBatchSize: z.number().int().min(1).max(50).default(5),
});
```

### Key Behaviors

**Instrument Discovery:**
- Orderbook venues (Hyperliquid): fetch all available perps, filter by volume/OI
- Swap venues (Jupiter): use existing token discovery pipeline (DexScreener, GeckoTerminal)
- Optional `symbols` allowlist to restrict to specific instruments

**Confidence Scoring:**
Each indicator contributes a weighted score. A signal passes if:
- Total confidence ≥ `minConfidence`
- Number of passing reasons ≥ `minReasons`
- No hard rejection triggered (RSI overbought, MACD negative, weak volume)

**Signal Bias:**
- `trend-following`: RSI in healthy range = bullish; CHOCH bullish = entry signal
- `mean-reverting`: RSI oversold = buying opportunity; CHOCH bearish = capitulation reversal

**Position Management:**
- Entry: submit `go_long` or `go_short` decision for top-ranked instruments
- Exit: evaluate existing positions against indicators; exit when signal degrades
  below threshold or stop-loss/take-profit hit
- The execution layer (plan → orders → fills) is reused from existing infrastructure

**Regime Gate:**
- If `regime` config is set, evaluate before each scan cycle
- If regime fails, skip new entries (existing positions still managed for exits)
- Uses existing `evaluateRegime()` from `@herobids/market-data`

---

## API

Automation Agents use the existing agent API endpoints with `agent_kind: 'automation'`:

```
POST   /agents           — Create agent (body includes agent_kind + config)
PATCH  /agents/:id       — Update config
POST   /agents/:id/start — Start the automation loop
POST   /agents/:id/stop  — Stop gracefully
GET    /agents/:id       — Get status, positions, last scan results
```

No new endpoints required. The `agent_kind` discriminator routes to the correct
runtime actor (`AgentTradingActor` for AI, `AutomationAgentActor` for Automation).

---

## Acceptance Criteria

1. A user can create an Automation Agent via API with indicator config + filters
2. The agent autonomously discovers instruments matching filters
3. The agent evaluates regime and skips entries when market is choppy
4. The agent computes RSI, MACD, volume, CHOCH on each candidate
5. The agent ranks candidates by confidence and trades top N
6. The agent respects `maxPositions` and position sizing config
7. The agent manages exits (indicator degradation, stop-loss, take-profit)
8. Paper mode produces realistic simulated fills
9. The agent runs indefinitely on its scan interval with no LLM cost
10. Existing AI Agents are completely unaffected
11. `pnpm lint && pnpm test` pass

---

## Open Questions

1. **Shared execution infrastructure** — Should the Automation Agent reuse
   `TradingActor` internals (executor, position tracker) per instrument, or
   manage a simpler position map directly? TradingActor is heavy (reconciliation,
   private streams, swap recovery). A lighter executor may be appropriate.

2. **Agent-level vs per-instrument positions** — One venue account with multiple
   positions, or one venue account per instrument? Hyperliquid supports multiple
   positions on one account natively.

3. **Exit strategy** — The old repo relied on LLM for exit decisions (even in
   mechanical mode, exits were time/stop-loss based, not indicator-based). What
   indicator-based exit criteria should the Automation Agent use?

4. **Preset configs** — Should we ship named presets ("conservative momentum",
   "aggressive breakout") that users can select without understanding parameters?

---

## Implementation Phases

| Phase | Deliverable |
|---|---|
| 1 | Indicator suite: RSI, MACD, S/R, volume trend, CHOCH in `@herobids/market-data` |
| 2 | Scan engine: multi-candidate scoring in `@herobids/strategy` |
| 3 | Automation Agent runtime actor in `apps/worker/` |
| 4 | API integration + config validation |
| 5 | Paper-mode E2E test |
