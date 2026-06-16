# Plan: Rich Strategy-Stack Parity

Port the mechanical and hybrid strategy engines from the old repo.
Gives bots single-instrument deep technical analysis (RSI, MACD, volume, CHOCH,
S/R, regime, sentiment) without requiring an LLM.

**Prior art:** `000-contemplations.md` — all architectural decisions are resolved
there. This plan translates those decisions into an ordered implementation checklist.

**Dependency note:** Indicators (RSI, MACD, S/R, CHOCH, volume trend) were already
implemented as part of `001-automation-agents` (Phase 1). They live in
`packages/market-data/src/indicators.ts` and are fully tested.

---

## Phase 0 — Extract shared indicator sub-schemas

**File:** `packages/domain/src/config/schema.ts`

`IndicatorConfigSchema` currently has RSI, MACD, volume, CHOCH, S/R, and confidence
weights defined as inline anonymous object literals. `MechanicalParamsSchema`
(Phase 3 below) needs the same sub-schemas. Extract them as named, exported
schemas now so both can reference the same definitions — no duplication.

### Schemas to extract

```typescript
// Before (inline, anonymous):
export const IndicatorConfigSchema = z.object({
  rsi: z.object({ enabled: z.boolean().default(true), period: ... }).default({}),
  ...
});

// After (named, recomposed):
export const RsiParamsSchema = z.object({ enabled: ..., period: ..., ... }).default({});
export const MacdParamsSchema = z.object({ enabled: ..., fast: ..., ... }).default({});
export const VolumeParamsSchema = z.object({ enabled: ..., strongRatio: ..., ... }).default({});
export const ChochParamsSchema = z.object({ enabled: ..., swingLookback: ..., ... }).default({});
export const SupportResistanceParamsSchema = z.object({ enabled: ..., lookback: ..., ... }).default({});
export const ConfidenceWeightsSchema = z.object({ rsiWeight: ..., minConfidence: ..., ... }).default({});

export const IndicatorConfigSchema = z.object({
  rsi: RsiParamsSchema,
  macd: MacdParamsSchema,
  volume: VolumeParamsSchema,
  choch: ChochParamsSchema,
  supportResistance: SupportResistanceParamsSchema,
  confidence: ConfidenceWeightsSchema,
});

// Inferred types
export type RsiParams = z.infer<typeof RsiParamsSchema>;
export type MacdParams = z.infer<typeof MacdParamsSchema>;
export type VolumeParams = z.infer<typeof VolumeParamsSchema>;
export type ChochParams = z.infer<typeof ChochParamsSchema>;
export type SupportResistanceParams = z.infer<typeof SupportResistanceParamsSchema>;
export type ConfidenceWeights = z.infer<typeof ConfidenceWeightsSchema>;
```

`TechnicalConfigSchema` (agents) and `MechanicalParamsSchema` (bots) both use
`IndicatorConfigSchema` — no duplication at any level.

This is a pure refactor: runtime behavior is identical, only the schema
authoring structure changes. No migration needed.

### Checklist

- [ ] Extract six named sub-schemas (preserve all `.default({})` wrappers)
- [ ] Recompose `IndicatorConfigSchema` from the named sub-schemas
- [ ] Export the six named schemas and their inferred types
- [ ] Export from `packages/domain/src/index.ts`
- [ ] Confirm `pnpm lint` passes — no type regressions

---

## Phase 1 — Sentiment port (domain)

**Resolved by:** Decision 4 in `000-contemplations.md`

**File:** `packages/domain/src/ports/sentiment.ts` (new)

Define the interface only. No implementation required to unblock `MechanicalStrategy`.
Strategies that don't have a `SentimentProvider` injected simply skip sentiment checks.

```typescript
export interface SentimentResult {
  symbol: string;
  score: number;        // -1 (very bearish) to +1 (very bullish)
  confidence: number;   // 0–1
  source: string;
  fetchedAt: number;    // unix ms
}

export interface SentimentProvider {
  getScore(symbol: string, tokenName?: string): Promise<SentimentResult | null>;
}
```

