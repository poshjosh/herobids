# Fix Base Discovery Supply, Network Semantics, And Observability

## Objective

Make Base-bound discovery calls return real Base candidates reliably. The primary
blocking symptom — the t1inch swap scanner producing zero Base candidates — is a
**supply** failure caused by GeckoTerminal free-tier rate limits, not a fairness
bug. This plan therefore restores Base supply first, then corrects the network
contract and provider-failure attribution.

This plan fixes the discovery layer and its upstream provider tier. It does not
paper over the problem in the swap scanner, and it does not use a hard-coded Base
allowlist.

## Decision Summary (agreed scope)

We are implementing three changes and deferring one. This ordering reflects the
actual failure mode: the swap scanner calls discovery with a **single** network,
so per-network fairness cannot help it — only restoring Base provider supply can.

| Phase | Change | Status | Why |
|---|---|---|---|
| **Phase 4** | Restore Base supply via a paid CoinGecko on-chain (GeckoTerminal) tier | **DO — primary fix** | Removes the free-tier 429s that were dropping all Base pools. This is the only change that makes Base data actually appear for a single-network call. |
| **Phase 1** | Make requested networks authoritative (post-fanout network filter) | **DO — correctness** | Stops a Base-only call returning Solana DexScreener tokens. Correctness bug, independent of rate limits. |
| **Phase 3** | Labeled provider/network rejection observability | **DO — cheap insurance** | The original incident was hard to diagnose *because* rejections were silent/unlabeled. Near-zero breakage risk. |
| **Phase 2** | Per-network fair allocation before the final cut | **DEFER** | Only benefits mixed-network callers (coordinator snapshot, multi-network tool calls). Never helped the single-network swap scanner. Highest breakage risk (rewrites shared selection). Its value largely evaporates once Phase 4 restores supply. Revisit only if the mixed snapshot still starves Base after Phase 4. |

## Problem Statement

The 2026-08-05 investigation identified a real Base data failure. There are **two
distinct consumers** with **two distinct failure modes**, which earlier framing
conflated:

- **Single-network consumer (the blocked one):** the t1inch swap scanner calls
  `discovery.discover({ networks: ['base'] })` — always exactly one network
  (`apps/worker/src/swap-candidate-discovery.ts`). It hits the registry directly
  with a Base-only cache key; it does **not** read the coordinator snapshot. For a
  single-network call, any per-network fairness allocation is a no-op. Its
  emptiness is a **supply** failure: GeckoTerminal is the only per-network Base
  provider and its free tier 429s, so Base pools are dropped and the scanner sees
  zero candidates.

- **Mixed-network consumer (the evidence, not the blocked path):** the
  market-intelligence coordinator refreshes `discover({ networks: ['solana',
  'base'] })` and publishes `by-network:base`. A flat `slice(0, maxResults)` over a
  Solana-dominated list can push Base below the cut, producing the empty Base
  slice seen in Redis. This is real but it is **not** what the swap scanner reads.

Three concrete defects underlie these:

1. **Supply (primary).** GeckoTerminal free tier is rate-limited to 10 req/min
   (`config/default.yaml → marketData.geckoterminal.discovery.requestsPerMinute:
   10`). With 2 networks × 3 discovery endpoints, Base requests are structurally
   over budget and 429 under load, so Base results are silently dropped. This is
   the confirmed proximate cause of the swap scanner's zero-candidate state.

2. **Network contract (correctness).** DexScreener discovery vectors
   (`token-boosts/top`, `token-boosts/latest`, `token-profiles/latest`) are global
   and merged with no post-fanout network filter, so `discover({ networks:
   ['base'] })` can still return Solana tokens.

3. **Attribution (observability).** Rejected fanout requests are now warned, but
   only with `err.message` / `err.name` — no provider/network label. A
   GeckoTerminal 429 on Base is indistinguishable from any other failure, and the
   swap scanner's own `scanner.swap_discovery_empty` log carries no cause.

## Confirmed Root Cause

Verified against the current code:

