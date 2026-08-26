# 001 — Scanner-gated orderbook agents silently run without regime config

- **Status:** OPEN
- **Severity:** MEDIUM
- **Date:** 2026-08-24
- **Discovered:** During agent evaluation session (thyper, 003e9ce1). Scanner fingerprint reported `regime:unavailable` for 13 hours, suppressing all 113 wake signals. Agent never escalated to LLM despite active market and 494 scan candidates.
- **Environment:** local (docker compose)
- **Component:** `apps/api/src/agents/agent-create-normalization.ts`, `apps/worker/src/index.ts`, `packages/domain/src/config/schema.ts`

## Summary

A scanner-gated orderbook agent (`thyper`) was created via the `create-agents.sh` script with `strategyPreset: "contrarian"` and `hybridMode: "scanner_gated"`. The preset system builds the technical config with indicators, candles, and signal bias — but never populates the `regime` field. Since `regime` is `.optional()` in both `TechnicalConfigSchema` and `StrictTechnicalConfigSchema`, the agent passes all validation and starts successfully.

At runtime, `runTechnicalPhase()` checks `if (config.regime)` before evaluating regime — when absent, it skips evaluation entirely, leaving `regimeResult = null`. The fingerprint becomes `exit:none|regime:unavailable` on every scan cycle. Since the fingerprint never changes, the scanner dedup gate suppresses all wake signals. The agent is alive, scanning, finding candidates — but permanently blocked from waking the LLM.

The system-wide BTC regime check (`market-intel:regime:BTC`) works fine (768 successful evaluations in the same period) but is completely unrelated — the scanner computes regime independently via direct candle fetch, gated by `config.regime`.

## Root Cause

Three layers fail to ensure `regime` is present for scanner-gated orderbook agents:

1. **Preset system** (`packages/domain/src/config/presets.ts` → `applyPresetToAgent()`): Maps indicators, candles, signalBias but never populates `regime`.
2. **API validation** (`apps/api/src/agents/agent-create-normalization.ts` → `resolveUnifiedConfig()`): Applies `TechnicalConfigSchema.parse()` which treats `regime` as optional. No conditional check for scanner-gated + orderbook.
3. **Worker startup** (`apps/worker/src/index.ts` → `onSessionActive`): Uses `StrictTechnicalConfigSchema` which also marks `regime` as optional. No fallback injection.

## Impact

- Scanner-gated orderbook agents created via any path (API, UI, scripts) without explicit `regime` in their technical config will be permanently dormant — running scans but never waking the LLM.
- The agent consumes runtime resources (CPU, heartbeats, candle fetches, billing runtime_ms) with zero productive output.
- No error or warning is emitted. The agent reports `healthy_no_signal` scan health.

## Fix

Combined approach (Option A + B):

1. **Creation-time validation (Option A):** In `resolveUnifiedConfig()`, after building the technical config, reject scanner-gated orderbook agents that have no `regime` field. Clear error message at API boundary.
2. **Runtime fallback (Option B):** In the worker `onSessionActive` handler, after strict validation, inject `{ benchmarkSymbol: "BTC" }` as a default if `regime` is absent for scanner-gated orderbook agents. Logs a warning so operators can fix the stored config.
3. **Swap venues excluded:** Neither validation nor default applies to swap/DEX agents — BTC regime is not a meaningful gate for memecoin/DEX scanning.

## Affected Agents (observed)

- `thyper` (003e9ce1-c0bf-4952-a80a-597e9956c171) — Hyperliquid, scanner_gated, contrarian preset
- `t1inch` (8efb1f0b-5b85-43d1-b0ae-d3a8f9691995) — 1inch, scanner_gated, range preset (swap venue — regime not applicable)

## References

- Evaluation report: `.ignore/eval/2026/08/24/REPORT.md`
- Scanner fingerprint logic: `apps/worker/src/complete-technical-scan.ts` → `computeSignalFingerprint()`
- Regime gate in scanner: `apps/worker/src/technical-phase.ts` line ~208 (`if (config.regime)`)
- Regime evaluation function: `packages/market-data/src/regime.ts` → `evaluateRegime()`