No concrete Twitter adapter yet — that is a follow-up. The circuit-breaker pattern
from the old repo (auto-disable after 3× 429/402) should be implemented when the
concrete adapter is built, not in the port.

### Checklist

- [ ] Create `packages/domain/src/ports/sentiment.ts`
- [ ] Export from `packages/domain/src/index.ts`

---

## Phase 2 — `MechanicalParamsSchema` (config schema)

**Resolved by:** Decisions 3, 5, 8, 9, 10 in `000-contemplations.md`

**File:** `packages/domain/src/config/schema.ts`

```typescript
export const MechanicalParamsSchema = z.object({
  // Candle fetching
  candleInterval: z.enum(['5m', '15m', '1H', '4H', '1D']).default('15m'),
  candleLimit: z.number().int().min(20).max(500).default(100),

  // Indicator suite — reuses named sub-schemas from Phase 0
  indicators: IndicatorConfigSchema.default({}),

  // Signal interpretation
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),

  // Sentiment (optional — skipped when not configured)
  sentiment: z.object({
    enabled: z.boolean().default(false),
  }).default({}),

  // Position sizing — same pattern as existing MomentumStrategy
  positionSize: z.string().min(1),  // decimal string, e.g. "100"
  positionSizeMode: z.enum(['fixed', 'percent_equity']).default('fixed'),
});

export const HybridParamsSchema = z.object({
  mechanical: MechanicalParamsSchema,
  // LLM config reuses the same fields as existing LLM strategies
  provider: z.string().optional(),
  lightModel: z.string().optional(),
  heavyModel: z.string().optional(),
});
```

Also extend `StrategyConfigSchema` discriminated union:

```typescript
// Existing: 'momentum' | 'llm'
// After:    'momentum' | 'llm' | 'mechanical' | 'hybrid'
```

**Playbook rules** (Decision 5): extend `RiskConfigSchema` with:
- `maxNewPositionsPerDay: z.number().int().min(0).optional()`
- `avoidParabolicMovePct: z.number().min(0).optional()` — exit or skip if price
  moved ≥ N% in 1 candle

### Checklist

- [x] Add `MechanicalParamsSchema` and `HybridParamsSchema` to `schema.ts`
- [x] Add `MechanicalParams` and `HybridParams` inferred types
- [x] Extend `StrategyConfigSchema` with 'mechanical' and 'hybrid' variants
- [x] Extend `RiskConfigSchema` with `maxNewPositionsPerDay` and `avoidParabolicMovePct`
- [x] Export all new schemas and types from `packages/domain/src/index.ts`
- [ ] `pnpm lint` passes

---

## Phase 3 — `CandleFetcher` port and wiring

**Resolved by:** Decision 2 in `000-contemplations.md` (Option B — injected port)

**Open question resolved:** `packages/market-data` has `fetchBinanceCandles` and
`fetchGeckoTerminalCandles`. A unified `CandleFetcher` port wraps venue-specific
implementations.

**File:** `packages/domain/src/ports/candle-fetcher.ts` (new)

```typescript
export interface CandleFetcher {
  fetchCandles(
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<PriceCandle[]>;
}
```

**Wiring:**

`TradingActor` is constructed in `apps/worker/src/worker.ts` (or the relevant
composition root). Inject a `CandleFetcher` alongside existing deps. The concrete
implementation selects the right underlying fetcher based on the venue type of
the instrument.

### Checklist

- [ ] Create `packages/domain/src/ports/candle-fetcher.ts`
- [ ] Export from `packages/domain/src/index.ts`
- [ ] Create a concrete `VenueCandleFetcher` adapter in `packages/venues/src/`
  that routes by venue type (Hyperliquid → Binance candles, Jupiter → GeckoTerminal)
- [ ] Inject `CandleFetcher` into `TradingActor` constructor
- [ ] Pass `candleFetcher` through `TradingActorDeps`

---

## Phase 4 — `MechanicalStrategy`

**File:** `packages/strategy/src/mechanical-strategy.ts` (new)

