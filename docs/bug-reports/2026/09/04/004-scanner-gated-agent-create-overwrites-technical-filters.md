# Bug Report: agent create/update overwrites client-supplied `technical.filters` (drops `symbols` and other fields)

- **Status:** OPEN (not yet fixed — investigation only)
- **Severity:** High (silent data loss on a user-configured field; scanner scopes wider than the user requested)
- **Date:** 2026-09-04
- **Discovered By:** `scripts/shell/tests/run-extra-tests.sh --all` → Tier 5 `scanner-provider-smoke` reported `0/3 passed, 3 failed`.
- **Summary:** When an agent is created (POST `/agents`) or updated (PATCH `/agents/:id`) with `connectionIds` and an explicit `technical` block, the create-normalization step **replaces** `technical.filters` wholesale with a connection-derived `{ venue, venueType }` object. Any client-supplied filter fields — `symbols`, `excludeSymbols`, `minVolume24hUsd`, `minLiquidityUsd`, `networks`, `quoteAssetSymbol` — are discarded. The schema then applies the `quoteAssetSymbol` default (`'USDC'`), so a request sending `filters.symbols: ['BTC','ETH']` persists as `{ venue, venueType, quoteAssetSymbol: 'USDC' }` with no `symbols`.

## History / Related

This is a **regression introduced by the fix for an earlier bug**, and should be read together with it:

- **Origin:** [`docs/bug-reports/2026/07/15/002-technical-scanner-filters-never-populated.md`](../../07/15/002-technical-scanner-filters-never-populated.md) — CRITICAL bug where preset-based hybrid agents had `technical.filters = NULL`, crashing the worker scanner on every tick (`TypeError: Cannot read properties of undefined (reading 'minVolume24hUsd')`). Its Fix 1 populated `filters` from the connection's provider (`venue` + `venueType`).
- **Sibling:** [`docs/bug-reports/2026/07/15/003-patch-preset-technical-null-collision.md`](../../07/15/003-patch-preset-technical-null-collision.md) (same area, PATCH path).

The 07/15/002 fix was **correct for its scope** (the preset path, where the client sends no `technical` at all, so `filters` is absent and assigning `{ venue, venueType }` is purely additive). Its own Gap 1 states presets "define HOW to trade (indicators, sizing), not WHERE to trade (venue, symbol filters)" — i.e. symbol filters are legitimately user-owned. But the fix used a plain assignment rather than a merge, and never covered the case where a client sends an **explicit** `technical.filters` with `symbols`. That case was out of scope for the report and is untested (every API test for this path sends filters without `symbols`).

## Git history

- Overwrite introduced: `fcc2eaf0` — "Fix docs/bug-reports/2026/07/15/002-technical-scanner-filters-never-populated" (in `apps/api/src/routes/agents.ts`).
- Moved verbatim into the shared helper: `d2be7e30` — "feat(api): extract shared agent create-time normalization helpers" (references now-removed plan `docs/features/2026/08/07/001-fix-guided-setup-missing-agent-config/001-plan.md`).

## Steps to Reproduce

1. Have an active Hyperliquid connection.
2. POST `/agents` with `capabilityMode: 'hybrid'`, `hybridMode: 'scanner_gated'`, `connectionIds: [<conn>]`, and:
   ```json
   "technical": { "filters": { "venue": "hyperliquid", "venueType": "orderbook", "symbols": ["BTC", "ETH"], "minVolume24hUsd": 1000000 } }
   ```
3. Read `unified_config->'technical'->'filters'` from the DB.
4. **Observed:** `{"venue": "hyperliquid", "venueType": "orderbook", "quoteAssetSymbol": "USDC"}` — `symbols` and `minVolume24hUsd` are gone.
5. **Expected:** `symbols`, `minVolume24hUsd`, etc. preserved; connection sets only `venue`/`venueType`.

Observed in the run log (`.ignore/run-extra-tests-log.log`):
```
✗ FAIL s1-db-symbols: filters missing BTC/ETH: {"venue": "hyperliquid", "venueType": "orderbook", "quoteAssetSymbol": "USDC"}
```

## Root Cause

`apps/api/src/agents/agent-create-normalization.ts`, step 7 ("Populate technical.filters from selected connections"):

```typescript
(finalUnifiedConfig.technical as Record<string, unknown>).filters = {
  venue: providerRows[0]!.provider,
  venueType,
};
```

Plain assignment, not a merge. Then step 8 runs `TechnicalConfigSchema.parse(...)`, applying `quoteAssetSymbol`'s `.default('USDC')`. Net result is the three-key object above.

