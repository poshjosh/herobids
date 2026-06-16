# Implementation Plan: Phase 3 — Agent Technical Runtime

Adds the technical phase to the agent runtime: discovery → candle fetch → scan
engine → decision submission. When an agent has `technical` config, this phase
runs on a scan interval and produces decisions without LLM involvement.

**Files:**
- `apps/worker/src/technical-phase.ts` — orchestrates the technical scan loop
- `apps/worker/src/agent-trading-actor.ts` — modified to include technical phase
- `packages/domain/src/config/schema.ts` — `TechnicalConfigSchema` + validation

**Depends on:** Phase 1 (indicators), Phase 2 (scan engine), Phase 4 (executor)

---

## Design

### Where It Lives

The technical phase is a module called by the existing `AgentTradingActor` when
`config.technical` is present. It does NOT create a new actor class.

```
AgentTradingActor
  ├── Intelligence phase (existing — LLM wake cycle)
  ├── Technical phase (NEW — indicator scan cycle)
  └── Execution layer (shared)
```

### Technical Phase Flow

```typescript
export interface TechnicalPhaseDeps {
  config: TechnicalConfig;
  riskConfig: RiskConfig;
  discoverCandidates: (filters: FilterConfig) => Promise<DiscoveredInstrument[]>;
  fetchCandles: (symbol: string, interval: string, limit: number) => Promise<PriceCandle[]>;
  evaluateRegime: (params: RegimeParams) => Promise<RegimeResult>;
  submitDecision: (decision: Decision) => Promise<void>;
  getOpenPositions: () => PositionState[];
  logger: Logger;
}

export async function runTechnicalPhase(deps: TechnicalPhaseDeps): Promise<TechnicalPhaseResult>
```

### Loop Behavior

```
1. Discover candidates
   - Call discovery pipeline with filters (venue, minVolume, minLiquidity)
   - Result: list of instruments matching criteria

2. Regime gate (if regime config present)
   - evaluateRegime(config.regime)
   - If fail → skip new entries, still manage exits

3. Fetch candles (batched)
   - For each candidate, fetch candles at configured interval/limit
   - Batch by scanBatchSize to respect rate limits
   - Skip candidates where fetch fails (warn, continue)

4. Score candidates
   - scanCandidates(candidates, config) → ranked signals
   - Filter: only signals not already in open positions (no double-entry)

5. Position management
   - For each open position NOT in top signals:
     Run indicators on its candles, check exit conditions
     (confidence dropped, RSI overbought, stop-loss hit)

6. Submit decisions
   - New entries: top N signals within maxPositions budget
   - Exits: positions that fail exit evaluation
   - Each decision goes through existing execution layer

7. Return phase result (for logging/metrics)
```

---

## Checklist

### Config Schema (domain)

- [ ] Define `TechnicalConfigSchema` in `packages/domain/src/config/schema.ts`
- [ ] Define `IndicatorConfigSchema` (nested in technical)
- [ ] Add `technical` optional field to agent config validation
- [ ] Add `UnifiedAgentConfigSchema` with `technical | intelligence` refinement
- [ ] Export types: `TechnicalConfig`, `IndicatorConfig`

### Technical Phase Module (worker)

- [ ] Create `apps/worker/src/technical-phase.ts`
- [ ] Implement discovery step (delegates to existing market-data discovery)
- [ ] Implement regime gate step (delegates to existing `evaluateRegime`)
- [ ] Implement batched candle fetching with error tolerance
- [ ] Implement scan engine invocation
- [ ] Implement position exit evaluation
- [ ] Implement decision submission (respecting maxPositions budget)
- [ ] Implement `TechnicalPhaseResult` for observability

### Integration with AgentTradingActor

- [ ] Add scan interval timer when `config.technical` present
- [ ] Call `runTechnicalPhase()` on each tick
- [ ] Coexist with intelligence phase (when both present):
  - Technical produces signals
  - Intelligence reads latest signals as context enrichment (Phase 5)
- [ ] Graceful stop: clear scan timer on agent stop

### Position Tracking

- [ ] Agent-scoped position map: `Map<instrumentId, PositionState>`
- [ ] Updated on fills from execution layer
- [ ] Consulted by scan (don't double-enter) and exits (manage open)

### Tests

- [ ] Technical phase runs and produces decisions from synthetic candles
- [ ] Regime gate blocks new entries when choppy
- [ ] Respects maxPositions limit
- [ ] Skips instruments already in open positions
- [ ] Exit evaluation triggers go_flat for degraded positions
- [ ] Candle fetch failure doesn't crash the phase (skips candidate)
- [ ] Scan batch size respected (no more than N concurrent fetches)
- [ ] Phase result contains scan metrics (candidates, signals, entries, exits)

---

## Discovery Integration

The technical phase needs to discover instruments. Existing infrastructure:

| Venue | Discovery Source |
|---|---|
| Hyperliquid | `fetchHyperliquidAssetContexts()` → all perps with volume/OI |
| Jupiter (swap) | `discoverTokens()` → DexScreener + GeckoTerminal pipeline |

The `discoverCandidates` dependency is injected — the wiring in `index.ts`
connects it to the appropriate discovery function based on `filters.venue`.

---

## Exit Strategy (Technical-Only Agents)

When no `intelligence` is configured, the agent needs rule-based exit logic:

| Condition | Action |
|---|---|
| RSI > overbought threshold | Exit (go_flat) |
| Confidence re-scored below minConfidence | Exit |
| Stop-loss hit (unrealized loss > stopLossPct) | Exit |
| Take-profit hit (unrealized gain > takeProfitPct) | Exit |
| Indicators turn bearish (MACD negative + volume weak) | Exit |

When `intelligence` IS configured, exits are delegated to the LLM (it sees
position + indicator data and decides).

---

## Definition of Done

- [ ] Agent with only `technical` config starts, discovers, scans, and paper-trades
- [ ] Agent with both `technical` + `intelligence` runs technical phase and produces
      signals (intelligence consumption is Phase 5)
- [ ] No LLM calls made when only `technical` configured
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] E2E: create agent via API with technical config → starts → produces fills in paper mode
