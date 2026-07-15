# Bug: Technical Scanner `filters` Never Populated — All Hybrid Agents Crash on Discovery

**Date:** 2026-07-15
**Severity:** CRITICAL — blocks all hybrid agents from trading
**Status:** CLOSED
**Found during:** Staging smoke test of technical scanner data inputs feature (002-technical-data-for-agents)

## Summary

Every hybrid agent (`capabilityMode: "hybrid"`) on staging crashes on every scanner tick with:

```
TypeError: Cannot read properties of undefined (reading 'minVolume24hUsd')
    at Object.discoverCandidates (index.js:213:17)
    at async runTechnicalPhase (technical-phase.js:22:22)
```

The `filters` object in `unifiedConfig.technical` is always `undefined` because the API never populates it — not during agent creation (POST) and not during agent update (PATCH).

## Steps to Reproduce

1. User is logged-in on the frontend
2. User has a Hyperliquid connection (provider: `"hyperliquid"`)
3. User selects the Hyperliquid connection, then `scanner_gated`, then `momentum-day` preset
4. Frontend sends POST `/agents`:
   ```json
   {
     "name": "tmomentum-d",
     "strategyPreset": "momentum",
     "style": "balanced",
     "capabilityMode": "hybrid",
     "hybridMode": "scanner_gated",
     "connectionIds": ["<hyperliquid-conn-id>"]
   }
   ```
5. User creates and starts the agent
6. Agent's `unified_config->'technical'->'filters'` is NULL — no `venue` or `venueType`
7. Worker scanner loop crashes on every tick with `TypeError: Cannot read properties of undefined (reading 'minVolume24hUsd')`

## Affected Agents (staging)

| Agent ID | Name | capabilityMode | Has `technical`? | Has `technical.filters`? |
|----------|------|:---:|:---:|:---:|
| `51403f2e` | tmomentum-d | hybrid | ✅ | ❌ NULL |
| `b4f67404` | tswing | hybrid | ✅ | ❌ NULL |
| `93552994` | tmomentum-p | hybrid | ✅ | ❌ NULL |
| `64afd699` | trange | hybrid | ✅ | ❌ NULL |

## Root Cause

Three separate gaps combine to cause this bug:

### Gap 1: `applyPresetToAgent` never includes `filters` (by design — correct)

**File:** `packages/domain/src/config/presets.ts:102`

When a user selects a strategy preset (e.g. `momentum-day`), the API calls `applyPresetToAgent(preset, 'llm')` which maps preset YAML into a `technical` config:

```typescript
return {
  technical: {
    indicators: ...,
    candles: { interval, limit },
    signalBias: ...,
    // NO "filters" — presets define HOW to trade (indicators, sizing),
    // not WHERE to trade (venue, symbol filters). This separation is correct.
  },
};
```

### Gap 2: The API never populates `filters` from the connection (the bug)

**File:** `apps/api/src/routes/agents.ts`

Both the POST and PATCH handlers have connection validation queries inside their transactions that verify the `connectionIds` belong to the user and are active. But these queries never:
1. Select the connection's `provider` column
2. Call `venueTypeFromProvider(provider)` to derive the venue type
3. Write the result into `unifiedConfig.technical.filters`

There are **three** connection queries in `agents.ts`, and none of them populate `filters`:

| Location | Handler | Selects `provider`? | Calls `venueTypeFromProvider`? | Populates `filters`? |
|----------|---------|:---:|:---:|:---:|
| Line 818 (transaction) | POST | ❌ (id, userId, status only) | ❌ | ❌ |
| Line 1183 (outside tx) | PATCH | ✅ | ✅ | ❌ — result only used for `validateExecutionCapability` |
| Line 1495 (transaction) | PATCH | ❌ (id, userId, status only) | ❌ | ❌ |

### Gap 3: `discoverCandidates` has no `undefined` guard (crash site)

**File:** `apps/worker/src/index.ts` (~line 248)

The function signature `async (filters: FilterConfig)` declares `filters` as non-optional, but `runTechnicalPhase` passes `config.filters` which can be `undefined`.

### Full trace of the POST `/agents` flow

```
POST body: { strategyPreset: "momentum", connectionIds: ["conn-123"], ... }
    ↓
Line 92: CreateAgentSchema — technical is undefined (user picked preset, not explicit config)
    ↓
Line ~698: resolveAgentStrategyPreset() → applyPresetToAgent(preset, 'llm')
    → presetUnifiedConfig.technical = { indicators, candles, signalBias }  // NO filters
    ↓
Line ~717: parsed.data.technical === undefined
    → else if (presetUnifiedConfig) { finalUnifiedConfig = { ...presetUnifiedConfig } }
    ↓
Line ~726: capabilityMode/hybridMode stamped
    → finalUnifiedConfig = { technical: { indicators, candles, signalBias }, capabilityMode: "hybrid", ... }
    ↓
Line 810: Transaction begins
    ↓
Line 818: connRows = SELECT id, userId, status FROM connections WHERE id IN ("conn-123")
    → ❌ Does NOT select provider. ❌ Does NOT populate filters.
    ↓
Line ~810: INSERT INTO agents ... unifiedConfig = finalUnifiedConfig
    → unified_config->'technical'->'filters' = NULL
    ↓
Worker loads agent → casts as TechnicalConfig → config.filters === undefined → 💥
```

