# Bug: scanner_gated agents on swap venues (1inch/Jupiter) fail to create with `swap.network_unresolved`

**Date:** 2026-10-06
**Severity:** HIGH. Every hybrid `scanner_gated` agent on a swap venue (1inch, Jupiter) fails `POST /agents` (and the equivalent PATCH) with HTTP 400. `scripts/shell/run/create-agents.sh` aborts at `t1inch`, so `reset-and-run-xstack.sh` provisions 1 of its 4 fixture agents.
**Status:** FIX IMPLEMENTED in traderton; end-to-end xstack verification pending (see checklist).
**Fix location:** `traderton` only. No herobids code change is required.

## Summary

`POST /agents` for a `scanner_gated` agent bound to a 1inch or Jupiter connection returns:

```json
{
  "error": "validation_error",
  "message": "Binding network is unresolved (venue=1inch). The agent is configured as scanner_gated + swap but the binding network could not be determined."
}
```

The failure is deterministic. herobids forwards the agent's scan config to traderton's `set_agent_trading_profile` tool, and traderton's save-time scan validation rejects it. traderton maps the error to `TradingProfileScanValidationError`, and herobids turns that into a 400 (`apps/api/src/routes/agents.ts:896` and `:1947`).

## Root cause

traderton's profile-write validation reads the swap **binding network** from the wrong place.

`traderton/packages/worker/src/tools/trading-profiles.ts`, `validateScanConfiguration` (before the fix):

```ts
if (venueType === 'swap') {
  const network = resolved.filters.networks?.[0] as SupportedTokenSafetyNetwork | undefined;
  const swap = validateSwapScannerConfig(network, venue, lenient.data, canonicalTokensFrom(params.marketDataConfig));
  ...
}
```

`filters.networks` is an optional creator scan filter, not the network source:

- `validateSwapScannerConfig` (`packages/worker/src/swap-startup-validation.ts`) takes the binding network as its own argument and uses `filters.networks` only for the "is the binding network excluded?" check (`swap.network_excluded`). Its tests assert it passes when `filters.networks` is undefined or empty.
- traderton's runtime resolves the network from the venue and operator config: `resolveSwapNetwork(spec.venue, undefined, runtimeDeps.oneInchConfig)` in `wireScanDeps` (`packages/worker/src/composition/decision-intake.ts`). It does the same in `create-trading-runtime.ts`, `validate-trade-instrument.ts` and `tools/position-marks.ts`. `resolveSwapNetwork` returns `solana` for Jupiter. For 1inch it uses operator `venues.1inch.tokenSafetyNetwork`, then `venues.1inch.chainId` (xstack config: `chainId: 8453`, `tokenSafetyNetwork: base`).
- Presets intentionally carry no `filters`, and nothing in herobids sets `filters.networks`. So for every swap agent the old code passed `undefined` and failed check #1.

The save-time check and the runtime could also disagree. Before the fix, a creator `filters.networks: ['solana']` on a base-chain 1inch account would pass validation as `solana`, while the runtime scanned `base`.

### Origin: regression from the extraction

- Before extraction, herobids' in-process worker validated with the resolved binding network: `resolveSwapNetwork(binding.venue, bindingForSwap, appConfig.venues['1inch'])` was passed to `validateSwapScannerConfig` (`apps/worker/src/index.ts`, around lines 1171 and 1242, at `45271d28^`). Swap `scanner_gated` agents never needed `filters.networks`.
- traderton commit `6c5189e` (2026-10-04, "E1-T T1", plan `traderton/docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/003-e1-agent-scan-loop-plan.md`) "copied `validateSwapScannerConfig`" to the profile boundary. It replaced the network source with `filters.networks?.[0]`.
- herobids' E1H-E3H plan (`docs/features/2026/09/18/001-trading-extraction-completion/plans/E1H-E3H-agent-wake-and-lifecycle-restore.md`) is the first caller to send `scanMode`/`creatorStrategy`, so it surfaced the regression. Its D3 premise is wrong: it says the `customTechnical` route carries "connection-merged filters (incl. networks)", but herobids never merges `networks`. Its T3 tests locked in the wrong behaviour (preset + scanner_gated on jupiter → `swap.network_unresolved`).

### What is NOT the cause

- **herobids filter merging.** `apps/api/src/agents/agent-create-normalization.ts` (step 7) and `apps/api/src/routes/agents.ts:1619` (PATCH) write only `venue`/`venueType` into `technical.filters`. That is correct, because herobids should not choose a chain. It doesn't own venue accounts, and the chain is traderton operator config.
- **herobids `deriveProfileScanConfig`** (`apps/api/src/agents/profile-scan-config.ts`). It forwards what it has; only its doc comment (lines 50-53) repeats the wrong D3 premise.
- **The docs/i18n "trading-wording-cleanup" work.** It touches no code on this path.
- **The prior bug `docs/bug-reports/2026/07/15/002-technical-scanner-filters-never-populated.md`** (CLOSED). It fixed `venue`/`venueType` for Hyperliquid and is unrelated to networks.

