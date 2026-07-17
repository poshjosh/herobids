import { describe, it, expect } from 'vitest';
import {
  evaluateTokenSafety,
  rankAndFilterCandidates,
  deduplicateByAddress,
  lookupCanonical,
  isKnownCanonicalSymbol,
  resolveTokenSafetyPolicyConfig,
  type TokenSafetyPolicyConfig,
} from './token-safety.js';
import type { TokenInfo, MarketDataConfig } from './types.js';

const defaultPolicy: TokenSafetyPolicyConfig = {
  minLiquidityUsd: 10_000,
  minVolume24hUsd: 25_000,
  minTokenAgeHours: 24,
  deadPoolMinAgeHours: 720,
  deadPoolMaxVolume24hUsd: 1_000,
  preferCanonical: true,
  requireCanonicalForKnownSymbols: true,
  includeBlockedSearchResults: false,
  canonicalTokens: {
    solana: {
      SOL: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', aliases: ['WSOL'] },
      USDC: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin', aliases: [] },
    },
  },
};

function makeToken(overrides: Partial<TokenInfo & { poolCreatedAt?: string }> = {}): TokenInfo & { poolCreatedAt?: string } {
  return {
    address: '0xabc123',
    symbol: 'TEST',
    name: 'Test Token',
    network: 'solana',
    priceUsd: 1.5,
    volume24hUsd: 100_000,
    liquidityUsd: 50_000,
    priceChange24hPct: 5,
    dexId: 'raydium',
    ...overrides,
  };
}

describe('evaluateTokenSafety', () => {
  it('marks token eligible when all checks pass', () => {
    const token = makeToken({ liquidityUsd: 50_000, volume24hUsd: 100_000 });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.eligible).toBe(true);
    expect(result.blockedReasons).toHaveLength(0);
  });

  it('blocks token with low liquidity', () => {
    const token = makeToken({ liquidityUsd: 5_000 });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some((r) => r.code === 'token.low_liquidity')).toBe(true);
  });

  it('blocks token with low volume', () => {
    const token = makeToken({ volume24hUsd: 5_000 });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some((r) => r.code === 'token.low_volume')).toBe(true);
  });

  it('blocks token that is too new', () => {
    const token = makeToken({ poolCreatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some((r) => r.code === 'token.too_new')).toBe(true);
  });

  it('blocks dead pool (old + no volume)', () => {
    const token = makeToken({
      poolCreatedAt: new Date(Date.now() - 800 * 60 * 60 * 1000).toISOString(),
      volume24hUsd: 500,
      liquidityUsd: 50_000,
    });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some((r) => r.code === 'token.dead_pool')).toBe(true);
  });

  it('blocks non-canonical token for known symbol', () => {
    const token = makeToken({ symbol: 'SOL', address: 'FAKE_ADDRESS', network: 'solana' });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some((r) => r.code === 'token.non_canonical')).toBe(true);
  });

  it('marks canonical token correctly', () => {
    const token = makeToken({
      symbol: 'SOL',
      address: 'So11111111111111111111111111111111111111112',
      network: 'solana',
    });
    const result = evaluateTokenSafety(token, defaultPolicy);
    expect(result.canonical).toBe(true);
    expect(result.canonicalSymbol).toBe('SOL');
  });

  it('respects per-request threshold overrides', () => {
    const token = makeToken({ liquidityUsd: 8_000 });
    const result = evaluateTokenSafety(token, defaultPolicy, { minLiquidityUsd: 5_000 });
    expect(result.eligible).toBe(true);
  });
});