The **PATCH path** has the identical pattern in `apps/api/src/routes/agents.ts` (~line 1403):
```typescript
(unifiedConfigPatch.technical as Record<string, unknown>).filters = {
  venue: providerRows[0]!.provider,
  venueType,
};
```

`TechnicalConfigSchema.filters` (`packages/domain/src/config/schema.ts`) **does** accept `symbols` (`z.array(z.string()).optional()`), so validation is not the culprit — the field is dropped before persistence.

## Proposed direction (NOT yet applied)

Merge instead of replace, so the connection sets `venue`/`venueType` while user-supplied filter fields survive:

```typescript
const existing = (finalUnifiedConfig.technical as Record<string, unknown>).filters as Record<string, unknown> | undefined;
(finalUnifiedConfig.technical as Record<string, unknown>).filters = {
  ...(existing ?? {}),
  venue: providerRows[0]!.provider,
  venueType,
};
```

This still satisfies 07/15/002 (preset path: `existing` is absent, so behavior is unchanged) and preserves explicit filters. The same change is needed at the PATCH site. Fix deferred pending decision.

## Scope note — this bug explains ONE of the three scanner-provider-smoke failures

Only `s1-db-symbols` is caused by this bug. The other two failures in the same test are a **separate** issue (see report 005 / classification below):

```
✗ FAIL s1-scan-count: only 0 scan(s) found (need ≥2)
✗ FAIL s2-interval: only 1 timestamps found (need ≥2)
```

These are **not** caused by the filters overwrite. They stem from a log-format mismatch between the worker and the test's log parser:

- Under `scripts/shell/tests/run-extra-tests.sh`, the stack is started with the base `docker-compose.yaml` only (no `docker-compose.dev.yaml` overlay). The base compose sets the worker `NODE_ENV=development`.
- `apps/worker/src/logger.ts`: `isPrettyLog = LOG_FORMAT === 'pretty' || NODE_ENV === 'development'` → the worker emits **pino-pretty** output, not JSON.
- `scripts/ts/scanner-provider-smoke-test.ts` `parseScanLogs()` skips any block lacking a `candidatesDiscovered:\s*(\d+)` match and parses per-symbol data with JSON-shaped regexes (`"symbol":\s*"..."`). The test log shows `✓ Scan logs captured` (the substring "Technical phase complete" WAS found by `pollForScanComplete`) yet `parseScanLogs` returned 0 scans — a parser/format mismatch, not a missing scan.
- The parser also asserts on fields the worker never emits. Worker's "Technical phase complete" line (`apps/worker/src/technical-phase.ts:~623`) logs `candidatesDiscovered, candidatesScored, signalsGenerated, entriesSubmitted, exitsSubmitted, regimeBlocked, errorCount` — but the test expects `candidatesEligible`, `candidatesFetched`, and a `symbolOutcomes[]` array (the test's own comment concedes `symbolOutcomes` "may not be emitting yet").

Classification: **separate root cause.** The scan-count/interval failures are a test-harness/log-format problem (and possibly stale assertions on unemitted fields), independent of the API filters overwrite. Not yet confirmed whether any scans genuinely ran twice within the window — only that the parser cannot extract them from pretty-format logs.

## Verification (for whoever fixes this)

| Check | How |
|-------|-----|
| Explicit `symbols` preserved on create | POST agent with `technical.filters.symbols: ['BTC','ETH']` + `connectionIds` → DB `filters` contains `symbols` and `venue`/`venueType` |
| Explicit `symbols` preserved on update | PATCH an agent's `technical.filters.symbols` → persisted, not dropped |
| Preset path still populates venue | POST preset agent with no `technical` → `filters` gets `venue`/`venueType` (07/15/002 regression guard) |
| `pnpm lint` passes | tsc `--noEmit` clean |

## References

- `apps/api/src/agents/agent-create-normalization.ts` (step 7 — create overwrite)
- `apps/api/src/routes/agents.ts` (~line 1403 — PATCH overwrite)
- `packages/domain/src/config/schema.ts` — `TechnicalConfigSchema.filters` (accepts `symbols`)
- `scripts/ts/scanner-provider-smoke-test.ts` — `parseScanLogs`, `checkScanInterval`
- `apps/worker/src/logger.ts` — pretty-vs-JSON selection
- `apps/worker/src/technical-phase.ts` (~line 623) — "Technical phase complete" fields
- Prior: `docs/bug-reports/2026/07/15/002-technical-scanner-filters-never-populated.md`
