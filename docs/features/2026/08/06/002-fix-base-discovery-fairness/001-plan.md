# Fix Base Discovery Fairness And Network Semantics

## Objective

Fix the Base market-data failure so Base-bound discovery calls return real Base candidates reliably, and mixed-network discovery snapshots cannot suppress Base to zero when Base data exists.

This plan fixes the discovery layer itself. It does not try to paper over the problem in the swap scanner.

## Problem Statement

The 2026-08-05 investigation identified a real Base data failure, but the controlling bug is narrower and more concrete than "Base has no providers."

Today, `packages/market-data/src/discovery.ts` has two semantics problems:

1. A requested-network discovery call is not actually restricted to the requested networks.
   DexScreener discovery vectors (`token-boosts/top`, `token-boosts/latest`, `token-profiles/latest`) are global. Their results are merged into discovery without any post-fanout network filter, so a call like `discover({ networks: ['base'] })` can still be dominated by Solana tokens.

2. Multi-network discovery applies anti-staleness and `slice(0, maxResults)` on one flat cross-network list.
   When Solana contributes most of the top-ranked fresh tokens, Base can be pushed entirely below the global cut line even when Base tokens were discovered successfully. This explains the empty Base slice observed in the shared discovery snapshot.

There is also an observability weakness:

3. Rejected discovery fanout requests are now warned, but not with stable provider/network labels.
   This makes GeckoTerminal `base` rate limits visible only as generic warnings rather than actionable provider-health signals.

## Confirmed Root Cause

The controlling path is `packages/market-data/src/discovery.ts`.

- `discoverTokens()` always fans out to global DexScreener discovery endpoints.
- Those tokens are merged before any requested-network filter is applied.
- `RedisDiscoverySeenTracker.applyAntiStaleness()` preserves per-network stale sets, but the caller still slices one flattened result list afterward.
- `apps/worker/src/swap-candidate-discovery.ts` correctly asks for `networks: [swapNetwork]`, but the discovery layer does not currently honor that strictly.

This means the fix belongs in the shared discovery layer, not in the swap scanner or only in the market-intelligence coordinator.

## Goals

1. `discover({ networks: ['base'] })` must only return Base tokens.
2. `discover({ networks: ['solana', 'base'] })` must not allow one populated network to starve another to zero when both have qualifying tokens.
3. Anti-staleness must remain enabled and consistent across discovery consumers.
4. Provider failures must remain fail-soft, but operators must be able to tell which provider/network degraded.
5. The fix must preserve current public APIs where possible.

## Non-Goals

- Do not disable anti-staleness for swap scanners.
- Do not special-case Base only in scanner code.
- Do not add a hard-coded Base allowlist as the primary fix.
- Do not add a new provider in phase 1 unless the core discovery semantics are already corrected.

## Fix Design

### Phase 1 — Make requested networks authoritative

Add an explicit requested-network filter inside `discoverTokens()` after provider fanout and before merge/rank/slice.

Implementation shape:

1. Normalize requested networks to lowercase once at the top of `discoverTokens()`.
2. Filter all fulfilled provider results to `token.network` values present in the normalized requested-network set.
3. Keep DexScreener's global fanout, but treat it as a discovery source whose outputs must still satisfy the caller's network request.

Why this is first:

- It fixes the broken contract for Base-only calls immediately.
- It localizes the correction to the owning abstraction.
- It keeps DexScreener useful for all supported networks without adding a new provider yet.

### Phase 2 — Allocate discovery results per network before the final cut

Replace the single flat `slice(0, maxResults)` with a network-aware selection pass.

Proposed selection algorithm:

1. Keep the existing global merge, threshold filter, and score ordering.
2. Group the ordered tokens by network.
3. Apply anti-staleness within each network queue.
4. Reserve a fair baseline share for each requested network that has qualifying tokens.
   Suggested default: `floor(maxResults / activeNetworkCount)` with remainder filled afterward.
5. Fill any remaining slots from the leftover per-network queues using the existing score order.
6. Call `markSeen()` only on the final selected tokens, as today.

Key behavior:

- Base cannot be starved to zero in a mixed Solana+Base call when Base has qualifying tokens.
- Anti-staleness still rotates candidates within each network.
- High-liquidity networks can still consume unused remainder capacity.

Why not disable anti-staleness:

- The bug is starvation caused by global selection order, not anti-staleness itself.
- Disabling anti-staleness for swap scanning would create divergent discovery semantics across the platform.

### Phase 3 — Upgrade discovery observability

Refactor the fanout array in `discoverTokens()` so each request carries a stable label:

- provider
- network, when applicable
- vector or endpoint family

Then log rejected requests using those labels instead of a generic warning.

Expected outcome:

- A GeckoTerminal 429 on Base is logged as a Base-specific provider degradation.
- Operators can distinguish "Base returned zero because no tokens qualified" from "Base returned zero because the main Base provider failed."

