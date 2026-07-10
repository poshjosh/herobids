- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-10
- **Summary:** `get_account_summary` returns `executionMode: "unknown"` even though the agent's actual execution mode is always available on the tool context.

## Root Cause

`apps/worker/src/tools/account.ts` resolves `executionMode` from `agentConfigOps.getCurrentConfig()`. When `agentConfigOps` is unavailable (or returns `null`), the local variable remains `null` and the return statement falls back to the literal string `"unknown"`:

```ts
executionMode: executionMode ?? 'unknown',
```

The tool context (`ctx`) always carries `executionMode` (typed `'paper' | 'shadow' | 'live'`, set by the agent runtime from `agentConfig.executionMode`). This value was never consulted.

Observed in staging session `02fa6f7b` for agent `695c8783` (balanced-agent-0): the agent logged into `get_account_summary` showing `"executionMode":"unknown"` despite running in `shadow` mode. The LLM had to infer its mode from context rather than reading it directly.

## Fix

`apps/worker/src/tools/account.ts` — one-line change:

```ts
// Before
executionMode: executionMode ?? 'unknown',

// After
executionMode: executionMode ?? ctx.executionMode,
```

`ctx.executionMode` is always set (`'paper' | 'shadow' | 'live'`), so the fallback chain is now: config value → ctx value (never `"unknown"`).

## Files Changed

- `apps/worker/src/tools/account.ts` — fallback to `ctx.executionMode`
- `apps/worker/src/tools/account.test.ts` — updated assertion: `'unknown'` → `'paper'` (the `makeCtx` default)
- `CHANGELOG.md` — entry under `v0.0.17`

## Verification

All 271 test files pass (`pnpm run test` — 4282 tests, 0 failures).