- **Supply:** `packages/market-data/src/geckoterminal.ts` hits the public endpoint
  `https://api.geckoterminal.com/api/v2/networks/{network}/...` with only an
  `Accept` header and no API key. Under the 10 req/min free budget it 429s on
  Base. It is the sole per-network Base provider; DexScreener global vectors are
  Solana-dominated and do not compensate.
- **Network contract:** `discoverTokens()` in
  `packages/market-data/src/discovery.ts` fans out to global DexScreener endpoints
  and merges them with no requested-network filter; only a liquidity threshold and
  score sort are applied before `slice(0, maxResults)`.
- **Attribution:** the rejection loop in `discoverTokens()` logs `err.message` and
  `err.name` only — no stable provider/network/vector label.

The fix therefore spans the provider tier (Phase 4) and the shared discovery layer
(Phases 1 and 3), not the swap scanner.

## Goals

1. The t1inch swap scanner obtains real Base candidates under normal rate-limit
   pressure (i.e. Base supply is restored, not just re-selected).
2. `discover({ networks: ['base'] })` returns only Base tokens.
3. Provider failures remain fail-soft, but operators can tell which
   provider/network degraded — including at the swap-scanner layer.
4. Anti-staleness remains enabled and consistent across discovery consumers.
5. Current public discovery APIs are preserved where possible.

## Non-Goals

- Do not disable anti-staleness for swap scanners.
- Do not special-case Base only in scanner code.
- Do not add a hard-coded Base allowlist.
- Do not implement per-network fair allocation (Phase 2) in this pass — see
  Deferred section for the conditions that would reopen it.

## Fix Design

### Phase 4 (primary) — Restore Base supply via a paid CoinGecko on-chain tier

GeckoTerminal is CoinGecko's on-chain DEX product. The paid CoinGecko API exposes
the same trending/top/new-pool data under `/api/v3/onchain/...` with far higher
rate limits. Subscribing to the **Basic** plan ($29/mo billed yearly; 100k
credits/mo; 300 req/min) removes the free-tier 429s that were dropping Base pools.
This is the change that actually makes Base data appear for a single-network call.

Integration shape (no new adapter — reuse the existing GeckoTerminal client):

1. Add an optional `apiKey` field to `GeckoTerminalConfig`
   (`packages/market-data/src/geckoterminal.ts`).
2. When `apiKey` is present:
   - target the Pro on-chain base URL (`https://pro-api.coingecko.com`) and the
     `/api/v3/onchain/networks/{network}/...` path prefix instead of
     `https://api.geckoterminal.com/api/v2/networks/{network}/...`;
   - send the `x-cg-pro-api-key: <key>` header on every request (the adapter
     currently sends only `Accept`).
   Keep the free public path as the default when no key is configured, so local
   dev and unconfigured operators still work fail-soft.
3. Raise `marketData.geckoterminal.discovery.requestsPerMinute` from `10` to a
   value that clears the 2-network × 3-endpoint demand (e.g. 60), well within the
   300 req/min plan ceiling.
4. Route the key through operator config, not ad hoc env reads: add
   `geckoterminal.apiKey` to the market-data schema (Zod) and source it from a
   secret env override (e.g. `COINGECKO_API_KEY`). Follow the existing paid-provider
   pattern (CoinMarketCap/Birdeye): `enabled`/key mismatch is a loud startup error.

Credit-budget guardrail:

- **Do not lower** `geckoterminal.discovery.cacheTtlMs` (currently 300000 = 5 min).
  The coordinator polls every 30s but mostly hits cache; the 5-minute cache is what
  keeps upstream discovery calls (~6 per 5 min) inside the 100k-credit/mo Basic
  budget. Add a note to monitor credit consumption after rollout.

Why this is first: it is the only change that addresses the confirmed proximate
cause (Base supply). Phases 1 and 3 are correctness/observability and cannot, by
themselves, make Base tokens appear on a rate-limited single-network call.

### Phase 1 — Make requested networks authoritative

Add an explicit requested-network filter inside `discoverTokens()` after provider
fanout and before merge/rank/slice.

