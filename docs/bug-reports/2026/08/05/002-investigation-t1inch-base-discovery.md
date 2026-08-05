# Investigation: t1inch swap scanner returns zero candidates (Issue 2)

- **Status:** INVESTIGATED — root cause refined, fix not yet implemented
- **Date:** 2026-08-05
- **Related bug report:** `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- **Affected agent:** `t1inch` (`66664f0b-d3bf-47ab-beb9-20ef3394b450` on staging; `c08196b0-eda6-4943-bcbb-4198e0ce8405` on local dev)
- **Symptom:** The t1inch swap scanner (network `base`) produces **zero candidates** (`candidatesDiscovered: 0`, `scannerHealth: no_candidates`), so no scanner wake is emitted and the agent never activates.

## Summary

The t1inch swap scanner calls `registry.discovery.discover({ networks: ['base'] })`, which returns **zero base tokens**. This was confirmed on both staging and local dev:

- Worker log: `"Swap scanner discovery returned no tokens"` (`scanner.swap_discovery_empty`) every 60s.
- Redis `market-intel:discovery:latest` → **45 tokens, all solana, 0 base**.
- Redis `market-intel:discovery:meta` → `networkCounts: {"solana": 45}`.

## Root cause (refined)

The investigation confirms the **antistaleness suppression** hypothesis and identifies a **second contributing factor** (silent provider-failure swallowing).

### Confirmed: base tokens ARE discovered, then suppressed by antistaleness

- Redis `market-data:discovery:seen:base` zset has **62 entries** — base tokens were discovered and marked seen.
- The current discovery snapshot has **0 base tokens**.
- `discoverTokens()` (`packages/market-data/src/discovery.ts:210`) applies `applyAntiStaleness()` (moves recently-seen tokens to the end) then `slice(0, maxResults)` (default 50). With 45 solana tokens filling the limit, base tokens (always within the 4h cooldown because they're continuously re-discovered) are pushed to the end and sliced off.

This **disproves the silent-failure hypothesis as the sole cause** — base tokens are reaching the discovery pipeline; they're being filtered out downstream.

### Contributing factor: geckoterminal rate-limiting silently drops base results

- `discoverTokens()` uses `Promise.allSettled` (`packages/market-data/src/discovery.ts:160`) and **silently drops rejected provider results** — no logging.
- `fetchJson()` (`packages/market-data/src/http.ts`) throws `HttpError` on non-OK responses (e.g. 429) and `AbortError` on timeout.
- Geckoterminal is the **primary per-network provider for base** (dexscreener's discovery vectors are mostly solana). When geckoterminal returns 429 (rate-limited — confirmed via direct curl), the base results are silently dropped.
- Dexscreener returns 200 (works) but its discovery vectors are predominantly solana, so it does not compensate for the missing base tokens.

**Net effect:** base discovery is doubly fragile — (1) geckoterminal rate-limits silently drop base results, and (2) even when base tokens are discovered, antistaleness suppresses them from the snapshot.

## Evidence

| Check | Result |
|---|---|
| `market-intel:discovery:meta` | `networkCounts: {"solana": 45}`, 0 base |
| `market-data:discovery:seen:base` | 62 entries (base tokens were discovered) |
| geckoterminal `base/trending_pools` | HTTP 429 (rate-limited) |
| geckoterminal `base/pools?sort=h24_volume_usd_desc` | HTTP 429 (rate-limited) |
| dexscreener `token-boosts/latest/v1` | HTTP 200 (works) |
| Worker log | `"Swap scanner discovery returned no tokens"` every 60s |

## Why the fix is non-trivial

1. **Two contributing causes**, not one — a fix must address both the antistaleness suppression AND the silent provider-failure swallowing.
2. **Antistaleness is a deliberate diversity feature** shared across all discovery consumers (market-intel coordinator, all swap scanners, `discover_tokens` tool). Changing it risks breaking diversity/rotation for other agents.
3. **The silent `Promise.allSettled` swallowing** is a systemic observability gap — it hides provider failures across all discovery consumers, not just base.
4. **Per-network fairness** — solana dominates discovery; base needs reserved capacity or a separate budget.

## Recommended fix directions (for a future plan)

1. **Per-network `maxResults`** — reserve slots for base so solana cannot starve it. **Preferred.** This keeps antistaleness consistent across all scanners while fixing the starvation.
2. **Log rejected provider results in `discoverTokens`** — surface geckoterminal/dexscreener failures instead of silently dropping them (observability fix). **Recommended** — low effort, high yield.
3. **Separate discovery budget per network** — most robust but most invasive.

### Discouraged: "Skip antistaleness for swap-scan discovery"

This option is **discouraged** and should not be pursued as the primary fix:

- **Inconsistency.** It would make swap-scan discovery behave differently from orderbook-scan discovery for no principled reason. The orderbook scanner (thyper/Hyperliquid) applies antistaleness; the swap scanner (t1inch/base) would not. Two scanners would rotate candidates differently.
- **Antistaleness is a deliberate, shared diversity feature.** It prevents the same top tokens (WETH, USDC, cbBTC) from dominating every scan. Disabling it for swap scanners would re-surface the same blue-chips every cycle, defeating the scanner's purpose of finding fresh candidates.
- **It treats the symptom, not the cause.** The real problem is that antistaleness + a shared `maxResults` budget lets solana starve base to **zero**. The correct fix is per-network budget (option 1), which lets antistaleness rotate *within* each network's allocation instead of wiping base out entirely.

If a short-term unblock is needed while the per-network budget is implemented, a **shorter cooldown for swap scanners** (rather than fully skipping antistaleness) is a less-bad intermediate — but it still diverges from the orderbook path and should be temporary.

## References

- Bug report: `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- Tech doc: `docs/tech/agents/wake-signal-and-technical-scan.md`
- Key source: `packages/market-data/src/discovery.ts`, `packages/market-data/src/http.ts`, `packages/market-data/src/geckoterminal.ts`, `packages/market-data/src/discovery-seen-tracker.ts`, `apps/worker/src/swap-candidate-discovery.ts`
