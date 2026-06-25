# Shallow Solution

## Problem

Token age resolution fails for all major tokens (ETH, WBTC, SOL, WETH, HYPE) on the Base chain. This blocked agent `t1inch` for 55 minutes. 

The oracle should either:
- Fall back to the token creation timestamp from the chain if Birdeye fails
- Cache resolved ages for well-known tokens
- Support token-age safety overrides for whitelisted tokens (WBTC, WETH, cbBTC etc.)

## Root Cause Analysis

There are actually **two distinct bugs** causing the failure for different tokens.

### Bug 1 — Canonical tokens (ETH, WBTC, WETH) lose their synthetic fallback

In swap-token-resolver.ts, the canonical path splits into two branches:
- DexScreener **misses** the token → returns the synthetic fallback with `poolCreatedAt: '2020-01-01T00:00:00.000Z'` ✅
- DexScreener **finds** the token but without `poolCreatedAt` → returns `ageResolution: 'indeterminate'` with **no `poolCreatedAt`** ❌

```ts
if (exactMatch) {
  return {
    ...exactMatch,
    ageResolution: exactMatch.poolCreatedAt ? 'available' : 'indeterminate',  // ← drops synthetic fallback
    hasRealMarketData: true,
  };
}
```

Then in token-safety-adapter.ts:
```ts
const requiresAgeData = effectivePolicy.minTokenAgeHours > 0 || effectivePolicy.deadPoolMinAgeHours > 0;
if (requiresAgeData && !tokenData.poolCreatedAt) {
  // → "Token age could not be resolved for ETH on base"
```

`minTokenAgeHours: 24` and `deadPoolMinAgeHours: 720` are both non-zero in default.yaml, so `requiresAgeData` is always `true`. Any canonical token that DexScreener finds — but for which it omits `poolCreatedAt` (common for large, established pools) — falls into this failure path.

### Bug 2 — SOL and HYPE have no Base canonical entry

`SOL` is in the `solana` canonical list but not `base`. `HYPE` isn't in any canonical list. Both fall through to the symbol search path in DexScreener, which also produces no `poolCreatedAt` for well-established tokens.

---

## The Three Fix Options

### Option A — Fix the canonical path (minimal, highest-impact, covers ETH/WBTC/WETH)

In swap-token-resolver.ts, when a canonical DexScreener match lacks `poolCreatedAt`, inherit the synthetic timestamp instead of going `indeterminate`:

```ts
if (exactMatch) {
  return {
    ...exactMatch,
    // Operator-pinned canonical token: treat as established regardless of
    // whether DexScreener provides a pool creation date.
    poolCreatedAt: exactMatch.poolCreatedAt ?? '2020-01-01T00:00:00.000Z',
    ageResolution: 'available',
    isCanonical: true,
    hasRealMarketData: true,
  };
}
```

This is the most targeted fix with zero config changes. It restores the invariant that canonical = operator-trusted = age is not a gating concern.

### Option B — Add missing Base canonical entries (covers HYPE, any bridged token)

Add to default.yaml under `canonicalTokens.base`:

```yaml
HYPE:
  address: "0x..."   # HYPE ERC-20 address on Base
  name: HyperLiquid
  aliases: []
```

SOL on Base is non-standard (no canonical bridged form), so it probably shouldn't be traded via 1inch on Base at all — the venue routing issue is separate.

### Option C — `ageResolution: 'available'` bypass for whitelisted tokens in the adapter

In token-safety-adapter.ts, change the gate condition to respect `isCanonical`:

```ts
const requiresAgeData = (effectivePolicy.minTokenAgeHours > 0 || effectivePolicy.deadPoolMinAgeHours > 0)
  && !tokenData.isCanonical;  // canonical tokens are operator-trusted, skip age gate
```

This is a defence-in-depth approach — it catches the case in Option A and any future canonical path that accidentally omits `poolCreatedAt`.

---

## Recommended approach

**A + C together** is the right fix. Option A fixes the data path (canonical match should always carry the synthetic timestamp), and Option C adds a safety net at the enforcement layer so a future code path can't accidentally re-introduce the issue for any canonical token. Option B is a separate config change for HYPE specifically, once you confirm its Base chain address.

The `SOL on Base` failures are probably a different problem — a venue routing issue or the agent mistakenly routing a Solana-native token through an EVM chain — not a token-age oracle bug.