describe('rankAndFilterCandidates', () => {
  it('filters out blocked tokens by default', () => {
    const tokens = [
      makeToken({ address: '0x1', liquidityUsd: 50_000, volume24hUsd: 100_000 }),
      makeToken({ address: '0x2', liquidityUsd: 5_000, volume24hUsd: 100_000 }),
    ];
    const result = rankAndFilterCandidates(tokens, defaultPolicy);
    expect(result).toHaveLength(1);
    expect(result[0]!.address).toBe('0x1');
  });

  it('includes blocked tokens when requested', () => {
    const tokens = [
      makeToken({ address: '0x1', liquidityUsd: 50_000, volume24hUsd: 100_000 }),
      makeToken({ address: '0x2', liquidityUsd: 5_000, volume24hUsd: 100_000 }),
    ];
    const result = rankAndFilterCandidates(tokens, defaultPolicy, { includeBlocked: true });
    expect(result).toHaveLength(2);
    expect(result[0]!.safety.eligible).toBe(true);
    expect(result[1]!.safety.eligible).toBe(false);
  });

  it('promotes canonical tokens to top', () => {
    const tokens = [
      makeToken({ address: '0xfake', symbol: 'SOL', liquidityUsd: 1_000_000, volume24hUsd: 500_000, network: 'solana' }),
      makeToken({ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', liquidityUsd: 500_000, volume24hUsd: 300_000, network: 'solana' }),
    ];
    const result = rankAndFilterCandidates(tokens, defaultPolicy, { includeBlocked: true });
    expect(result[0]!.address).toBe('So11111111111111111111111111111111111111112');
    expect(result[0]!.safety.canonical).toBe(true);
  });

  it('does not force canonical promotion when preferCanonical is false', () => {
    const policy = {
      ...defaultPolicy,
      requireCanonicalForKnownSymbols: false,
    };
    const tokens = [
      makeToken({ address: '0xfake', symbol: 'SOL', liquidityUsd: 1_000_000, volume24hUsd: 500_000, network: 'solana' }),
      makeToken({ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', liquidityUsd: 500_000, volume24hUsd: 300_000, network: 'solana' }),
    ];
    const result = rankAndFilterCandidates(tokens, policy, { includeBlocked: true, preferCanonical: false });
    expect(result[0]!.address).toBe('0xfake');
    expect(result[0]!.safety.canonical).toBe(false);
  });

  it('respects limit parameter', () => {
    const tokens = Array.from({ length: 20 }, (_, i) =>
      makeToken({ address: `0x${i}`, liquidityUsd: 50_000 + i * 1000, volume24hUsd: 100_000 }),
    );
    const result = rankAndFilterCandidates(tokens, defaultPolicy, { limit: 5 });
    expect(result).toHaveLength(5);
  });
});

describe('deduplicateByAddress', () => {
  it('removes duplicates by network:address', () => {
    const tokens: TokenInfo[] = [
      makeToken({ address: '0xabc', network: 'solana' }),
      makeToken({ address: '0xabc', network: 'solana', priceUsd: 2 }),
      makeToken({ address: '0xdef', network: 'solana' }),
    ];
    const result = deduplicateByAddress(tokens);
    expect(result).toHaveLength(2);
  });

  it('keeps same address on different networks', () => {
    const tokens: TokenInfo[] = [
      makeToken({ address: '0xabc', network: 'solana' }),
      makeToken({ address: '0xabc', network: 'base' }),
    ];
    const result = deduplicateByAddress(tokens);
    expect(result).toHaveLength(2);
  });
});

describe('lookupCanonical', () => {
  it('finds canonical token by direct symbol match', () => {
    const result = lookupCanonical('SOL', 'solana', defaultPolicy.canonicalTokens);
    expect(result).toBeDefined();
    expect(result!.address).toBe('So11111111111111111111111111111111111111112');
  });

  it('finds canonical token by alias', () => {
    const result = lookupCanonical('WSOL', 'solana', defaultPolicy.canonicalTokens);
    expect(result).toBeDefined();
    expect(result!.symbol).toBe('SOL');
  });

  it('returns undefined for unknown symbol', () => {
    const result = lookupCanonical('DOGE', 'solana', defaultPolicy.canonicalTokens);
    expect(result).toBeUndefined();
  });

  it('returns undefined for wrong network', () => {
    const result = lookupCanonical('SOL', 'ethereum', defaultPolicy.canonicalTokens);
    expect(result).toBeUndefined();
  });

  it('matches by on-chain address — EVM case-insensitive', () => {
    const tokens = {
      base: {
        WETH: { address: '0x4200000000000000000000000000000000000006', name: 'Wrapped Ether', aliases: ['ETH'] },
      },
    };
    const lower = lookupCanonical('0x4200000000000000000000000000000000000006', 'base', tokens);
    expect(lower).toBeDefined();
    expect(lower!.symbol).toBe('WETH');

    const upper = lookupCanonical('0x4200000000000000000000000000000000000006'.toUpperCase(), 'base', tokens);
    expect(upper).toBeDefined();
    expect(upper!.symbol).toBe('WETH');
  });

  it('matches by on-chain address — Solana case-sensitive', () => {
    const result = lookupCanonical(
      'So11111111111111111111111111111111111111112',
      'solana',
      defaultPolicy.canonicalTokens,
    );
    expect(result).toBeDefined();
    expect(result!.symbol).toBe('SOL');

    // A case-different variant must NOT match
    const wrongCase = lookupCanonical(
      'so11111111111111111111111111111111111111112',
      'solana',
      defaultPolicy.canonicalTokens,
    );
    expect(wrongCase).toBeUndefined();
  });
});

describe('isKnownCanonicalSymbol', () => {
  it('returns true for known symbol', () => {
    expect(isKnownCanonicalSymbol('SOL', defaultPolicy.canonicalTokens)).toBe(true);
  });

  it('returns true for alias', () => {
    expect(isKnownCanonicalSymbol('WSOL', defaultPolicy.canonicalTokens)).toBe(true);
  });

  it('returns false for unknown symbol', () => {
    expect(isKnownCanonicalSymbol('UNKNOWN', defaultPolicy.canonicalTokens)).toBe(false);
  });
});

describe('resolveTokenSafetyPolicyConfig', () => {
  function makeFullConfig(tokenSafety: NonNullable<MarketDataConfig['tokenSafety']>): MarketDataConfig {
    return {
      dexscreener: {
        baseUrl: 'https://api.dexscreener.com',
        search: { requestsPerMinute: 100 },
        discovery: { requestsPerMinute: 100 },
      },
      geckoterminal: {
        baseUrl: 'https://api.geckoterminal.com',
        candles: { requestsPerMinute: 100 },
        discovery: { requestsPerMinute: 100 },
      },
      hyperliquid: {
        baseUrl: 'https://api.hyperliquid.xyz',
        intelligencePath: '/info',
        intelligence: { requestsPerMinute: 100 },
      },
      bybit: {
        baseUrl: 'https://api.bybit.com',
        longShortRatioPath: '/v5/market/account-ratio',
        intelligence: { requestsPerMinute: 100 },
        tickers: { requestsPerMinute: 30 },
      },
      binance: { baseUrl: 'https://api.binance.com', requestsPerMinute: 100 },
      birdeye: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
      coinMarketCap: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
      tokenSafety,
      timeoutMs: 5_000,
    };
  }

  const enabledTokenSafety: NonNullable<MarketDataConfig['tokenSafety']> = {
    enabled: true,
    defaults: {
      minLiquidityUsd: 50_000,
      minVolume24hUsd: 100_000,
      minTokenAgeHours: 48,
      deadPoolMinAgeHours: 500,
      deadPoolMaxVolume24hUsd: 2_000,
      preferCanonical: true,
      requireCanonicalForKnownSymbols: true,
      includeBlockedSearchResults: false,
    },
    tradeGuard: { enabled: true, liquidityMultiplier: 10, allowOverrides: false, overrideTtlMs: 30_000 },
    canonicalTokens: {
      solana: {
        SOL: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', aliases: [] },
      },
    },
  };

  it('maps enabled config fields correctly', () => {
    const policy = resolveTokenSafetyPolicyConfig(makeFullConfig(enabledTokenSafety));

    expect(policy.minLiquidityUsd).toBe(50_000);
    expect(policy.minVolume24hUsd).toBe(100_000);
    expect(policy.minTokenAgeHours).toBe(48);
    expect(policy.deadPoolMinAgeHours).toBe(500);
    expect(policy.deadPoolMaxVolume24hUsd).toBe(2_000);
    expect(policy.preferCanonical).toBe(true);
    expect(policy.requireCanonicalForKnownSymbols).toBe(true);
    expect(policy.includeBlockedSearchResults).toBe(false);
    expect(policy.canonicalTokens).toEqual(enabledTokenSafety.canonicalTokens);
  });

  it('returns safe defaults when tokenSafety.enabled is false', () => {
    const policy = resolveTokenSafetyPolicyConfig(
      makeFullConfig({ ...enabledTokenSafety, enabled: false }),
    );

    expect(policy.minLiquidityUsd).toBe(10_000);
    expect(policy.minVolume24hUsd).toBe(0);
    expect(policy.minTokenAgeHours).toBe(0);
    expect(policy.preferCanonical).toBe(false);
    expect(policy.requireCanonicalForKnownSymbols).toBe(false);
    expect(policy.canonicalTokens).toEqual({});
  });

  it('returns safe defaults when tokenSafety is absent', () => {
    const config = makeFullConfig(enabledTokenSafety);
    delete (config as { tokenSafety?: unknown }).tokenSafety;

    const policy = resolveTokenSafetyPolicyConfig(config);

    expect(policy.minLiquidityUsd).toBe(10_000);
    expect(policy.preferCanonical).toBe(false);
    expect(policy.canonicalTokens).toEqual({});
  });
});