Implementation shape:

1. Normalize requested networks to lowercase once at the top of `discoverTokens()`.
2. Filter all fulfilled provider results to `token.network` values present in the
   normalized requested-network set.
3. Keep DexScreener's global fanout, but treat it as a discovery source whose
   outputs must still satisfy the caller's network request.

Normalization safety (addresses the real hazard):

- The risk is not casing — it is **slug divergence** between adapters. Before
  landing the filter, verify the exact `token.network` values each adapter emits:
  DexScreener `chainId` (e.g. `base`, `solana`, `ethereum`) vs GeckoTerminal
  network slug. They already share the `network:address` merge key, so they are
  expected to agree, but a mismatch would silently drop **all** tokens for a
  network. Cover the concrete slugs in tests rather than assuming lowercasing is
  sufficient.

Interaction with fail-soft (LOW note 9): after this filter, if only Solana
DexScreener succeeds on a Base-only call, `fulfilled.length > 0` so no throw is
raised, and the Base post-filter yields `[]`. That is correct fail-soft behavior;
Phase 3 provides the attribution so the empty result is explainable.

### Phase 3 — Labeled provider/network rejection observability

Refactor the fanout array in `discoverTokens()` so each request carries a stable
label, then log rejected requests using those labels instead of a generic warning.

- Wrap each fanout promise with metadata: `provider`, `network` (when
  applicable), and `vector` / endpoint family. Note that GeckoTerminal is fanned
  out per-network via currently-anonymous promises, so the wrapping is required to
  attribute a Base 429.
- Thread cause to the scanner layer: when
  `apps/worker/src/swap-candidate-discovery.ts` logs
  `scanner.swap_discovery_empty`, include a coarse discovery source-health summary
  so operators can distinguish "no Base tokens qualified" from "Base provider
  429'd" without cross-referencing two logs.

Expected outcome: a GeckoTerminal 429 on Base is logged as a Base-specific
provider degradation, at both the discovery layer and the scanner layer.

### Deferred — Phase 2: per-network fair allocation

Not implemented in this pass. Recorded here so the deferral is explicit and the
reopening conditions are unambiguous.

What it would do: replace the flat `slice(0, maxResults)` with a network-aware
selection that reserves a baseline share per requested network
(`floor(maxResults / activeNetworkCount)`), then fills the remainder globally.

Why deferred:

- **It does not help the blocked consumer.** The swap scanner calls discovery with
  a single network, so per-network allocation is a no-op for it. Only Phase 4 fixes
  its symptom.
- **Its value is marginal once Phase 4 lands.** The mixed-snapshot starvation was
  driven by Base 429s plus Solana dominance; restoring Base supply removes most of
  the pressure.
- **It carries the highest breakage risk.** It rewrites the core selection path
  that *every* discovery consumer shares (coordinator, all swap scanners, the
  `discover_tokens` tool).

Known implementation traps to capture for whoever picks this up later:

- **`applyAntiStaleness()` partitions globally.**
  `RedisDiscoverySeenTracker.applyAntiStaleness()` groups by network internally but
  returns a single flattened `[...fresh, ...stale]` across all networks. Per-network
  selection must call it per network list or re-group its output — a real helper
  seam, not optional.
- **The re-marking loop makes anti-staleness inert for thin, high-frequency
  scanners.** Base tokens are re-`markSeen()`'d every scan (~60s), so a small Base
  universe is permanently inside the 4h cooldown and never rotates — anti-staleness
  provides no diversity benefit there, it just churns. Any Phase 2 work should
  decide whether that is acceptable or whether marking cadence should be decoupled
  from scan cadence.
- **Cross-consumer cache divergence.** Swap scanner (single-network), coordinator
  (mixed), and `discover_tokens` (variable) use different cache keys, so per-call
  fairness cannot rebalance across separately-cached calls.

Reopen Phase 2 only if, after Phase 4, the coordinator's mixed `['solana','base']`
snapshot still starves Base to zero when Base has qualifying tokens.

## Implementation Plan