Single-instrument deep analyzer. Stateless (Decision 9). Reuses existing indicator
functions from `packages/market-data/src/indicators.ts`.

```typescript
export class MechanicalStrategy implements Strategy {
  constructor(
    private readonly candleFetcher: CandleFetcher,
    private readonly sentimentProvider: SentimentProvider | null,
  ) {}

  async evaluate(snapshot: MarketSnapshot, config: StrategyConfig): Promise<Decision | null> { ... }
}
```

**Logic flow (per tick):**
1. Parse `config` as `MechanicalParamsSchema`
2. Fetch candles via `candleFetcher`
3. Compute RSI, MACD, volume, CHOCH, S/R (reuse `scoreCandidate` from scan engine
   or call indicator functions directly — **do not duplicate**)
4. Check sentiment if provider present
5. Aggregate confidence (reuse `scanCandidates` / `scoreCandidate` logic)
6. If confidence ≥ `minConfidence` and reasons ≥ `minReasons` → return `go_long` Decision
7. If open position and confidence below exit threshold → return `go_flat`
8. Otherwise return `null` (hold)

**Note on reuse:** `scoreCandidate()` in `packages/strategy/src/scan-engine.ts`
already does steps 3–5. `MechanicalStrategy` should call it (passing a synthetic
`CandidateContext`) rather than reimplementing the scoring logic. If the signature
doesn't fit cleanly, extract the scoring core into a shared function both can call.

**Playbook checks** (from `RiskConfigSchema`):
- `avoidParabolicMovePct`: check last candle's move % — skip entry if exceeded
- `maxNewPositionsPerDay`: check position counter from the actor's state

### Checklist

- [x] Create `mechanical-strategy.ts`
- [x] Reuse `scoreCandidate()` — do not reimplement indicator scoring
- [x] Implement playbook checks (`avoidParabolicMovePct`, `maxNewPositionsPerDay`)
- [x] Export from `packages/strategy/src/index.ts`
- [x] Unit tests: returns `go_long` when all signals align; returns `null` when
  RSI overbought; returns `go_flat` below exit threshold
- [x] `pnpm lint` passes

---

## Phase 5 — `HybridStrategy`

**File:** `packages/strategy/src/hybrid-strategy.ts` (new)

Composes `MechanicalStrategy` (pre-check) + `LlmStrategy` (final judgment).
If mechanicals fail → return `null` immediately, no LLM call.

```typescript
export class HybridStrategy implements Strategy {
  constructor(
    private readonly mechanical: MechanicalStrategy,
    private readonly llm: LlmStrategy,
  ) {}

  async evaluate(snapshot: MarketSnapshot, config: StrategyConfig): Promise<Decision | null> {
    const mechanicalResult = await this.mechanical.evaluate(snapshot, config);
    if (mechanicalResult === null) return null;  // technicals failed — skip LLM
    // Pass mechanical indicators as enriched context to LLM
    return this.llm.evaluate(snapshot, config);
  }
}
```

The mechanical indicator data should be injected into the LLM context block
(same pattern as `runtime-composition.ts` technical scan enrichment for agents).

### Checklist

- [ ] Create `hybrid-strategy.ts`
- [ ] Compose `MechanicalStrategy` + `LlmStrategy`
- [ ] Inject mechanical indicator summary into LLM context
- [ ] Export from `packages/strategy/src/index.ts`
- [ ] Unit tests: LLM is NOT called when mechanicals return null; LLM IS called
  when mechanicals pass
- [ ] `pnpm lint` passes

---

## Phase 6 — Factory and wiring

**File:** `packages/strategy/src/index.ts` (update `createStrategy`)
**File:** `apps/worker/src/worker.ts` or composition root (inject `CandleFetcher`)

Update `createStrategy()` to handle `'mechanical'` and `'hybrid'` config types,
constructing the appropriate strategy class with injected deps.

### Checklist

- [ ] Add `'mechanical'` and `'hybrid'` cases to `createStrategy()`
- [ ] Wire `CandleFetcher` into the bot `TradingActor` in the composition root
- [ ] Wire optional `SentimentProvider` (null by default until concrete adapter exists)
- [ ] Integration test: bot with `strategy.type = 'mechanical'` config exercises
  the full path from tick → candle fetch → indicator scoring → decision

