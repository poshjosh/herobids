# Tool Parameter Hardening & Candle Provider Registry

## Problem

Agent tool invocations fail silently due to:
1. No `.describe()` on parameters — LLM guesses formats (e.g. `"BTC/USD"` instead of `"BTC"`)
2. `z.string().min(1).optional()` rejects `""` instead of treating it as absent
3. `botId` in `get_analytics`/`list_positions` is redundant — already scoped by `ctx.agentId`
4. `check_regime` description doesn't tell the agent the expected symbol format
5. Agents don't know their trading venue/provider from the prompt
6. Adding a new candle provider (e.g. Bybit) risks drift — forgetting resolveSymbol or description updates

## Changes

### 1. Add `.describe()` to all tool parameters

**Files:** All tool files in `apps/worker/src/tools/`

Add `.describe()` to every parameter in every tool schema. Use concise, unambiguous text that tells the LLM exactly what to pass.

Priority parameters (caused live failures):

| Tool | Parameter | Description |
|------|-----------|-------------|
| `submit_decision` | `instrumentId` | `"The base ticker of the instrument to trade (e.g. 'BTC', 'SOL', 'ETH')"` |
| `submit_decision` | `intent` | `"Trading intent: go_long, go_short, go_flat (close), increase, or decrease position"` |
| `submit_decision` | `targetSize` | `"Target position size as a decimal string (e.g. '0.5', '100'). Represents absolute notional or quantity depending on venue."` |
| `submit_decision` | `limitPrice` | `"Optional limit price as a decimal string. If omitted, executes at market."` |
| `submit_decision` | `rationaleSummary` | `"Brief explanation of why this trade is being taken. Used for audit trail."` |
| `submit_decision` | `confidence` | `"Confidence level 0-1. Optional, used for position sizing hints."` |
| `submit_decision` | `safetyOverrideId` | `"One-time code to override a previous safety rejection. Only use the exact code provided in a prior rejection response."` |
| `check_regime` | `benchmarkSymbol` | `"Base ticker for regime evaluation (e.g. 'BTC', 'SOL'). Defaults to 'BTC'."` |

All other parameters across all tools must also receive descriptions. Use `price.ts` and `watch.ts` as reference — they already follow this pattern.

### 2. Empty string → undefined at boundary

**Files:** `apps/worker/src/tools/trading.ts`, `apps/worker/src/tools/bots.ts`, `apps/worker/src/tools/market-data.ts`

For optional string parameters where `""` is semantically equivalent to "not provided", add a Zod transform:

```typescript
safetyOverrideId: z.string().optional().transform(v => v === '' ? undefined : v),
```

**Affected parameters:**
- `submit_decision.safetyOverrideId`
- `submit_decision.limitPrice`
- `check_regime.benchmarkSymbol`
- `create_bot.venueAccountId`

**DO NOT** apply this to parameters where any non-empty string has meaning (i.e., never coerce `"None"`, `"null"`, or other string literals to undefined — those are genuinely invalid inputs that should fail validation).

### 3. Remove `botId` from `get_analytics` and `list_positions`

**File:** `apps/worker/src/tools/analytics.ts`

- Remove `botId` from `GetAnalyticsParamsSchema` and `ListPositionsParamsSchema`
- Both tools already call `ctx.botRepo.getAnalyticsByCreator('agent', ctx.agentId, ...)` and `ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId, ...)` — the caller's identity is the scope
- Update tool descriptions to clarify they return data for all bots created by this agent
- Update the `execute` function to remove the `botId` argument from repo calls

### 4. Candle provider registry (drift mitigation)

**File (new):** `packages/market-data/src/candle-registry.ts`

Create a typed candle provider registry that makes the compiler enforce completeness:

```typescript
export type CandleProviderKey = 'binance'; // extend union when adding providers

export interface CandleProviderDescriptor {
  /** Provider identifier */
  id: CandleProviderKey;
  /** Normalize an agent-supplied symbol to provider-native format */
  resolveSymbol: (input: string) => string;
  /** Human-readable format hint for tool descriptions */
  symbolFormatHint: string;
  /** Fetch candles for a resolved symbol */
  fetchCandles: (symbol: string, config: unknown, options?: { interval?: string; limit?: number }) => Promise<import('./types.js').PriceCandle[]>;
}

export const CANDLE_PROVIDERS: Record<CandleProviderKey, CandleProviderDescriptor> = {
  binance: {
    id: 'binance',
    resolveSymbol: resolveBinanceSymbol,
    symbolFormatHint: "Base ticker (e.g. 'BTC', 'SOL')",
    fetchCandles: (symbol, config, options) => fetchBinanceCandles(symbol, config as BinanceCandlesConfig, options),
  },
};
```

**Why this prevents drift:**
- Adding a key to `CandleProviderKey` without adding the entry → TypeScript error
- Each entry enforces `resolveSymbol` + `symbolFormatHint` + `fetchCandles` — no partial registrations
- `check_regime` derives its description from `CANDLE_PROVIDERS[activeProvider].symbolFormatHint`

**File (update):** `packages/market-data/src/binance-candles.ts`

Update `resolveBinanceSymbol` to handle common LLM-generated formats:

```typescript
export function resolveBinanceSymbol(instrument: string): string {
  // Strip common suffixes/separators: "BTC/USD" → "BTC", "BTC-PERP" → "BTC", "BTCUSDT" → "BTC"
  const cleaned = instrument.split(/[/\-]/)[0]!.toUpperCase();
  const base = cleaned.replace(/USDT$|USD$|PERP$/i, '') || cleaned;
  return SYMBOL_MAP[base] ?? `${base}USDT`;
}
```

