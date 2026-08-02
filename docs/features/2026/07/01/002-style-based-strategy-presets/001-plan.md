# Plan: Style-Based Strategy Presets (YAML) for Agents & Bots

**Status:** Done
**Date:** 2026-07-01  
**Prior art:**
- `docs/features/2026/06/27/001-strategy-presets-mechanical-parity/001-plan.md` — MechanicalStrategy expansion (partially done)
- `apps/web/src/features/agents/style-mapping.ts` — agent style → runtime policy
- `config/strategy-presets/{economy,standard,premium}.yaml` — existing YAML (needs revision)

---

## Summary

Today, strategy presets are:
- **Hardcoded** in `apps/api/src/routes/blueprints.ts` (single style, USD values)
- **Duplicated** in `apps/web/src/features/bots/BotsPage.tsx` (identical copy, frontend)
- **Style-unaware** — no economy/standard/premium differentiation
- **USD-denominated** — `positionSize: "1"` means $1, `maxPositionSize: 1000` means $1000

This plan:
1. Implements `percent_equity` resolution in the mechanical strategy
2. Revises the YAML preset files to use percentage-based sizing
3. Builds a backend preset loader (YAML → typed config)
4. Updates the API to serve presets from YAML with `?style=` query param
5. Adds a preset-to-agent mapping function (split into technical + risk + execution)
6. Removes the duplicated frontend `STRATEGY_PRESETS`
7. Migrates existing bot/blueprint configs to the new format

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | 3 YAML files: `economy.yaml`, `standard.yaml`, `premium.yaml` | Maps to agent styles: careful→economy, balanced→standard, bold→premium |
| 2 | All sizing is percentage-based | Capital-agnostic: works for $100 and $100k accounts |
| 3 | `positionSizeMode: percent_equity` + `positionSize: "5"` | "5" means 5% of equity |
| 4 | `stopLossPct` and `takeProfitPct` live inside `strategy.params` ONLY | Single source of truth — not duplicated in a risk block |
| 5 | Risk block keeps only `maxPositionSizePct` | The only risk-level field that varies by style |
| 6 | `execution.mode: paper` stays in presets | Fallback default; users override at creation time |
| 7 | `decisionMode: mechanical` is the preset default | Agents override to `llm` or `hybrid` when applied |
| 8 | Strategy identity params (candleInterval, signalBias, indicators) don't change per style | Only risk/sizing/confidence thresholds change per style |
| 9 | Backend is single source of truth | Frontend fetches via API; no local copies |
| 10 | DCA: `amountPerBuy` as percentage with `amountPerBuyMode: percent_equity` | Same pattern as positionSize |

---

## Preset YAML Structure (target format)

```yaml
presets:
  momentum:
    name: "Momentum — Day"
    description: "Day-trend following on 15m candles."
    strategy:
      type: momentum
      decisionMode: mechanical
      params:
        candleInterval: "15m"
        candleLimit: 48
        minCandleCount: 20
        stopLossPct: 3          # strategy-level exit target
        takeProfitPct: 8        # strategy-level exit target
        signalBias: trend-following
        positionSize: "5"       # 5% of equity
        positionSizeMode: percent_equity
        indicators: { ... }
    risk:
      maxPositionSizePct: 15    # hard cap: no single position > 15% of equity
    execution:
      mode: paper
```

---

## How Presets Serve Both Actors

### Bot consumption (direct)

```
User picks preset + style → API loads YAML → blueprint.configData = preset
→ bot created from blueprint → worker reads configData
→ strategy.params → MechanicalStrategy.evaluate()
→ risk.maxPositionSizePct → RiskLimits for TradingActor
```

No transformation needed — the preset IS the blueprint config.

### Agent consumption (split)

```
User picks preset + style → API loads YAML → applyPresetToAgent() splits:
  1. technical → unifiedConfig.technical (indicators, candles, signalBias)
  2. risk → agent DB columns (stopLossPct, maxPositionSizePct)
  3. execution → unifiedConfig.execution (positionSize, positionSizeMode)
  4. decisionMode overridden to 'llm' or 'hybrid'
```

