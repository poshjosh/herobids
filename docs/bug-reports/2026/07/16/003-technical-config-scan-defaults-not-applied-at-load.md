# Bug: `TechnicalConfig.scanBatchSize` and `scanIntervalMs` Undefined — Scanner Silently Fetches Zero Candles

**Date:** 2026-07-16
**Severity:** CRITICAL — blocks all hybrid agents from trading; zero signals generated despite valid market data
**Status:** OPEN
**Found during:** Staging smoke test — 7 agents, 6 hours, 0 trades

## Summary

All 7 hybrid agents on staging produce `candidatesDiscovered: 232` but `candidatesScored: 0` and `signalsGenerated: 0` on every scanner tick. No errors are logged (`errorCount: 0`). The technical scanner loop burns CPU at maximum speed (~171k log lines in 6 hours) while producing zero actionable signals. No trades are placed because the hybrid evaluator (LLM) is only woken when `signals.length > 0`.

**Root cause:** `scanBatchSize` and `scanIntervalMs` are `undefined` at runtime because `getUnifiedConfig()` returns raw JSONB without applying `TechnicalConfigSchema` Zod defaults. The candle-fetching `for` loop silently becomes a no-op because `i += undefined` → `NaN` → loop condition `NaN < 232` is `false`.

## Steps to Reproduce

1. Create a hybrid agent with `capabilityMode: "hybrid"` and `hybridMode: "scanner_gated"`
2. Store a `unified_config.technical` block that includes `filters`, `indicators`, `candles`, and `signalBias` — but **omit** `scanBatchSize` and `scanIntervalMs`
3. Start the agent
4. Observe worker logs: every `Technical phase complete` shows `candidatesScored: 0` with `errorCount: 0`

The config stored in DB looks like:

```json
{
  "technical": {
    "candles": { "limit": 72, "interval": "4H" },
    "filters": { "venue": "hyperliquid", "venueType": "orderbook" },
    "indicators": { "rsi": {...}, "macd": {...}, ... },
    "signalBias": "trend-following"
  }
}
```

Note: `scanBatchSize` and `scanIntervalMs` are absent.

## Affected Agents (staging)

All 7 active agents — confirmed via DB query:

| Agent ID | Name | capabilityMode | hybridMode | scanBatchSize in DB? |
|----------|------|:---:|:---:|:---:|
| `51403f2e` | tmomentum-d | hybrid | scanner_gated | ❌ NULL |
| `93552994` | tmomentum-p | hybrid | scanner_gated | ❌ NULL |
| `64afd699` | trange | hybrid | scanner_gated | ❌ NULL |
| `3fa538e3` | tscalper | hybrid | scanner_gated | ❌ NULL |
| `b4f67404` | tswing | hybrid | scanner_gated | ❌ NULL |
| `15bfaf97` | tswing-playbook | hybrid | scanner_gated | ❌ NULL |
| `70b3d865` | tcontrarian | hybrid | scanner_gated | ❌ NULL |

## Root Cause

### Gap 1: `TechnicalConfigSchema` defaults exist but are never applied at the read boundary

**File:** `packages/domain/src/config/schema.ts` (line 1839)

The Zod schema defines defaults:

```typescript
export const TechnicalConfigSchema = z.object({
  // ...
  candles: z.object({...}).default({ interval: '15m', limit: 100 }),
  signalBias: z.enum([...]).default('trend-following'),
  scanIntervalMs: z.number().int().min(10_000).default(60_000),
  scanBatchSize: z.number().int().min(1).max(50).default(5),
  autonomousExit: z.boolean().default(false),
});
```

But `getUnifiedConfig()` in `packages/db/src/agent-repository.ts` (line 259) returns the raw JSONB cast as a type — **it never parses the `technical` sub-object through `TechnicalConfigSchema`**:

```typescript
async getUnifiedConfig(agentId: string): Promise<UnifiedAgentConfig | null> {
    const rows = await this.db.select({ unifiedConfig: agents.unifiedConfig })
      .from(agents).where(eq(agents.id, agentId)).limit(1);
    const raw = rows[0]?.unifiedConfig ?? null;
    if (!raw) return null;
    // Only capabilityMode/hybridMode defaults are applied here
    return applyCapabilityModeMigrationDefaults(raw as Record<string, unknown>) as UnifiedAgentConfig;
}
```

### Gap 2: `runTechnicalPhase` uses `config.scanBatchSize` in arithmetic — undefined propagates as NaN

**File:** `apps/worker/src/technical-phase.ts` (step 5)

```typescript
for (let i = 0; i < allSymbols.length; i += config.scanBatchSize) {
    // i += undefined → NaN → loop never executes
    const batch = allSymbols.slice(i, i + config.scanBatchSize);
    // ...
}
```

When `scanBatchSize` is `undefined`, `i += undefined` produces `NaN`. The loop condition `NaN < 232` evaluates to `false` in JavaScript — the loop body never runs. Zero candles are fetched, `candidateContexts` remains empty, `candidatesScored = 0`.

### Gap 3: `setInterval(fn, undefined)` runs at maximum speed

**File:** `apps/worker/src/agent-trading-actor.ts` (`startTechnicalScanLoop`)

```typescript
const intervalMs = technicalConfig.scanIntervalMs; // undefined
this.technicalScanTimer = setInterval(() => {
    void this.runTechnicalScan();
}, intervalMs);
```

`setInterval(fn, undefined)` defaults to ~1ms in Node.js. This causes the scan to fire at maximum possible speed, generating ~171k log lines in 6 hours (8 lines/sec across 7 agents).

### Gap 4: No test exercises the undefined-default path

- `schema.test.ts`: Only tests `autonomousExit` default — never tests `scanBatchSize` or `scanIntervalMs` defaults
- `technical-phase.test.ts`: `makeBaseDeps()` always passes explicit `scanBatchSize: 5` and `scanIntervalMs: 60_000`
- `agent-repository.test.ts`: Only tests `capabilityMode`/`hybridMode` defaulting
- `agent-config-matrix-test.ts`: Checks `agentHasFilters()` but not whether defaults like `scanBatchSize` are populated

## Impact

- **Zero trades placed** by any hybrid agent on staging for 6+ hours
- **CPU waste**: 171k log lines in 6 hours from tight scan loop
- **Silent failure**: `errorCount: 0` — no errors to alert on
- **LLM never invoked**: No scanner wake emitted because `signalsGenerated: 0`

## Fix Direction

Apply `TechnicalConfigSchema` defaults at the read boundary. Two possible approaches:

1. **Parse in `getUnifiedConfig()`** — parse `raw.technical` through `TechnicalConfigSchema` before returning (applies all defaults). Same for `raw.intelligence` through `IntelligenceConfigSchema`.
2. **Parse at the call site** — in `apps/worker/src/index.ts`, parse `agent?.unifiedConfig?.technical` through `TechnicalConfigSchema` before passing to `AgentTradingActor`.

Option 1 is preferred because it fixes the issue for ALL consumers of `getUnifiedConfig()`, not just the worker.