---

## Phase 7 — UI (bot create/edit form)

**Deferred to a separate feature spec.** The mechanical strategy config
(`MechanicalParamsSchema`) shares its indicator sub-schemas with the agent
`TechnicalConfigSchema` (same `IndicatorConfigSchema` from Phase 0). The bot
form's indicator preset components can be extracted from or shared with the
agent form components built in
`docs/features/2026/06/16/002-unified-agent-create-ui/001-plan.md`.

This extraction should be planned when the bot UI spec is written.

---

## Definition of Done

- [x] `RsiParamsSchema`, `MacdParamsSchema`, etc. extracted and exported from `schema.ts`
- [x] `IndicatorConfigSchema` and `TechnicalConfigSchema` behavior unchanged
- [x] `MechanicalStrategy` and `HybridStrategy` implemented and tested
- [x] `CandleFetcher` port defined and wired into `TradingActor`
- [x] `createStrategy()` handles 'mechanical' and 'hybrid'
- [x] `pnpm lint` passes
- [x] `pnpm test` passes
- [ ] Bot can be configured with `strategy.type = 'mechanical'` and execute trades (integration test — deferred)

---

## Outstanding Issues

### [Phase 3 — CandleFetcher]
- **LOW**: `TradingActorDeps.candleFetcher` is technically redundant — the strategy already captures the fetcher at construction time and the actor never reads `deps.candleFetcher` directly. The field is inert state. Consider removing it or adding a comment clarifying it is reserved for future actor-level use.
- **LOW**: `mapIntervalToTimeframe` in `VenueCandleFetcher` coarsens granularity for GeckoTerminal (e.g. `'4H'` → `'hour'`) with a warning log only. Strategies using `candleInterval: '4H'` against Jupiter tokens will receive 1-hour candles.

### [Phase 4 — MechanicalStrategy]
- **MEDIUM**: ~~`avoidParabolicMovePct` and `maxNewPositionsPerDay` are injected via `snapshot.data` — if the TradingActor never populates them, these checks silently pass. The TradingActor snapshot builder should be audited to confirm both fields are populated from `RiskConfigSchema` before calling `strategy.evaluate()`.~~ **RESOLVED (2026-06-16):** Added typed `RiskPlaybookSchema` and `snapshot.playbook` field to `MarketSnapshot`. The playbook values are now carried through a typed property rather than an untyped string-key lookup in `snapshot.data`. The `TradingActor.tick()` populates `snapshot.playbook`, `MechanicalStrategy` reads from it, and the backtesting `runBacktest` passes `riskPlaybook` through `BacktestConfig`. A debug hook on `MechanicalStrategy` detects when `playbook` is absent on a live-looking snapshot. No more silent-skip risk from key renames.

### [Phase 5 — HybridStrategy]
- **LOW**: `MechanicalStrategy` generates a `decisionId` in the hybrid pre-check pass that is silently discarded when the LLM makes the final decision. The mechanical ID is never persisted or logged — consider surfacing it in hybrid decision metadata for traceability.
- **LOW**: Mechanical metadata keys (`confidence`, `reasons`, `indicators`) injected into the LLM snapshot are accessed via string index on `Record<string, unknown>`. If `MechanicalStrategy` renames these keys, `HybridStrategy` will inject `undefined` silently with no type error.

### [Phase 6 — Factory/Wiring]
- **LOW**: Startup guard error messages reference the internal type name `CandleFetcher`. Should reference the operator config key (`appConfig.marketData`) for better operator diagnostics.
- **LOW**: `createStrategy()` has no exhaustiveness `default` branch. Adding `const _never: never = strategyConfig` as the default would catch future unhandled union variants at compile time.

### [Integration test — deferred]
- Integration test: bot with `strategy.type = 'mechanical'` config exercises the full path from tick → candle fetch → indicator scoring → decision. This is the remaining unmet Definition of Done item.
