# Correct Solution

## Problem

Token age resolution fails for all major tokens (ETH, WBTC, SOL, WETH, HYPE) on the Base chain. This blocked agent `t1inch` for 55 minutes. 

The oracle should either:
- Fall back to the token creation timestamp from the chain if Birdeye fails
- Cache resolved ages for well-known tokens
- Support token-age safety overrides for whitelisted tokens (WBTC, WETH, cbBTC etc.)

## Correct Solution

I've been proposing patches to the wrong layer. Let me look at the data resolution architecture properly before responding.  

I see the problem now. I was patching the **consumer** (safety adapter, token resolver) to compensate for incomplete data. That's backwards. The correct architectural principle is: **make the data complete before it reaches the safety layer**. The safety adapter should only evaluate; it should never compensate for missing inputs.

The existing pattern confirms this — `enrichTokenWithDiscovery` already exists in index.ts precisely to enrich incomplete DexScreener results before they hit the adapter. The right fix extends that same pattern: add a **proper EVM contract age provider** to market-data and call it as the final step in that enrichment chain.

```
resolveSwapTokenData         — canonical pin or DexScreener symbol/address search
  ↓ poolCreatedAt missing?
enrichTokenWithDiscovery     — targeted DexScreener discovery lookup
  ↓ still missing?
[NEW] resolveContractAge     — block explorer API (Basescan/Etherscan/Arbiscan)
  ↓ still missing?
ageResolution: 'missing'     — the safety adapter legitimately rejects
```

The new provider — call it `evm-explorer.ts` in src — follows the same shape as the existing providers (typed config, rate limiter, fetch):

```ts
export interface EvmExplorerConfig {
  // Per-chain: chain name → explorer API base URL + key
  chains: Record<string, { baseUrl: string; apiKey: string }>;
  rateLimiter: RequestGate;
  timeoutMs: number;
}

export async function fetchContractDeployedAt(
  address: string,
  network: string,
  config: EvmExplorerConfig,
): Promise<string | null>  // ISO timestamp or null
```

It's added to `ProviderRegistry`, configured in default.yaml (Basescan for `base`, Etherscan for `ethereum`, Arbiscan for `arbitrum`), and cached with a very long TTL — contract deployment dates are immutable facts.

With this in place, neither `resolveSwapTokenData` nor token-safety-adapter.ts need any canonical bypass logic for the age problem. The data arrives complete. The safety adapter evaluates honestly.