Mapping function:

```typescript
function applyPresetToAgent(preset: PresetConfig, mode: 'llm' | 'hybrid'): {
  technical: {
    indicators: IndicatorConfig;
    candles: { interval: string; limit: number };
    signalBias: string;
    scanIntervalMs?: number;
  };
  risk: {
    stopLossPct?: number;
    maxPositionSizePct?: number;
  };
  execution: {
    positionSize?: string;
    positionSizeMode?: string;
  };
} {
  const p = preset.strategy.params;
  return {
    technical: {
      indicators: p.indicators,
      candles: { interval: p.candleInterval, limit: p.candleLimit },
      signalBias: p.signalBias,
    },
    risk: {
      stopLossPct: p.stopLossPct,
      maxPositionSizePct: preset.risk?.maxPositionSizePct,
    },
    execution: {
      positionSize: p.positionSize,
      positionSizeMode: p.positionSizeMode,
    },
  };
}
```

### Agent creating bots

When an agent uses `create_bot` tool → calls `POST /blueprints/from-preset` directly → bot gets the full mechanical preset. No translation needed.

---

## Phase 0 — Prerequisite: `percent_equity` Resolution

**Problem:** `mechanical-strategy.ts` line 160 does `makeDecision(snapshot, signal.intent, params.positionSize, ...)`. When `positionSize = "5"` and `positionSizeMode = "percent_equity"`, it would pass `"5"` to `quantity()` which expects a USD/token amount.

**Files:**
- `packages/strategy/src/mechanical-strategy.ts`
- `packages/domain/src/config/schema.ts` (schema already supports the field)

### 0a — Add equity context to `MarketSnapshot`

The snapshot's `data` record must include `accountEquity` (number) so the strategy can compute the dollar amount from a percentage.

```typescript
// In the evaluate() method, before makeDecision:
function resolvePositionSize(params: MechanicalParams, snapshot: MarketSnapshot): string {
  if (params.positionSizeMode === 'percent_equity') {
    const equity = snapshot.data?.['accountEquity'];
    if (typeof equity !== 'number' || equity <= 0) {
      // Cannot resolve — return '0' to skip trade (loud log)
      return '0';
    }
    const pct = parseFloat(params.positionSize);
    if (isNaN(pct) || pct <= 0) return '0';
    const amount = (equity * pct) / 100;
    return amount.toFixed(6);
  }
  return params.positionSize;
}
```

### 0b — Wire `accountEquity` into snapshot

The TradingActor (worker) populates `snapshot.data` from the venue account balance. Ensure `accountEquity` is set before calling `strategy.evaluate()`.

**File:** `apps/worker/src/trading-actor.ts` (or wherever snapshot is built)

### 0c — Same pattern for DCA `amountPerBuy`

```typescript
// In DCA strategy (when implemented):
function resolveDcaAmount(params: DcaParams, equity: number): string {
  if (params.amountPerBuyMode === 'percent_equity') {
    const pct = parseFloat(params.amountPerBuy);
    if (isNaN(pct) || pct <= 0) return '0';
    return ((equity * pct) / 100).toFixed(6);
  }
  return params.amountPerBuy;
}
```

### Phase 0 checklist

- [ ] Add `resolvePositionSize()` helper to mechanical-strategy.ts
- [ ] Replace `params.positionSize` with `resolvePositionSize(params, snapshot)` in `evaluate()`
- [ ] Wire `accountEquity` into `MarketSnapshot.data` from TradingActor
- [ ] Add `amountPerBuyMode` field to DCA schema (`z.enum(['fixed', 'percent_equity']).default('fixed')`)
- [ ] Unit test: `percent_equity` computes correctly given equity in snapshot
- [ ] Unit test: missing equity → returns '0' (skip trade)
- [ ] Unit test: `fixed` mode unchanged (passes string through)
- [ ] `pnpm lint` passes

---

## Phase 1 — Revise YAML Preset Files