**File (new test):** `packages/market-data/src/candle-registry.test.ts`

Test that every registered provider's `resolveSymbol` handles common formats:

```typescript
for (const [key, provider] of Object.entries(CANDLE_PROVIDERS)) {
  describe(`${key}.resolveSymbol`, () => {
    it('handles bare ticker', () => { expect(provider.resolveSymbol('BTC')).toBe('BTCUSDT'); });
    it('handles lowercase', () => { expect(provider.resolveSymbol('btc')).toBe('BTCUSDT'); });
    it('handles slash pair', () => { expect(provider.resolveSymbol('BTC/USD')).toBe('BTCUSDT'); });
    it('handles dash-perp', () => { expect(provider.resolveSymbol('BTC-PERP')).toBe('BTCUSDT'); });
  });
}
```

### 5. Update `check_regime` to use registry

**File:** `apps/worker/src/tools/market-data.ts`

- Import `CANDLE_PROVIDERS` from the registry
- Derive `benchmarkSymbol` description from `CANDLE_PROVIDERS.binance.symbolFormatHint`
- Use `provider.resolveSymbol(symbol)` before calling `fetchCandles`

The description becomes dynamic:
```typescript
benchmarkSymbol: z.string().optional()
  .describe(`Base ticker for regime evaluation. Format: ${CANDLE_PROVIDERS.binance.symbolFormatHint}. Defaults to 'BTC'.`)
  .transform(v => v === '' ? undefined : v),
```

### 6. Add trading venue info to agent prompts

**File:** `apps/worker/src/runtime-composition.ts`

Add a new static context provider (or extend `core-platform`) that renders trading venue details:

```typescript
{
  id: 'trading-venue',
  costTier: 'free',
  section: 'static',
  requiredFamilies: ['trading'],
  trimOrder: 0,
  preserveWhenTrimmed: true,
  build: (state) => {
    const bindings = state.runtimeDescriptor.grantedBindingsByFamily['trading'] ?? [];
    if (bindings.length === 0) return null;

    const lines = bindings.map(b => {
      const type = PROVIDER_VENUE_TYPE[b.provider] ?? 'unknown';
      return `- ${b.provider} (${type})`;
    });

    return {
      id: 'tradingVenue',
      title: 'Trading Venue',
      provider: 'trading-venue',
      content: [
        ...lines,
        `Symbol format: base ticker (e.g. "BTC", "SOL", "ETH")`,
      ].join('\n'),
    };
  },
}
```

Where `PROVIDER_VENUE_TYPE` is:
```typescript
const PROVIDER_VENUE_TYPE: Record<string, string> = {
  hyperliquid: 'perpetuals',
  jupiter: 'swap / DEX',
  '1inch': 'swap / DEX',
  bybit: 'perpetuals',
};
```

This renders into **both** judge and scout prompts since `buildSystemPrompt` and `buildScoutSystemPrompt` both consume runtime state. Verify that `buildScoutSystemPrompt` includes static context or wire it in.

**File:** `apps/worker/src/scout-dispatch.ts`

Verify that the scout prompt receives venue context. If it doesn't currently include static blocks, add the venue line to its params interface and render it.

## Test Plan

1. **Unit tests for `resolveBinanceSymbol`** — cover `BTC`, `btc`, `BTC/USD`, `BTC/USDT`, `BTC-PERP`, `BTCUSDT`, `SOL`
2. **Unit test for `CANDLE_PROVIDERS` completeness** — assert every key has all fields
3. **Update existing `analytics.test.ts`** — remove `botId` from test params
4. **Update existing `market-data.test.ts`** — verify `""` → undefined transform works
5. **Snapshot test for `buildSystemPrompt`** — assert venue info appears when trading binding present
6. **Run `pnpm lint`** — must pass after all changes

## File Change Summary

| File | Action |
|------|--------|
| `apps/worker/src/tools/trading.ts` | Add describes, empty-string transform on `safetyOverrideId` and `limitPrice` |
| `apps/worker/src/tools/analytics.ts` | Remove `botId`, add describes |
| `apps/worker/src/tools/market-data.ts` | Add describes, empty-string transform on `benchmarkSymbol`, wire registry |
| `apps/worker/src/tools/bots.ts` | Add describes, empty-string transform on `venueAccountId` |
| `apps/worker/src/tools/memory.ts` | Add describes |
| `apps/worker/src/tools/filesystem.ts` | Add describes |
| `apps/worker/src/tools/tasks.ts` | Add describes |
| `apps/worker/src/tools/web-access.ts` | Add describes |
| `apps/worker/src/tools/code.ts` | Add describes |
| `packages/market-data/src/candle-registry.ts` | New — typed candle provider registry |
| `packages/market-data/src/candle-registry.test.ts` | New — resolveSymbol contract tests |
| `packages/market-data/src/binance-candles.ts` | Fix `resolveBinanceSymbol` to strip slashes/suffixes |
| `packages/market-data/src/index.ts` | Export registry |
| `apps/worker/src/runtime-composition.ts` | Add `trading-venue` context provider |
| `apps/worker/src/scout-dispatch.ts` | Wire venue context into scout prompt |

## Sequence

1. Create `candle-registry.ts` + fix `resolveBinanceSymbol` (foundation)
2. Add `.describe()` to all tool params + empty-string transforms (bulk edit)
3. Remove `botId` from analytics tools (breaking change to tool schema)
4. Wire `check_regime` to registry for description (connects 1 + 2)
5. Add venue context provider to prompts (independent of tools)
6. Update tests, run lint