### Crash path (runtime)

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

### Fix 1 (primary): Populate `filters` in API agent handlers — POST

**File:** `apps/api/src/routes/agents.ts` — POST handler, inside the transaction (~line 818)

Add `provider` to the existing `connRows` SELECT query, and after connection validation, populate `filters` into `finalUnifiedConfig.technical` before the INSERT:

```typescript
// EXISTING query (line 818) — add provider:
const connRows = await tx.select({
  id: connections.id,
  userId: connections.userId,
  status: connections.status,
  provider: connections.provider,  // ← ADD
}).from(connections).where(inArray(connections.id, connectionIds));

// Existing validation loop (unchanged)...

// AFTER validation, BEFORE the tx.insert(agents) call at ~line 810:
// Populate technical.filters from the first valid connection
if (finalUnifiedConfig?.technical && connRows.length > 0) {
  const venueType = venueTypeFromProvider(connRows[0]!.provider) ?? 'orderbook';
  (finalUnifiedConfig.technical as Record<string, unknown>).filters = {
    venue: connRows[0]!.provider,
    venueType,
  };
}
```

**Why inside the transaction:** The connection validation and the agent insert are both inside the same transaction. Populating `filters` here ensures atomicity — if the insert succeeds, the filters are populated.

### Fix 1b (primary): Populate `filters` in API agent handlers — PATCH

**File:** `apps/api/src/routes/agents.ts` — PATCH handler, inside the transaction (~line 1495)

Same pattern: add `provider` to the connection validation SELECT, and populate `filters` into `unifiedConfigPatch.technical` before the UPDATE:

```typescript
// EXISTING query (line 1495) — add provider:
const connRows = await tx.select({
  id: connections.id,
  userId: connections.userId,
  status: connections.status,
  provider: connections.provider,  // ← ADD
}).from(connections).where(inArray(connections.id, toAdd));

// AFTER validation, BEFORE tx.update(agents):
// Collect all connection providers (existing + newly added)
if (unifiedConfigPatch?.technical) {
  const allProviderRows = await tx.select({ provider: connections.provider })
    .from(connections)
    .where(inArray(connections.id, [
      ...existingConnectionIds,
      ...toAdd,
    ].filter(Boolean)));

  if (allProviderRows.length > 0) {
    const venueType = venueTypeFromProvider(allProviderRows[0]!.provider) ?? 'orderbook';
    (unifiedConfigPatch.technical as Record<string, unknown>).filters = {
      venue: allProviderRows[0]!.provider,
      venueType,
    };
  }
}
```

> **Note:** The PATCH handler has a second connection query at line 1183 (outside the transaction) that already selects `provider` and calls `venueTypeFromProvider`. That query is used only for `validateExecutionCapability`. The fix above is independent — it operates inside the transaction where `unifiedConfig` is actually persisted.

### Fix 2 (defensive): Guard `discoverCandidates` against undefined filters

**File:** `apps/worker/src/index.ts` (~line 248)

Change the parameter type and add an early-return guard:

```typescript
// BEFORE:
const discoverCandidates = async (filters: FilterConfig) => {
  if (!sharedMarketDataRegistry) return [];
  const contexts = await sharedMarketDataRegistry.hyperliquid.assetContexts();
  let results = contexts.data.map(...);
  if (filters.minVolume24hUsd != null) { ... }  // 💥 here

// AFTER:
const discoverCandidates = async (filters: FilterConfig | undefined) => {
  if (!sharedMarketDataRegistry) return [];
  if (!filters) return [];  // ← ADD THIS GUARD
  const contexts = await sharedMarketDataRegistry.hyperliquid.assetContexts();
  let results = contexts.data.map(...);
  if (filters.minVolume24hUsd != null) { ... }  // safe
```

This is belt-and-suspenders — ensures a missing `filters` doesn't crash even if Fix 1 regresses. The scanner loop silently skips (existing behavior).

### Fix 3 (optional, lower priority): Validate `technical` at the worker boundary

**File:** `apps/worker/src/index.ts` (~line 830)

Replace the blind `as TechnicalConfig` cast with validated parsing:

```typescript
// BEFORE:
const technicalConfig = (agent?.unifiedConfig?.technical as TechnicalConfig | undefined) ?? undefined;

// AFTER:
const parsed = TechnicalConfigSchema.safeParse(agent?.unifiedConfig?.technical);
const technicalConfig = parsed.success ? parsed.data : undefined;
```

This would catch schema violations at agent load time (with a clear error) rather than at runtime inside the scanner loop. Requires importing `TechnicalConfigSchema` from `@herobids/domain`.

> Lower priority than Fix 1 and Fix 2 — the root cause is the API not populating `filters`, not a worker validation gap. Apply Fix 3 only if you want defense-in-depth.

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
