# Bug: Technical Scanner `filters` Never Populated — All Hybrid Agents Crash on Discovery

**Date:** 2026-07-15
**Severity:** CRITICAL — blocks all hybrid agents from trading
**Found during:** Staging smoke test of technical scanner data inputs feature (002-technical-data-for-agents)

## Summary

Every hybrid agent (`capabilityMode: "hybrid"`) on staging crashes on every scanner tick with:

```
TypeError: Cannot read properties of undefined (reading 'minVolume24hUsd')
    at Object.discoverCandidates (index.js:213:17)
    at async runTechnicalPhase (technical-phase.js:22:22)
```

The `filters` object in `unifiedConfig.technical` is always `undefined` because the API never populates it — not during agent creation (POST) and not during agent update (PATCH).

## Affected Agents (staging)

| Agent ID | Name | capabilityMode | Has `technical`? | Has `technical.filters`? |
|----------|------|:---:|:---:|:---:|
| `51403f2e` | tmomentum-d | hybrid | ✅ | ❌ NULL |
| `b4f67404` | tswing | hybrid | ✅ | ❌ NULL |
| `93552994` | tmomentum-p | hybrid | ✅ | ❌ NULL |
| `64afd699` | trange | hybrid | ✅ | ❌ NULL |

## Root Cause

The `technical.filters` object is **never written** during agent creation or update. The wiring exists but the final assignment is missing.

### What exists

1. **`venueTypeFromProvider(provider)`** in `packages/domain/src/trading/execution-capability.ts:25` — correctly maps providers to venue types (`"hyperliquid"` → `"orderbook"`, `"jupiter"` → `"swap"`, etc.)

2. **Connection lookup** in `apps/api/src/routes/agents.ts` — the PATCH handler already looks up the agent's active connection and calls `venueTypeFromProvider` (line 1188):
   ```typescript
   const agentVenueType = venueTypeFromProvider(activeConn.provider);
   ```

3. **`TechnicalConfigSchema`** requires `filters` (in `packages/domain/src/config/schema.ts:1840`):
   ```typescript
   filters: z.object({
     venue: z.string(),
     venueType: z.enum(['orderbook', 'swap']),
     // ... optional filter fields
   })
   ```

4. **`discoverCandidates`** in `apps/worker/src/index.ts` calls `filters.minVolume24hUsd` on the filters object.

### What's missing

The derived `venue`/`venueType` from the connection is **never written into `technical.filters`** in either the POST or PATCH handler in `agents.ts`. The `technical` config stored in `unifiedConfig` ends up like:

```json
{
  "indicators": { "rsi": {...}, "macd": {...}, ... },
  "candles": { "interval": "15m", "limit": 48 },
  "signalBias": "trend-following"
}
```

No `filters` key at all.

### Crash path

```
POST/PATCH /agents → unifiedConfig.technical stored WITHOUT filters
    ↓
Worker loads agent → agent?.unifiedConfig?.technical cast as TechnicalConfig
    ↓
AgentTradingActor receives technicalConfig
    ↓
runTechnicalPhase(config) → deps.discoverCandidates(config.filters)
    ↓   config.filters === undefined
discoverCandidates → filters.minVolume24hUsd → 💥 TypeError
```

## Fix Plan

### Fix 1 (primary): Populate `filters` in the API agent handlers

**File:** `apps/api/src/routes/agents.ts`

In both the POST and PATCH handlers, after building `finalUnifiedConfig`, when a `technical` config exists and the agent has connections, derive and populate `filters`:

```typescript
// After finalUnifiedConfig is assembled, merge connection-derived filters
if (finalUnifiedConfig?.technical && connectionIds.length > 0) {
  const [conn] = await db.select({ provider: connections.provider })
    .from(connections)
    .where(eq(connections.id, connectionIds[0]!))
    .limit(1);
  if (conn) {
    const venueType = venueTypeFromProvider(conn.provider) ?? 'orderbook';
    (finalUnifiedConfig.technical as Record<string, unknown>).filters = {
      venue: conn.provider,
      venueType,
    };
  }
}
```

The PATCH handler already does the connection lookup at line 1188 — it just needs to write the result into `filters`.

### Fix 2 (defensive): Guard `discoverCandidates` against undefined filters

**File:** `apps/worker/src/index.ts`

```typescript
const discoverCandidates = async (filters: FilterConfig | undefined) => {
  if (!sharedMarketDataRegistry) return [];
  if (!filters) return [];  // ← ADD THIS GUARD
  // ... rest unchanged
```

This is belt-and-suspenders — ensures a missing `filters` doesn't crash even if Fix 1 regresses.

### Fix 3 (optional): Validate `technical` at the worker boundary

**File:** `apps/worker/src/index.ts` (~line 830)

Consider running `TechnicalConfigSchema.safeParse()` on the raw JSONB instead of a blind `as TechnicalConfig` cast:

```typescript
const parsed = TechnicalConfigSchema.safeParse(agent?.unifiedConfig?.technical);
const technicalConfig = parsed.success ? parsed.data : undefined;
```

This would catch schema violations at load time rather than at runtime inside the scanner loop.

## Verification

| Check | How |
|-------|-----|
| New agent created with filters populated | Create agent via API with `strategyPreset + connectionIds` → query `unified_config->'technical'->'filters'` → should have `venue` and `venueType` |
| Existing agent PATCH populates filters | PATCH an existing hybrid agent that has connections → filters should appear |
| Scanner no longer crashes | `docker logs herobids-worker-1` → no more "candidate discovery failed" errors |
| Signals flow through | Logs show "Technical phase: advisory mode" with signalCount > 0 |
| `pnpm lint` passes | Zero type errors |

## Related

- Feature plan: `docs/features/2026/07/15/002-technical-data-for-agents/001-plan.md`
- `TechnicalConfigSchema`: `packages/domain/src/config/schema.ts:1839`
- `venueTypeFromProvider`: `packages/domain/src/trading/execution-capability.ts:25`
- `applyPresetToAgent`: `packages/domain/src/config/presets.ts:102`
- `discoverCandidates`: `apps/worker/src/index.ts` (~line 248)
- `runTechnicalPhase`: `apps/worker/src/technical-phase.ts:90`