**Files:** `config/strategy-presets/{economy,standard,premium}.yaml`

### Changes from current content

| Field | Current (wrong) | Target (correct) |
|-------|-----------------|------------------|
| `positionSizeMode` | `fixed` | `percent_equity` |
| `positionSize` | `"0.5"`, `"1"`, `"2"` (USD) | `"2"`, `"5"`, `"10"` (percent) |
| `risk.maxPositionSize` | `500`, `1000`, `2500` (USD) | **remove** |
| `risk.maxPositionSizePct` | (missing) | `10`, `20`, `35` |
| `risk.stopLossPercent` | duplicates params | **remove** |
| `risk.takeProfitPercent` | duplicates params | **remove** |
| DCA `amountPerBuy` | `"5"`, `"10"`, `"25"` (USD) | `"1"`, `"2"`, `"5"` (percent) |
| DCA `amountPerBuyMode` | (missing) | `percent_equity` |
| `risk.maxTotalPosition` | `5000`, `10000`, `25000` | **remove** (use maxPositionSizePct) |

### Style differentiation pattern

| Parameter | Economy | Standard | Premium |
|-----------|---------|----------|---------|
| `positionSize` (%) | 2 | 5 | 10 |
| `maxPositionSizePct` (%) | 10 | 20 | 35 |
| `minConfidence` | 0.50–0.55 | 0.35–0.45 | 0.25–0.35 |
| `minReasons` | 3 | 2 | 2 |
| `stopLossPct` | tighter (1.5–5) | moderate (2–8) | wider (3–12) |
| `takeProfitPct` | conservative (3–15) | moderate (5–25) | aggressive (8–40) |
| DCA `intervalMs` | 2 days | 1 day | 12 hours |
| DCA `amountPerBuy` (%) | 1 | 2 | 5 |

### Phase 1 checklist

- [ ] Rewrite `economy.yaml` with percent_equity values, remove dead fields
- [ ] Rewrite `standard.yaml` with percent_equity values, remove dead fields
- [ ] Rewrite `premium.yaml` with percent_equity values, remove dead fields
- [ ] Add `amountPerBuyMode: percent_equity` to all DCA presets
- [ ] Verify YAML parses without error (write a loader test)

---

## Phase 2 — Backend Preset Loader

**New file:** `packages/domain/src/config/presets.ts`

### 2a — YAML loading + Zod validation

```typescript
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const PresetEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  strategy: z.object({
    type: z.string(),
    decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).default('mechanical'),
    params: z.record(z.unknown()),
  }),
  risk: z.object({
    maxPositionSizePct: z.number().min(0).max(100).optional(),
  }).optional(),
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
  }).optional(),
});

const PresetFileSchema = z.object({
  presets: z.record(PresetEntrySchema),
});

export type PresetEntry = z.infer<typeof PresetEntrySchema>;
export type StyleKey = 'economy' | 'standard' | 'premium';

const STYLE_FILES: Record<StyleKey, string> = {
  economy: 'config/strategy-presets/economy.yaml',
  standard: 'config/strategy-presets/standard.yaml',
  premium: 'config/strategy-presets/premium.yaml',
};

let cache: Map<StyleKey, Record<string, PresetEntry>> | null = null;

export function loadPresets(): Map<StyleKey, Record<string, PresetEntry>> {
  if (cache) return cache;
  cache = new Map();
  for (const [style, path] of Object.entries(STYLE_FILES)) {
    const raw = readFileSync(path, 'utf-8');
    const parsed = PresetFileSchema.parse(parseYaml(raw));
    cache.set(style as StyleKey, parsed.presets);
  }
  return cache;
}

export function getPreset(strategy: string, style: StyleKey): PresetEntry | undefined {
  return loadPresets().get(style)?.[strategy];
}

export function listPresets(style: StyleKey): Array<{ key: string } & PresetEntry> {
  const presets = loadPresets().get(style) ?? {};
  return Object.entries(presets).map(([key, entry]) => ({ key, ...entry }));
}
```

### 2b — Agent style → preset style mapping

