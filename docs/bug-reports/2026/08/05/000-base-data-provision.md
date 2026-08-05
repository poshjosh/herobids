# How to fix having no `Base` data

## Problem

Swap Discovery Has Zero `Base` Network Tokens

---

Here's how the discovery pipeline works and why Base has no data:

## The Discovery Pipeline

The swap scanner calls `sharedMarketDataRegistry.discovery.discover({ networks: ["base"], ... })` which fans out to 4 providers:

```
discoverTokens(config)
  ├── DexScreener (GLOBAL — not network-filtered)
  │     ├── /token-boosts/top/v1       → "trending" tokens
  │     ├── /token-boosts/latest/v1    → "latest boosted" tokens
  │     └── /token-profiles/latest/v1  → "latest profiles"
  │
  ├── GeckoTerminal (PER-NETWORK — called with network="base")
  │     ├── /api/v2/networks/base/trending_pools
  │     ├── /api/v2/networks/base/pools?sort=h24_volume_usd_desc
  │     └── /api/v2/networks/base/new_pools
  │
  ├── CoinMarketCap (network-filtered)
  │     ├── Trending (filtered to ["base"])
  │     └── New listings (filtered to ["base"])
  │
  └── Birdeye (Solana ONLY — skipped for Base)
        └── Skipped: `networks.includes('solana')` guard
```

## Why Base Returns Empty

Each provider has a gap:

| Provider | Issue |
|----------|-------|
| **DexScreener** | Trending/boosts endpoints are **Solana-dominated**. The `/token-boosts/top/v1` endpoint returns memecoin ecosystem tokens — almost exclusively Solana. Base tokens rarely appear in global DexScreener trending. |
| **GeckoTerminal** | Called for `network="base"` but the **free tier may not return meaningful results** for Base. GeckoTerminal's free API has rate limits and may deprioritize non-Solana networks. Even if it returns data, Base pools rarely meet the volume/liquidity bar. |
| **CoinMarketCap** | Free tier **trending/new endpoints have limited multi-chain data**. CMC's trending is market-cap weighted (BTC, ETH, top 100) — Base-native tokens rarely appear. |
| **Birdeye** | **Hard-coded to Solana only** in line 151: `networks.includes('solana')`. EVM chain support exists in Birdeye's API but isn't wired up. |

## How to Get Base Data

There are several approaches, roughly in order of effort:

### 1. Enable Birdeye for EVM Chains (lowest effort)
Birdeye's API supports EVM chains (Base, Ethereum, etc.) — the code just needs the Solana-only guard removed:

```typescript
// packages/market-data/src/discovery.ts line ~151
// Current:
const birdeyeFanOut = config.birdeye && networks.includes('solana')
  ? [fetchBirdeyeTrending('solana', config.birdeye)]
  : [];

// Change to also support base:
const birdeyeFanOut = config.birdeye
  ? networks.map(n => fetchBirdeyeTrending(n, config.birdeye))
  : [];
```

Birdeye has a `/defi/token_trending` endpoint that accepts a `chain` parameter including `base`.

### 2. Add 1inch's Own Token List (medium effort)
1inch has its own token list API — the tokens it actually supports for swaps:
- `https://api.1inch.dev/token/v1.2/8453/search` (Base chain)
- This would give you the exact tokens that 1inch can swap on Base, which is exactly what the scanner needs.

### 3. Add CoinGecko Trending (medium effort)
CoinGecko's `/search/trending` has much better multi-chain coverage than CoinMarketCap's free tier. A new `coingecko.ts` provider could follow the same pattern as `coinmarketcap.ts`.

### 4. Operator-Curated Allowlist (low effort, limited)
Add a static list of high-liquidity Base tokens in the operator config as a fallback when discovery returns empty:
```yaml
agentRuntime:
  scanner:
    swap:
      fallbackTokens:
        base:
          - symbol: USDC
            address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          - symbol: WETH
            address: "0x4200000000000000000000000000000000000006"
          # ... more Base bluechips
```

### 5. Use DexScreener's Search/Search-Pairs Endpoint (low effort)
DexScreener has a `/latest/dex/search` endpoint that accepts a `chainIds=base` query parameter. The current code only uses the global trending endpoints.

---

The root issue is that the two workhorse providers (DexScreener + GeckoTerminal) have a strong Solana bias in their free-tier trending data. The platform doesn't have a discovery source that's specifically good at finding Base network tokens. **Birdeye EVM support** or **1inch's own token list** would be the most direct fixes since they're purpose-built for the chains the platform trades on.