Ordered by the agreed scope: supply first, then correctness, then observability.

### Step 1 (Phase 4) — Paid CoinGecko on-chain tier for GeckoTerminal [DONE]

Files:

- `packages/market-data/src/geckoterminal.ts`
- market-data config schema (Zod) for `marketData.geckoterminal`
- `config/default.yaml` (raise `discovery.requestsPerMinute`; keep `cacheTtlMs`)
- provider-registry wiring where `GeckoTerminalConfig` is constructed
- `packages/market-data/src/geckoterminal.test.ts`

Changes:

- Add optional `apiKey` to `GeckoTerminalConfig`; when present, switch base URL to
  `https://pro-api.coingecko.com`, the path prefix to `/api/v3/onchain/networks/…`,
  and add the `x-cg-pro-api-key` header. Default to the free public endpoint when
  no key is set.
- Add `geckoterminal.apiKey` to the config schema, sourced from a secret env
  override (`COINGECKO_API_KEY`); reuse the paid-provider startup-validation pattern.
- Raise `geckoterminal.discovery.requestsPerMinute` to clear demand; leave
  `cacheTtlMs` at 300000 to stay within the 100k-credit budget.

Tests:

- With a key configured, requests target the Pro on-chain URL and carry the
  `x-cg-pro-api-key` header.
- Without a key, requests target the free public endpoint unchanged (no
  regression for local dev).

### Step 2 (Phase 1) — Tighten network filtering in shared discovery [DONE]

Files:

- `packages/market-data/src/discovery.ts`
- `packages/market-data/src/discovery.test.ts`

Changes:

- Add a helper to normalize and test requested networks.
- Filter fulfilled provider outputs to the requested networks before merge.
- First verify the concrete `token.network` slugs DexScreener and GeckoTerminal
  emit for `base`/`solana`; encode those exact values in tests.

Tests:

- A Base-only discovery call drops Solana DexScreener results even when DexScreener
  returns them.
- Concrete-slug test guarding against silent drop from slug divergence.

### Step 3 (Phase 3) — Labeled rejection reporting + scanner attribution [DONE]

Files:

- `packages/market-data/src/discovery.ts`
- `packages/market-data/src/discovery.test.ts`
- `apps/worker/src/swap-candidate-discovery.ts`
- `apps/worker/src/swap-candidate-discovery.test.ts`

Changes:

- Wrap each fanout promise with `{ provider, network, vector }` metadata; log those
  labels when a request rejects.
- Include a coarse discovery source-health summary in the
  `scanner.swap_discovery_empty` log so the empty result is explainable at the
  scanner layer.

Tests:

- A rejected GeckoTerminal Base request produces an attributed warning, not a
  generic one.
- Mixed fulfilled/rejected fanout still returns usable discovery results.
- `scanner.swap_discovery_empty` carries provider-cause context.

### Step 4 — Validate downstream consumers [DONE]

Files:

- `apps/worker/src/swap-candidate-discovery.test.ts`
- coordinator tests if present

Changes:

- Regression test showing the swap scanner obtains Base candidates when discovery
  receives both noisy Solana DexScreener results and valid Base pool-backed tokens.
- Reproduce the failing condition: with GeckoTerminal Base returning 429 and no key
  configured, assert the scanner logs an *attributed* empty result; with a paid key
  simulated (Base pools returned), assert the scanner obtains non-empty Base
  candidates.

## Validation

### Focused automated checks

1. `pnpm --filter @herobids/market-data run test`
2. `pnpm --filter @herobids/worker run test -- swap-candidate-discovery`
3. `pnpm lint`

### Behavior checks

1. With a paid CoinGecko key configured, a Base-only discovery call returns a
   non-empty set of real Base tokens under normal rate-limit pressure.
2. Reproduce-the-bug check: with GeckoTerminal Base forced to 429, the swap scanner
   emits an **attributed** `scanner.swap_discovery_empty` (provider-cause visible),
   not a bare empty log.
3. `discover({ networks: ['base'] })` returns only Base tokens (no Solana
   DexScreener leakage).