```typescript
export function agentStyleToPresetStyle(agentStyle: string): StyleKey {
  switch (agentStyle) {
    case 'careful': return 'economy';
    case 'balanced': return 'standard';
    case 'bold': return 'premium';
    default: return 'standard';
  }
}
```

### 2c — `applyPresetToAgent()` mapping function

As described in the "How Presets Serve Both Actors" section above.

### Phase 2 checklist

- [ ] Create `packages/domain/src/config/presets.ts` with loader + cache
- [ ] Create `PresetEntrySchema` Zod schema
- [ ] Implement `loadPresets()`, `getPreset()`, `listPresets()`
- [ ] Implement `agentStyleToPresetStyle()` mapping
- [ ] Implement `applyPresetToAgent()` split function
- [ ] Export from `packages/domain/src/config/index.ts`
- [ ] Unit test: loads YAML, validates, returns typed data
- [ ] Unit test: invalid YAML throws at load time (fail fast)
- [ ] Unit test: `applyPresetToAgent()` produces correct split
- [ ] `pnpm lint` passes

---

## Phase 3 — Update API Routes

**File:** `apps/api/src/routes/blueprints.ts`

### 3a — Replace hardcoded `PRESETS` with YAML loader

```typescript
// Remove: const PRESETS: Record<PresetKey, ...> = { ... } (entire object)
// Replace with:
import { listPresets, getPreset, agentStyleToPresetStyle, type StyleKey } from '@herobids/domain';
```

### 3b — Update `GET /blueprints/presets`

Add `?style=` query param (optional, defaults to `standard`):

```typescript
// GET /blueprints/presets?style=economy
const StyleQuerySchema = z.object({
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
});

app.get('/blueprints/presets', async (req, reply) => {
  const { style } = StyleQuerySchema.parse(req.query);
  const presets = listPresets(style);
  return reply.send(presets);
});
```

### 3c — Update `POST /blueprints/from-preset`

Accept optional `style` in body:

```typescript
const FromPresetSchema = z.object({
  preset: z.string(),
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
  overrides: z.record(z.unknown()).optional(),
});
```

### 3d — Add `GET /presets/for-agent` endpoint

Returns the preset split for agent consumption:

```typescript
// GET /presets/for-agent?strategy=momentum&style=bold&mode=hybrid
app.get('/presets/for-agent', async (req, reply) => {
  const { strategy, style, mode } = ForAgentQuerySchema.parse(req.query);
  const preset = getPreset(strategy, style);
  if (!preset) return reply.status(404).send({ error: 'preset_not_found' });
  const split = applyPresetToAgent(preset, mode);
  return reply.send(split);
});
```

### Phase 3 checklist

- [ ] Remove hardcoded `PRESETS` constant from blueprints.ts
- [ ] Remove `PRESET_KEYS` constant (derive from YAML keys)
- [ ] Add `?style=` query param to `GET /blueprints/presets`
- [ ] Add `style` field to `POST /blueprints/from-preset` body
- [ ] Add `GET /presets/for-agent` endpoint with split mapping
- [ ] Update response shape if needed (ensure frontend compatibility)
- [ ] Integration test: `GET /blueprints/presets?style=economy` returns 7 presets
- [ ] Integration test: `POST /blueprints/from-preset` with style creates correct blueprint
- [ ] `pnpm lint` passes

---

## Phase 4 — Frontend Cleanup

**Files:**
- `apps/web/src/features/bots/BotsPage.tsx`
- `apps/web/src/lib/api-client.ts` (if needed)

### 4a — Remove duplicate `STRATEGY_PRESETS` from BotsPage.tsx

Delete lines 14–60+ (the entire `STRATEGY_PRESETS` array).

### 4b — Fetch presets from API

```typescript
const { data: presets } = useQuery({
  queryKey: ['blueprintPresets', selectedStyle],
  queryFn: () => botsApi.getPresets(selectedStyle),
});
```

### 4c — Add style selector to bot creation modal

Simple dropdown: Economy / Standard / Premium (default: Standard).

