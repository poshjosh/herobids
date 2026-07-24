# 001 — Swing and range agents score zero scanner candidates due to Binance interval casing mismatch

**Status:** FIXED
**Severity:** High
**Date:** 2026-07-24
**Summary:** Scanner runs for all three agents (mo-day, swing, range), but swing (4H) and range (1H) score zero candidates because Binance rejects uppercase `H` in candle intervals (`4H` → HTTP 400). mo-day works because `15m` is naturally lowercase.

**Root Cause:** Preset YAML files define `candleInterval: "4H"` and `candleInterval: "1H"` with uppercase H. Binance API requires lowercase (`4h`, `1h`). No normalization exists in the fetch chain. `classifyCandleError()` maps HTTP 400 to `'unsupported'`, permanently blacklisting all symbols for swing/range each scan.

**Fix:**
1. Changed `4H` → `4h` and `1H` → `1h` in all 3 strategy preset YAML files (standard, economy, premium)
2. Changed all Zod enum and TypeScript type definitions to use lowercase: schema.ts (4 locations), assessment-ports.ts, binding-resolver.ts, technical-types.ts, technical-config-helpers.ts, BotCustomConfigSection.tsx
3. Changed UI dropdown options in TechnicalConfigSection.tsx to display lowercase
4. Added `.toLowerCase()` normalization in `fetchBinanceCandles()` as defense-in-depth
5. Updated test files: technical-config-helpers.test.ts, scanner-gated-phase2.test.ts

**Files Changed:**
- `config/strategy-presets/standard.yaml`
- `config/strategy-presets/economy.yaml`
- `config/strategy-presets/premium.yaml`
- `packages/domain/src/config/schema.ts`
- `packages/market-data/src/binance-candles.ts`
- `apps/worker/src/market-intelligence/assessment-ports.ts`
- `apps/worker/src/market-intelligence/binding-resolver.ts`
- `apps/web/src/features/agents/technical-types.ts`
- `apps/web/src/features/agents/technical-config-helpers.ts`
- `apps/web/src/features/agents/TechnicalConfigSection.tsx`
- `apps/web/src/features/bots/BotCustomConfigSection.tsx`
- `apps/web/src/features/agents/technical-config-helpers.test.ts`
- `apps/worker/src/scanner-gated-phase2.test.ts`

**Verification:** TBD — deploy to staging and confirm swing/range produce non-zero scored candidates.