4. A rejected GeckoTerminal Base request produces a provider/network-attributed
   warning.
5. On staging with the paid key, the t1inch/Base agent's scanner emits candidates
   and the agent activates.

## Rollout Notes

- Land Phase 4 (config + adapter) together with the CoinGecko subscription; the key
  is an operator secret, deployed via env override.
- Ship Phases 1 and 3 in the same discovery-layer change set.
- Roll out to staging, provision the key, then re-run the t1inch/Base agent
  evaluation and confirm non-empty Base candidates.
- Monitor CoinGecko credit consumption after rollout; do not lower the discovery
  cache TTL without re-checking the 100k-credit/mo budget.
- Keep the Phase 2 deferral documented; reopen only if the mixed coordinator
  snapshot still starves Base after supply is restored.

## Risks

1. **Slug divergence between adapters silently drops a whole network.**
   Mitigation: verify concrete `token.network` values from each adapter and cover
   them in tests; do not rely on lowercasing alone.

2. **Credit-budget overrun on the Basic plan.**
   Mitigation: keep the 5-minute discovery cache; monitor credit usage; overage is
   metered ($0.0005/call) so a spike is recoverable, not a hard outage.

3. **Adapter dual-mode (free vs paid) regressions.**
   Mitigation: keep the free public path as the untouched default; add explicit
   tests for both configured and unconfigured modes.

4. **Deferring Phase 2 leaves the mixed snapshot theoretically starvable.**
   Mitigation: accepted — supply restoration removes the dominant pressure;
   reopening conditions are documented above.

## Out of Scope

- Per-network fair allocation (Phase 2) — deferred, see Fix Design.
- Wake-consumer-group fixes from
  `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`.
- Base-specific hard-coded fallback token lists.
- Birdeye EVM expansion and a 1inch token-universe discovery vector — possible
  future supplementary sources, not needed once the paid GeckoTerminal tier
  restores Base supply.

## References

- `docs/tech/architecture/market-data.md`
- `docs/tech/market-data/market-data-discovery-diversification-knobs.md`
- `docs/bug-reports/2026/08/05/000-base-data-provision.md`
- `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- `docs/bug-reports/2026/08/05/002-investigation-t1inch-base-discovery.md`

## Outstanding Issues

### [Step 1] Medium — proBaseUrl config wiring (RESOLVED)
Fixed: `proBaseUrl` was added to `MarketDataConfig.geckoterminal` and wired through `provider-registry.ts`.

### [Step 3] Medium — Scanner attribution is a static hint, not threaded cause
The `SwapDiscoveryPort` interface returns only `{ data: [] }` — no structured rejection metadata. The enhanced scanner log mentions both possible causes in one message. To truly distinguish provider failure from no qualifying tokens, `SwapDiscoveryPort` would need to carry `rejectionSummary`. Accepted as scope limitation. Follow-up task filed.

### [Step 3] Medium — Missing DexScreener token assertion in mixed-failure test
The "returns usable results when one provider fails but others succeed" test verifies GeckoTerminal Solana token but not the DexScreener boost token (`mixed-addr`). Adding an explicit assertion would guard against accidental exclusion of DexScreener-sourced tokens.

### [Step 1] Low — String-replace URL path transformation is fragile
`buildGeckoUrl()` in `geckoterminal.ts` uses `v2Path.replace('/api/v2/networks/', '/api/v3/onchain/networks/')` which assumes all future v2 paths match this prefix. Works for all current call sites and covered by tests. Refactor if a future path variant doesn't match.

### [Gap Analysis] Medium — validateApiKey AbortError not caught
`validateApiKey()` doesn't catch `AbortError` from timeout — throws raw `DOMException` instead of a descriptive message. Startup-edge-case polish item.

### [Gap Analysis] Low — Slug tests only cover solana/base
Add concrete-slug test when third network enters production.

### [Gap Analysis] Low — proBaseUrl not in default.yaml
Add commented-out entry for discoverability.

### [Gap Analysis] Low — No topPools pro-URL test
Optional: add when test file is next touched.
