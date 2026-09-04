# Bug Report: duplicate `stopLossPct` key in BotCustomConfigSection silently drops the risk guardrail

- **Status:** FIXED
- **Severity:** Medium (silent config-field loss; noisy web build)
- **Date:** 2026-09-04
- **Discovered By:** Web production build emitted `Duplicate key "stopLossPct" in object literal` from `apps/web/src/features/bots/BotCustomConfigSection.tsx` during `run-all-tests.sh --e2e`.
- **Summary:** `BotCustomConfigFormState` declared `stopLossPct` twice — once under "Exit targets" (the per-trade mechanical stop) and again under "Risk guardrails" (the portfolio-level "Max unrealized loss %" input). The default-config object literal (`defaultBotCustomConfig`) also set `stopLossPct: ''` twice. Because TypeScript/JS keep only the last occurrence of a duplicate key, the two conceptually distinct inputs collapsed onto a single form field. Typing into either input mutated the same value, and `buildCustomBotConfig` read `c.stopLossPct` for both the strategy param and the risk guardrail, so the "Max unrealized loss %" guardrail could never be set independently of the mechanical exit target.

---

## Symptoms (as observed)

During the Vite web build:

```
[plugin vite:esbuild] src/features/bots/BotCustomConfigSection.tsx: Duplicate key "stopLossPct" in object literal
42 |    maxOpenPositions: '',
43 |    dailyMaxLossPct: '',
44 |    stopLossPct: '',
   |    ^
```

Functionally: the bot Create form's "Max unrealized loss %" guardrail and the "Stop loss %" exit target shared one state slot, so they could not hold different values.

---

## Root Cause

`apps/web/src/features/bots/BotCustomConfigSection.tsx`:

- The `BotCustomConfigFormState` interface listed `stopLossPct: string;` under both "Exit targets" and "Risk guardrails".
- `defaultBotCustomConfig` set `stopLossPct: ''` twice.
- The "Max unrealized loss %" `<input>` bound to `value.stopLossPct` / `onChange({ stopLossPct })`, colliding with the exit-target input of the same name.

`apps/web/src/features/bots/BotsPage.tsx` `buildCustomBotConfig` then read `c.stopLossPct` for both `params.stopLossPct` (mechanical exit) and `risk.stopLossPct` (unrealized-loss guardrail), so both always received the same number.

These are two distinct domain concepts: the strategy `params.stopLossPct` is the per-trade mechanical exit, while the risk-contract `stopLossPct` (see `packages/domain/src/agent-risk-contract.ts`) is the portfolio-level unrealized-loss stop.

---

## Fix

Give the risk guardrail its own form key, `riskStopLossPct`, distinct from the exit-target `stopLossPct`:

- `BotCustomConfigSection.tsx`: renamed the second (Risk Guardrails) field to `riskStopLossPct` in the interface, the defaults object, and the "Max unrealized loss %" input/validation.
- `BotsPage.tsx`: `buildCustomBotConfig` now reads `c.riskStopLossPct` for `risk.stopLossPct`; `presetToCustomConfig` populates `riskStopLossPct` from `preset.risk?.stopLossPct` for round-trip consistency.

The wire contract is unchanged — `risk.stopLossPct` is still emitted; only the internal form field was disambiguated.

---

## Verification

- `pnpm --filter @herobids/web run build` → no "Duplicate key" warning; build succeeds.
- `pnpm lint` (tsc --noEmit) → passes.

---

## Lessons / Follow-up

- Duplicate object-literal keys are only a Vite/esbuild *warning*, not a build failure, so this silently shipped. Consider enabling an ESLint `no-dupe-keys` gate (error-level) for `apps/web` so this fails fast in CI.
