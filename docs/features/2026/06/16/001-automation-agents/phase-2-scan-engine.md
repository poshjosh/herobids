# Implementation Plan: Phase 2 — Scan Engine

Multi-candidate scoring module that evaluates N instruments through the indicator
pipeline and returns ranked signals. This is the "brain" that powers the technical
phase of the unified agent.

**Package:** `packages/strategy/src/scan-engine.ts`  
**Tests:** `packages/strategy/src/scan-engine.test.ts`  
**Depends on:** Phase 1 (indicator suite in `@herobids/market-data`)

---

## Design

### Core Abstraction

```typescript
/** Input: one candidate with pre-fetched candle data */
export interface CandidateContext {
  symbol: string;
  instrumentId: string;
  candles: PriceCandle[];
  /** Optional metadata from discovery (volume, liquidity, price change) */
  meta?: {
    volume24hUsd?: number;
    liquidityUsd?: number;
    priceChange24hPct?: number;
  };
}

/** Output: scored signal for one instrument */
export interface ScoredSignal {
  symbol: string;
  instrumentId: string;
  confidence: number;          // 0–1 aggregated score
  reasons: string[];           // Human-readable signal explanations
  intent: 'go_long' | 'go_short'; // Direction
  indicators: {
    rsi?: number;
    macdHistogram?: number;
    volumeRatio?: number;
    breakingResistance?: boolean;
    choch?: 'bullish' | 'bearish' | null;
  };
}

/** Configuration for the scan engine (subset of agent technical config) */
export interface ScanConfig {
  indicators: IndicatorConfig;  // RSI, MACD, volume, CHOCH, S/R params
  signalBias: 'trend-following' | 'mean-reverting';
  maxResults?: number;          // Cap on returned signals (default: no limit)
}
```

### Core Function

```typescript
/**
 * Score a single candidate using configured indicators.
 * Pure function — no I/O. Takes pre-fetched candles.
 * Returns a signal if confidence passes thresholds, null otherwise.
 */
export function scoreCandidate(
  candidate: CandidateContext,
  config: ScanConfig,
): ScoredSignal | null

/**
 * Score N candidates, filter by confidence thresholds, rank by score.
 * Pure function — all data pre-fetched.
 */
export function scanCandidates(
  candidates: CandidateContext[],
  config: ScanConfig,
): ScoredSignal[]
```

---

## Scoring Logic (per candidate)

```
For each enabled indicator:
  1. Compute indicator value from candles
  2. Evaluate against thresholds (hard reject or confidence contribution)
  3. Apply signal bias (trend-following vs mean-reverting interpretation)

Aggregation:
  - Sum weighted contributions from passing indicators
  - Hard reject if any rejection trigger fires (RSI overbought, MACD negative, weak volume)
  - Pass only if confidence >= minConfidence AND reasons.length >= minReasons

Ranking:
  - Sort passing signals by confidence descending
  - Cap at maxResults if specified
```

### Signal Bias Behavior

| Indicator | Trend-Following | Mean-Reverting |
|---|---|---|
| RSI | Healthy range (40–70) = bullish | Oversold (<30) = buying opportunity |
| RSI overbought | Hard reject | Hard reject |
| CHOCH bullish | Entry signal (structure breaking up) | Confidence penalty |
| CHOCH bearish | Hard reject (if configured) | Entry signal (capitulation reversal) |
| MACD | Positive + increasing = bullish | Same (no bias difference) |
| Volume | Strong ratio = confirmation | Same |
| S/R breakout | Breaking resistance = entry | Breaking support = entry (bounce) |

---

## Checklist

### Implementation

- [ ] Define `CandidateContext`, `ScoredSignal`, `ScanConfig` types
- [ ] Implement `scoreCandidate()` — single candidate evaluation
- [ ] Implement RSI check with bias-aware interpretation
- [ ] Implement MACD check (crossover detection + increasing histogram)
- [ ] Implement volume trend check (strong/weak ratio gates)
- [ ] Implement support/resistance breakout check
- [ ] Implement CHOCH check with bias-aware interpretation
- [ ] Implement confidence aggregation (weighted sum + thresholds)
- [ ] Implement `scanCandidates()` — batch scoring + rank + cap
- [ ] Export from `packages/strategy/src/index.ts`

### Tests

- [ ] `scoreCandidate` returns null when confidence below threshold
- [ ] `scoreCandidate` returns null on hard rejection (RSI overbought)
- [ ] `scoreCandidate` returns signal when all indicators pass
- [ ] Confidence weights applied correctly (manual calculation check)
- [ ] Signal bias flips RSI interpretation
- [ ] Signal bias flips CHOCH interpretation
- [ ] `scanCandidates` ranks by confidence descending
- [ ] `scanCandidates` respects `maxResults` cap
- [ ] Empty candidates → empty results
- [ ] Candidate with insufficient candle data → null (not crash)

### Integration

- [ ] `@herobids/strategy` package depends on `@herobids/market-data` (already true)
- [ ] New exports added to strategy package index
- [ ] `pnpm lint` passes
- [ ] `pnpm test --filter @herobids/strategy` passes

---

## Definition of Done

- [ ] Pure functions — no I/O, no network calls, no config fetching
- [ ] Candle fetching is caller's responsibility (injected data)
- [ ] All test cases pass
- [ ] Types exported for use by Phase 3 (agent runtime)