### 4d — Agent creation: use style from agent config

When creating an agent with a strategy preset, the style is already determined by the agent's style field (careful/balanced/bold → economy/standard/premium). The API handles the mapping.

### Phase 4 checklist

- [ ] Delete `STRATEGY_PRESETS` array from `BotsPage.tsx`
- [ ] Add `getPresets(style?: string)` to api-client
- [ ] Fetch presets from API in bot creation flow
- [ ] Add style selector dropdown to bot creation modal
- [ ] Agent creation UX: auto-map agent style → preset style
- [ ] Verify no other frontend files reference the old STRATEGY_PRESETS
- [ ] `pnpm lint` passes

---

## Phase 5 — Migration

**Purpose:** Existing blueprints/bots with USD-denominated `positionSize` and dead `risk.stopLossPercent` fields need updating.

### 5a — Database migration

```sql
-- For each blueprint with configData.strategy.params.positionSizeMode = 'fixed':
-- Convert positionSize from USD → percentage is NOT possible (we don't know account equity at creation time)
-- Instead: set positionSizeMode to 'percent_equity' and use a safe default (5%)

-- Remove dead fields from configData JSONB:
UPDATE blueprints
SET config_data = config_data #- '{risk,stopLossPercent}'
                              #- '{risk,takeProfitPercent}'
                              #- '{risk,maxPositionSize}'
WHERE config_data->'risk'->>'stopLossPercent' IS NOT NULL;
```

### 5b — Migration strategy

| Existing field | Action |
|----------------|--------|
| `risk.stopLossPercent` | Remove (redundant with `strategy.params.stopLossPct`) |
| `risk.takeProfitPercent` | Remove (redundant with `strategy.params.takeProfitPct`) |
| `risk.maxPositionSize` (USD) | Replace with `risk.maxPositionSizePct: 20` (safe default) |
| `positionSizeMode: 'fixed'` | Change to `'percent_equity'` with `positionSize: "5"` |
| `positionSize: "1"` (USD) | Change to `"5"` (5% — safe default for standard) |

### 5c — Runtime backward compatibility

During transition, `resolvePositionSize()` (Phase 0) still handles `fixed` mode — so any un-migrated configs continue working with USD amounts until migrated.

### Phase 5 checklist

- [ ] Generate Drizzle migration with `drizzle-kit generate`
- [ ] Write SQL to strip dead `risk.*` fields from existing JSONB
- [ ] Write SQL to update `positionSizeMode` to `percent_equity` with safe defaults
- [ ] Test migration on dev DB with existing blueprints
- [ ] Verify running bots still function with migrated config
- [ ] `pnpm lint` passes

---

## Out of Scope (follow-up)

- Scalper time restrictions (12am-5am, 7am-12noon UTC-4, skip if open positions)
- Exit policy (scale-out / trail remainder)
- Sentiment concrete adapter
- ICT swing trading checklist → preset generator
- `trailingStopPct` support in execution (schema exists, runtime deferred)

---

## Dependency Graph

```
Phase 0 (percent_equity resolution)
  ↓
Phase 1 (revise YAML files) — can start in parallel with Phase 0
  ↓
Phase 2 (backend loader) — depends on Phase 1 for valid YAML content
  ↓
Phase 3 (API routes) — depends on Phase 2 for loader functions
  ↓
Phase 4 (frontend) — depends on Phase 3 for API endpoints
  ↓
Phase 5 (migration) — depends on Phase 0 for backward-compat runtime
```

---

## Acceptance Criteria

1. `GET /blueprints/presets?style=economy` returns 7 presets with percent_equity sizing
2. `POST /blueprints/from-preset` with `style: "premium"` creates a blueprint with premium params
3. Bot created from preset computes correct position size given account equity
4. Agent created with preset gets correct `technical`, `risk`, and `execution` split
5. No `STRATEGY_PRESETS` in frontend code — all fetched from API
6. Existing bots/blueprints survive migration without breaking
7. `pnpm lint && pnpm test` pass