## Fix (implemented)

traderton, `packages/worker/src/tools/trading-profiles.ts`:

- `validateScanConfiguration` resolves the binding network the same way the runtime does: `resolveSwapNetwork(venue, undefined, params.oneInchConfig)`.
- `set_agent_trading_profile` passes `ctx.oneInchPriceChainConfig` as `oneInchConfig`. This is the operator `venues.1inch` `{ tokenSafetyNetwork, chainId }`, already present in the boundary tool context (`packages/boundary/src/bin.ts`, around line 548).
- `validateSwapScannerConfig` is unchanged. It still fails closed when no network resolves (for example, 1inch with no operator chain config), and it still enforces `filters.networks` as an exclusion filter and checks the canonical quote token.

traderton, `packages/domain/src/trading/tool-contract.ts`: the `oneInchPriceChainConfig` doc comment now records its second use, as the network source for profile validation.

Behaviour after the fix:

| Venue | Operator config | `filters.networks` | Result |
|---|---|---|---|
| jupiter | n/a | absent | resolves `solana` → passes (given canonical USDC on solana) |
| 1inch | `tokenSafetyNetwork: base` or `chainId: 8453` | absent | resolves `base` → passes (given canonical USDC on base) |
| 1inch | none | absent | `swap.network_unresolved` (fail closed) |
| 1inch | `base` | `['solana']` | `swap.network_excluded` |

`create-agents.sh`, `infra/hetzner/scripts/create-agents.sh` and the herobids create/PATCH paths need no change.

## Tests

`traderton/packages/worker/src/tools/trading-profiles.test.ts`:

- The test helper `context()` takes an optional `oneInchPriceChainConfig`, and a shared `SOLANA_AND_BASE_TOKENS` fixture was added.
- Replaced "rejects a preset creatorStrategy with scanner_gated on a swap venue (swap.network_unresolved)", which locked the bug in, with:
  - "accepts a preset creatorStrategy with scanner_gated on jupiter without filters.networks"
  - "accepts customTechnical with scanner_gated on 1inch when the operator config names the chain" (reproduces this bug)
  - "accepts a preset creatorStrategy with scanner_gated on 1inch resolved from the operator chainId"
  - "rejects scanner_gated on 1inch when the operator config has no chain (swap.network_unresolved)"
  - "ignores a creator filters.networks entry as the network source on 1inch" (→ `swap.network_excluded`)
- The first four new tests fail against the old code. The fifth passed incorrectly before, as `solana`.

Verified in traderton: `pnpm lint`, `pnpm build`, and `pnpm test` (170 files, 2959 passed, 0 failed). No integration test exercises this validation path, so `pnpm test:integration` was not run.

## Reproduction (pre-fix)

1. Bring up the xstack: `scripts/shell/run/reset-and-run-xstack.sh`.
2. Make sure the test user has a `1inch` connection (`quick-setup.sh` or `POST /setup/provider-link`).
3. `POST /agents` with the full payload from `build_t1inch_agent_payload` in `scripts/shell/run/create-agents.sh`. It is `capabilityMode: hybrid`, `hybridMode: scanner_gated`, `strategyPreset: range`, `executionVenue: 1inch`, plus the prompt, provider, models and `skillIds` the script sends.
4. Observe `400 validation_error` with the message above.

## Verification checklist

- [x] traderton fix and unit tests; traderton `pnpm lint`, `pnpm build` and `pnpm test` green.
- [ ] Rebuild and redeploy the traderton xstack boundary, then run `scripts/shell/run/reset-and-run-xstack.sh`. All 4 fixture agents (`thyper`, `t1inch`, `tintel`, `security-auditor`) should be created.
- [ ] `POST /agents` for a Jupiter `scanner_gated` agent returns 201.
- [ ] A PATCH that moves an agent onto a swap connection, or switches it to `scanner_gated`, also succeeds.
- [ ] Optional: start `t1inch` in shadow mode and confirm the scan loop runs on `base` (no `scanner.swap_*` startup errors in boundary logs).

## Follow-ups (not required for this fix)

- herobids `apps/api/src/agents/profile-scan-config.ts` doc comment (lines 50-53) and E1H-E3H D3: correct the premise. Swap agents don't need `filters.networks`; the network comes from traderton.
- E1H-E3H follow-up #3 ("preset identity for swap venues"): the network no longer has to travel in filters, so this may be unblocked. herobids could send `{presetKey, styleTier}` for swap agents too. Re-evaluate before changing D3, because `customTechnical` still works.
- Per-account chain for 1inch: traderton's profile validation and scan wiring both pass `binding = undefined`, so 1inch uses the operator chain only. If accounts on several chains are ever needed, supply a binding profile (`network`/`chainId`, which `resolveSwapNetwork` already reads) from traderton's `venue_accounts`. Do it in both places together so they stay in agreement.
- Mirror or link this report in `traderton/docs/bug-reports`, since the fix lives there.
