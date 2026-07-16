# 🔴 Staging Investigation Report — 2026-07-16

## Executive Summary

**None of the 7 scanner_gated hybrid agents have made any trades because signals are never generated.** The root cause is that `applyConfigDefaults()` (built in the `001-apply-technical-config-defaults` feature) is only called by `getUnifiedConfig()`, but the worker's technical scan loop reads raw config through `getAgent()`, which bypasses the defaults entirely.

---

## Finding 1 (ROOT CAUSE): `scanBatchSize` is `undefined` — No Candles Fetched, Zero Signals

**Evidence:**
- DB query confirms ALL 7 agents have **no** `scanBatchSize` or `scanIntervalMs` stored in their JSONB config
- Every agent's `unified_config->'technical'` block contains `candles`, `filters`, `indicators` but NOT `scanBatchSize`/`scanIntervalMs`
- Worker logs show: `candidatesDiscovered: 232, candidatesScored: 0, signalsGenerated: 0` — for every agent, on every tick

**Code path:**

```
index.ts:830  →  agent?.unifiedConfig?.technical  (via getAgent() — NO defaults)
                    ↓
agent-trading-actor.ts:1461  →  runTechnicalPhase({ config: technicalConfig })
                    ↓
technical-phase.ts:126  →  for (i = 0; i < allSymbols.length; i += config.scanBatchSize)
                    ↓
               i += undefined  →  NaN  →  loop NEVER executes
                    ↓
         No candles fetched → candidatesScored: 0 → signalsGenerated: 0
```

The fix in `getUnifiedConfig()` at `agent-repository.ts:309` correctly applies defaults, but **`getAgent()` at line 253 does NOT**:

| Method | Calls `applyConfigDefaults()`? | Used by worker for config? |
|--------|-------------------------------|---------------------------|
| `getUnifiedConfig()` | ✅ Yes (line 323) | ❌ No |
| `getAgent()` | ❌ No (raw DB row) | ✅ Yes (`index.ts:808`) |

---

## Finding 2 (SECONDARY): `scanIntervalMs` is `undefined` — Worker CPU at 62%

**Evidence:**
- `worker-1`: **62.15% CPU** (should be <10% normally)
- `redis-1`: **22.5% CPU** (being hammered by rapid scans)
- Each of the 7 agent containers: **~10% CPU** each
- 230,767 log lines in 55 minutes — same messages repeating endlessly
- Same agent completes multiple scans **within the same second** (e.g., `[14:44:59]` appears 10+ times for agent `51403f2e`)

The scan loop `setInterval(fn, undefined)` runs at Node.js minimum timer resolution (~1ms), causing a **CPU storm**.

---

## Finding 3: Agents Wait for Wakes That Never Come

**Evidence:**
- All 7 agent containers correctly set `agent:scanner_gated:<id>` flags in Redis ✅
- Agent logs show: `"Hybrid agent: timer tick without wake signal — skipping LLM dispatch"` on every ~30 min tick
- Agents are correctly waiting for scanner wakes before dispatching LLM calls ✅
- But `emitAgentWake()` only fires when `signals.length > 0` — and signals are ALWAYS 0

**The loop:**
```
scanner runs → candidatesScored: 0 → signals: 0 → no wake emitted → agent sleeps → repeat
```

---

## Finding 4: DB Confirms Zero Trading Activity

| Metric | Count (last hour) |
|--------|------------------|
| Open orders | **0** |
| Recent fills | **0** |
| Recent decisions | **0** |

---

## Finding 5: API Is Healthy

API health checks pass normally, no errors in API logs.

---

## Other Anomalies

| Issue | Severity | Detail |
|-------|----------|--------|
| Worker log noise | MEDIUM | 230K+ identical log lines in <1hr — log aggregation systems will be expensive, and it obscures real issues |
| Redis CPU at 22.5% | LOW | Consequence of rapid scan loop hitting Redis repeatedly |
| Agent CPU at ~10% each | LOW | 7 agents × 10% = 70% total, but this may be from market-data polling (binance telemetry visible) |

---

## Recommended Fix

**Option A (Surgical — lowest risk):** Change `apps/worker/src/index.ts:830` to use `getUnifiedConfig()`:

```typescript
// BEFORE (line 808 + 830):
const agent = await agentRepo.getAgent(agentId);
const technicalConfig = (agent?.unifiedConfig?.technical as TechnicalConfig | undefined) ?? undefined;

// AFTER:
const unifiedConfig = await agentRepo.getUnifiedConfig(agentId);
const technicalConfig = unifiedConfig?.technical ?? undefined;
```

But note: `getAgent()` is still needed for `agent.capital`, `agent.dailyLossLimit`, etc. on subsequent lines. So the fix would add a second call or refactor.

**Option B (Broader — ensure all paths get defaults):** Apply `applyConfigDefaults()` inside `getAgent()` itself for the `unifiedConfig` field. This ensures ANY caller of `getAgent()` automatically gets defaults. Requires careful review of the 27 call sites to ensure none depend on raw undefined values.

**Option C (Hybrid):** Add `applyConfigDefaults()` to `getAgent()` AND verify all callers. This is the most thorough.

**My recommendation: Option B** — it's a one-line fix in agent-repository.ts that prevents this class of bug from recurring. The 27 `getAgent()` callers that read `unifiedConfig` all expect properly-defaulted values.

---

## Files to Change (Option B)

1. **agent-repository.ts** — `getAgent()`: apply `applyConfigDefaults()` to `unifiedConfig` before returning
2. **Verify** all callers don't break (most just read top-level fields like `capital`, `userId`, `status`)