This is especially important because the current code already warns on rejection, so the remaining gap is attribution, not silence.

### Phase 4 — Re-evaluate provider coverage after semantics are fixed

Only after phases 1 and 2 land, rerun the Base discovery path and decide whether a source expansion is still needed.

If Base remains materially under-supplied under normal rate-limit pressure, prefer a venue-aligned fallback source over an ad hoc allowlist.

Preferred follow-up option:

- Add a 1inch-supported-token discovery vector for 1inch networks, using the venue's own tradable universe as a supplementary source.

Why this is phase 4, not phase 1:

- The current evidence already shows Base tokens are discovered today; they are being mis-selected.
- Adding another provider before fixing selection semantics risks hiding the real bug and complicating validation.

## Implementation Plan

### Step 1 — Tighten network filtering in shared discovery

Files:

- `packages/market-data/src/discovery.ts`
- `packages/market-data/src/discovery.test.ts`

Changes:

- Add a helper to normalize and test requested networks.
- Filter fulfilled provider outputs to the requested networks before merge.
- Add a regression test proving that a Base-only discovery call drops Solana DexScreener results even when DexScreener returns them.

### Step 2 — Introduce network-aware final selection

Files:

- `packages/market-data/src/discovery.ts`
- `packages/market-data/src/discovery.test.ts`
- possibly `packages/market-data/src/discovery-seen-tracker.ts` only if a helper seam is needed

Changes:

- Extract the post-filter selection logic into a small helper so it can be unit-tested directly.
- Select per-network slices before the final cap.
- Preserve current sort semantics for within-network ordering and global remainder fill.
- Keep `markSeen()` on the final selected tokens only.

Tests:

- Mixed-network regression: when Solana has many qualifying tokens and Base has fewer, the final result still includes Base tokens.
- Anti-staleness regression: stale Base tokens are deprioritized within Base, but Base is not eliminated entirely.
- Existing tests around pre-slice `applyAntiStaleness()` and post-slice `markSeen()` continue to pass, updated only where semantics intentionally change.

### Step 3 — Add labeled rejection reporting

Files:

- `packages/market-data/src/discovery.ts`
- `packages/market-data/src/discovery.test.ts`
- optionally `apps/worker/src/market-intelligence/coordinator.ts` if source-health publication is extended

Changes:

- Wrap each fanout promise with metadata.
- Log provider, network, and vector when a request rejects.
- Optionally carry coarse source-health counts into the published discovery metadata in a follow-up patch if useful.

Tests:

- Rejection logging test for a Base GeckoTerminal request.
- Ensure mixed fulfilled/rejected fanout still returns usable discovery results.

### Step 4 — Validate downstream consumers

Files:

- `apps/worker/src/swap-candidate-discovery.test.ts`
- `apps/worker/src/market-intelligence/coordinator.ts` tests if present

Changes:

- Add a regression test showing the swap scanner can obtain Base candidates when discovery receives both noisy Solana DexScreener results and valid Base pool-backed tokens.
- Verify the coordinator's mixed-network snapshot keeps a non-zero Base slice when Base data exists.

## Validation

### Focused automated checks

1. `pnpm --filter @herobids/market-data run test`
2. `pnpm --filter @herobids/worker run test -- swap-candidate-discovery`
3. `pnpm lint`

### Behavior checks

1. Base-only discovery call returns only Base tokens.
2. Mixed `['solana', 'base']` discovery returns at least one Base token when Base providers supplied qualifying data.
3. A rejected GeckoTerminal Base request produces an attributed warning, not a generic one.
4. The 1inch swap scanner no longer logs `scanner.swap_discovery_empty` when Base candidates are available.

## Rollout Notes

- This should ship as one logical discovery-layer change, even if implemented in two small patches.
- Roll out to staging with the existing provider mix first.
- Re-run the t1inch/Base agent evaluation before adding any new provider.
- If Base still looks materially weak after the semantic fix, open a follow-up feature for a 1inch token-universe discovery source.

## Risks

1. A naive per-network reservation algorithm could over-allocate thin networks and reduce useful Solana coverage more than intended.
   Mitigation: reserve only for networks with qualifying tokens, then fill remainder globally.

2. Network normalization mismatches could accidentally drop valid tokens.
   Mitigation: normalize to lowercase consistently and cover expected network slugs in tests.

3. Changing final selection semantics will require updating some discovery tests that currently assume pure global ranking.
   Mitigation: keep the change local and write explicit regression tests for the new contract.

## Out of Scope

- Wake-consumer-group fixes from `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- Base-specific hard-coded fallback token lists
- Birdeye EVM expansion in the first implementation pass

## References

- `docs/tech/architecture/market-data.md`
- `docs/tech/market-data/market-data-discovery-diversification-knobs.md`
- `docs/bug-reports/2026/08/05/000-base-data-provision.md`
- `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- `docs/bug-reports/2026/08/05/002-investigation-t1inch-base-discovery.md`