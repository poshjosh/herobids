# 001 — Agent Decisions Produce No Trades: Token Safety and Trade History Bugs

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-17
- **Affected agent:** `63d1f7c1-2afa-4c72-8505-aa3017b35827` (t1inch, shadow mode)
- **Summary:** Agent has 6 `go_long` decisions in "recent decisions" but zero fills and zero positions in "trade history". Two independent bugs: (1) all decisions fail the swap token safety check because `resolveSwapTokenData` returns `null` for canonical tokens when DexScreener search yields no results, and (2) the trade history endpoint only queries `actorType='bot'` fills, missing agent-native fills.

---

## Observed Symptoms

- UI Trade History shows "No trade history yet" despite 6 decisions visible in recent decisions.
- Database: `decisions` = 6 rows, `fills` = 0, `positions` = 0, `execution_plans` = 6 (all `status='failed'`).
- Decision failures:
  - 4× `token.not_found` — "Token ETH on base could not be resolved"
  - 1× `token.not_found` — "Token HYPE on base could not be resolved"
  - 1× `risk.max_position_size_pct_exceeded` — 5000 BTC notional ($329M) vs $1,000 equity

---

## Root Cause

### Bug 1 — Token Safety Fails for Canonical Tokens

`resolveSwapTokenData()` in `apps/worker/src/index.ts` performs a canonical token lookup (operator-configured whitelist mapping e.g. ETH → WETH on Base), then searches DexScreener with the resolved address. If DexScreener returns no exact-match results (due to rate limits, API changes, or transient errors), the function returns `null` — triggering a `token.not_found` rejection.

The operator had configured `ETH` as a canonical alias for `WETH` on the `base` network. The canonical lookup correctly resolved ETH → WETH address. However, when DexScreener failed to return matching results for the WETH address on Base (possibly due to rate limiting across multiple concurrent agents), the entire resolution failed — even though the token is explicitly whitelisted.

**Why DexScreener search failed:** Not definitively determined from static analysis, but the most likely cause is DexScreener rate limiting across multiple agents making concurrent calls. The worker is running 3 agents, all making market data calls, which can exhaust the 30 req/min DexScreener budget.

### Bug 2 — Trade History Endpoint Misses Agent-Native Fills

`GET /agents/:id/trades` in `apps/api/src/routes/agent-interactivity.ts` only queried fills with `actorType='bot'` AND `actorId IN (agentBotIds)`. Agent-native fills (where `actorType='agent'` and `actorId` is the agent's own ID) were never returned. Even if Bug 1 were fixed and decisions produced fills, they would not appear in the trade history.

### Contributing Factor — Sizing

One decision was also rejected by the risk gate for proposing 5000 BTC (~$329M notional) with $1,000 capital. This is a prompt-level issue (tracked separately in bug `009`).

---

## Fix

### Fix 1 — Canonical Token Fallback in `resolveSwapTokenData`

**File:** `apps/worker/src/index.ts`

When `lookupCanonical()` resolves a token AND DexScreener returns no exact match, construct a synthetic `ResolvedSwapTokenData` from the canonical entry with safe defaults (max liquidity, max volume, old pool creation date) so the safety check passes. Canonical tokens are explicitly whitelisted by the operator and do not require external verification.

```typescript
if (!exactMatch) {
    // If the token was resolved via operator-configured canonical lookup,
    // construct synthetic token info with safe defaults.
    if (canonical) {
      return {
        address: canonical.address,
        symbol: canonical.symbol,
        name: canonical.name,
        network: network.toLowerCase(),
        priceUsd: 0,
        volume24hUsd: Number.MAX_SAFE_INTEGER,
        liquidityUsd: Number.MAX_SAFE_INTEGER,
        priceChange24hPct: 0,
        dexId: 'canonical',
        poolCreatedAt: '2020-01-01T00:00:00.000Z',
        ageResolution: 'available',
      };
    }
    return null;
  }
```

### Fix 2 — Trade History Includes Agent-Native Fills

**File:** `apps/api/src/routes/agent-interactivity.ts`

Changed the query from `actorType='bot'` only to `(actorType='agent' AND actorId=$agentId) OR (actorType='bot' AND actorId IN $agentBotIds)`. This ensures both agent-native fills and bot fills appear in trade history.

Also added `or` to the drizzle-orm import.

---

## Files Changed

| File | Change |
|---|---|
| `apps/worker/src/index.ts` | Canonical token fallback: construct synthetic `ResolvedSwapTokenData` when DexScreener search yields no results for a canonical token |
| `apps/api/src/routes/agent-interactivity.ts` | Include agent-native fills (`actorType='agent'`) in trade history query alongside bot fills |

---

## Verification

- `pnpm lint` (tsc --noEmit) — passes for both worker and api packages.
- `pnpm --filter @herobids/worker exec vitest run src/agents/agent-intake-resolver.test.ts` — all 20 tests pass.
- Manual verification: after re-deploying, agent decisions for canonical tokens (ETH/USDC on Base) should pass token safety and produce paper fills, which should appear in trade history.

## Remaining Work

- **HYPE on Base:** The agent attempted to trade `HYPE/USDC` on the 1inch/Base venue. HYPE is a Hyperliquid-native token and does not exist on Base DEXes. The agent should be reconfigured to use the Hyperliquid venue for HYPE trading, or HYPE should be removed from its instrument list.
- **Prompt sizing:** The agent needs explicit guidance that `targetSize` is token quantity (not USD notional). Tracked separately in bug `009`.
- **DexScreener rate limit investigation:** Root cause of search failures for canonical addresses should be investigated. Possible mitigations: increase rate limit budget, add retry with backoff, or cache canonical token DexScreener results longer.
