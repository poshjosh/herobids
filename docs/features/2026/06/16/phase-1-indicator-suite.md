# Implementation Plan: Phase 1 — Indicator Suite

Adds RSI, MACD, support/resistance, volume trend, swing detection, and CHOCH to
`packages/market-data/src/indicators.ts`. Pure functions, zero I/O, easy to test.

**File:** `packages/market-data/src/indicators.ts`  
**Tests:** `packages/market-data/src/indicators.test.ts`  
**Exports:** `packages/market-data/src/index.ts`

---

## Existing Indicators (no changes needed)

- [x] `ema(candles, period)` → `number[]`
- [x] `adx(candles, period)` → `number` (last value)
- [x] `vwap(candles)` → `number`
- [x] `detectMarketStructure(candles)` → `'higherHighs' | 'lowerHighs' | 'mixed'`

---

## New Indicators to Add

### 1. RSI — Relative Strength Index

```typescript
/**
 * RSI using Wilder's smoothing method.
 * Returns array of RSI values aligned with input candles.
 * First `period` values are NaN (insufficient data).
 */
export function rsi(candles: PriceCandle[], period = 14): number[]
```

**Test cases:**
- [ ] Returns NaN array when data length < period + 1
- [ ] First valid RSI appears at index `period`
- [ ] All-rising closes → RSI approaches 100
- [ ] All-falling closes → RSI approaches 0
- [ ] Alternating closes → RSI near 50
- [ ] Period = 2 edge case
- [ ] Matches manual calculation for known sequence

### 2. MACD — Moving Average Convergence Divergence

```typescript
export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

/**
 * MACD with configurable fast/slow/signal periods.
 * Returns arrays aligned with input candles.
 */
export function macd(candles: PriceCandle[], fast = 12, slow = 26, signal = 9): MacdResult
```

**Test cases:**
- [ ] MACD line = fast EMA - slow EMA
- [ ] Signal line = EMA of MACD line
- [ ] Histogram = MACD line - signal line
- [ ] Bullish crossover detectable (histogram goes 0→positive)
- [ ] Bearish crossover detectable (histogram goes 0→negative)
- [ ] Returns arrays of same length as input
- [ ] Short input (< slow period) returns all-NaN/zero arrays

### 3. Support/Resistance Detection

```typescript
export interface SupportResistanceLevels {
  supports: number[];
  resistances: number[];
}

/**
 * Find support and resistance levels using pivot points.
 * Looks for local highs/lows within the lookback window.
 */
export function findSupportResistance(candles: PriceCandle[], lookback = 50): SupportResistanceLevels

/**
 * Check if price is breaking above the nearest resistance level.
 * Returns true if price is above a resistance and within `threshold` %
 * (i.e. just broke through, not already far above).
 */
export function isBreakingResistance(currentPrice: number, resistances: number[], threshold = 0.005): boolean
```

**Test cases:**
- [ ] Detects local high as resistance
- [ ] Detects local low as support
- [ ] `isBreakingResistance` true when price just above level
- [ ] `isBreakingResistance` false when price far above level
- [ ] Empty candles → empty arrays
- [ ] Lookback = 5 (small window) still works

### 4. Volume Trend

```typescript
/**
 * Volume trend ratio: average volume of recent N bars / average of last M bars.
 * >1 means increasing volume, <1 means decreasing.
 */
export function volumeTrend(candles: PriceCandle[], recentBars = 4, avgBars = 20): number
```

**Test cases:**
- [ ] Returns 0 if candles.length < avgBars
- [ ] Double-volume recent bars → returns ~2.0
- [ ] Same volume throughout → returns ~1.0
- [ ] Zero volume candles → returns 0 (no division by zero)

### 5. Swing Point Detection

```typescript
export interface SwingPoint {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * Detect swing highs and lows with configurable lookback and prominence filter.
 * Same-type adjacent points are deduplicated (keeps later occurrence).
 */
export function detectSwingPoints(
  candles: PriceCandle[],
  swingLookback = 3,
  minSwingPct = 0,
): SwingPoint[]
```

**Test cases:**
- [ ] Detects obvious swing high (peak in the middle)
- [ ] Detects obvious swing low (trough in the middle)
- [ ] `minSwingPct` filters out insignificant swings
- [ ] Adjacent same-type points deduplicated
- [ ] Returns empty for insufficient data (< 2*lookback + 1)
- [ ] `swingLookback = 1` detects more points than `swingLookback = 5`

### 6. Market Structure Classification (from swing points)

```typescript
export type MarketStructureFromSwings = 'bullish' | 'bearish' | 'indeterminate';

/**
 * Classify market structure from detected swing points.
 * bullish = higher highs + higher lows
 * bearish = lower highs + lower lows
 */
export function classifyStructure(swingPoints: SwingPoint[]): MarketStructureFromSwings
```

**Test cases:**
- [ ] HH + HL → 'bullish'
- [ ] LH + LL → 'bearish'
- [ ] HH + LL → 'indeterminate'
- [ ] Fewer than 2 highs or 2 lows → 'indeterminate'

### 7. CHOCH — Change of Character

```typescript
export interface ChochSignal {
  type: 'bullish' | 'bearish';
  breakIndex: number;
  breakPrice: number;
  brokenLevel: number;
}

/**
 * Detect structural break (CHOCH).
 * Bullish CHOCH: bearish structure + price closes above last swing high.
 * Bearish CHOCH: bullish structure + price closes below last swing low.
 * `confirmBars` limits freshness — only breaks within last N bars count.
 */
export function detectCHOCH(
  candles: PriceCandle[],
  swingPoints: SwingPoint[],
  structure: MarketStructureFromSwings,
  confirmBars = 5,
): ChochSignal | null
```

**Test cases:**
- [ ] Returns null for 'indeterminate' structure
- [ ] Bearish structure + close above swing high → bullish CHOCH
- [ ] Bullish structure + close below swing low → bearish CHOCH
- [ ] Stale break (outside confirmBars) → null
- [ ] No break at all → null

---

## Export Updates

Add to `packages/market-data/src/index.ts`:

```typescript
export {
  ema, adx, vwap, detectMarketStructure,  // existing
  rsi, macd, type MacdResult,
  findSupportResistance, isBreakingResistance, type SupportResistanceLevels,
  volumeTrend,
  detectSwingPoints, classifyStructure, detectCHOCH,
  type SwingPoint, type MarketStructureFromSwings, type ChochSignal,
} from './indicators.js';
```

---

## Definition of Done

- [ ] All 7 new functions implemented as pure functions (no I/O)
- [ ] All test cases above pass
- [ ] `pnpm lint` passes
- [ ] `pnpm test --filter @herobids/market-data` passes
- [ ] Exported from package index
- [ ] No new dependencies added
