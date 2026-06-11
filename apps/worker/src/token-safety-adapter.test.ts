import { describe, it, expect, vi } from 'vitest';
import { createSwapTokenSafetyAdapter } from './token-safety-adapter.js';
import type { MarketDataConfig } from '@herobids/market-data';
import type { TokenSafetyOverrideRepository, TokenSafetyOverrideRow } from '@herobids/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarketDataConfig(
  overrides: {
    tradeGuardEnabled?: boolean;
    allowOverrides?: boolean;
    liquidityMultiplier?: number;
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minTokenAgeHours?: number;
    tokenSafetyEnabled?: boolean;
  } = {},
): MarketDataConfig {
  const {
    tradeGuardEnabled = true,
    allowOverrides = true,
    liquidityMultiplier = 5,
    minLiquidityUsd = 10_000,
    minVolume24hUsd = 25_000,
    minTokenAgeHours = 24,
    tokenSafetyEnabled = true,
  } = overrides;

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
    },
    binance: { baseUrl: 'https://api.binance.com', requestsPerMinute: 100 },
    birdeye: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
    coinMarketCap: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
    tokenSafety: {
      enabled: tokenSafetyEnabled,
      defaults: {
        minLiquidityUsd,
        minVolume24hUsd,
        minTokenAgeHours,
        deadPoolMinAgeHours: 720,
        deadPoolMaxVolume24hUsd: 1_000,
        preferCanonical: false,
        requireCanonicalForKnownSymbols: false,
        includeBlockedSearchResults: false,
      },
      tradeGuard: {
        enabled: tradeGuardEnabled,
        liquidityMultiplier,
        allowOverrides,
        overrideTtlMs: 60_000,
      },
      canonicalTokens: {},
    },
    timeoutMs: 5_000,
  };
}

function makeOverrideRow(id: string): TokenSafetyOverrideRow {
  return {
    id,
    actorType: 'agent',
    actorId: 'agent-1',
    botId: null,
    venueAccountId: 'va-1',
    network: 'solana',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    reasonCodes: ['token.low_liquidity'],
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    consumedBy: null,
    meta: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeOverrideRepo(
  overrides: Partial<{
    fetchActiveResult: TokenSafetyOverrideRow | null;
    consumeResult: boolean;
    issueResult: TokenSafetyOverrideRow;
  }> = {},
): TokenSafetyOverrideRepository {
  const defaultRow = makeOverrideRow('override-123');
  return {
    fetchActive: vi.fn().mockResolvedValue(overrides.fetchActiveResult ?? null),
    consume: vi.fn().mockResolvedValue(overrides.consumeResult ?? true),
    issue: vi.fn().mockResolvedValue(overrides.issueResult ?? defaultRow),
    expireStale: vi.fn().mockResolvedValue(0),
  } as unknown as TokenSafetyOverrideRepository;
}

function makeGoodToken() {
  return {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Wrapped SOL',
    network: 'solana',
    priceUsd: 150,
    volume24hUsd: 100_000,
    liquidityUsd: 500_000,
    priceChange24hPct: 2.5,
    dexId: 'raydium',
    poolCreatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    ageResolution: 'available' as const,
  };
}

function makeBadToken() {
  return { ...makeGoodToken(), liquidityUsd: 1_000, volume24hUsd: 500 };
}

const baseRequest = {
  actorType: 'agent',
  actorId: 'agent-1',
  botId: 'bot-1',
  venue: 'jupiter',
  venueAccountId: 'va-1',
  network: 'solana',
  tokenAddress: 'So11111111111111111111111111111111111111112',
  tokenSymbol: 'SOL',
  swapSide: 'buy' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSwapTokenSafetyAdapter', () => {
  describe('sell bypass', () => {
    it('approves without any checks when swapSide is sell', async () => {
      const overrideRepo = makeOverrideRepo();
      const resolveTokenData = vi.fn();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo,
        resolveTokenData,
      });

      const result = await adapter.checkSwapTarget({ ...baseRequest, swapSide: 'sell' });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.overridden).toBe(false);
      expect(overrideRepo.fetchActive).not.toHaveBeenCalled();
      expect(resolveTokenData).not.toHaveBeenCalled();
    });
  });

  describe('trade guard disabled', () => {
    it('approves all buy requests when tradeGuard.enabled is false', async () => {
      const overrideRepo = makeOverrideRepo();
      const resolveTokenData = vi.fn();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ tradeGuardEnabled: false }),
        overrideRepo,
        resolveTokenData,
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(true);
      expect(resolveTokenData).not.toHaveBeenCalled();
    });

    it('approves when tokenSafety is not configured', async () => {
      const config = makeMarketDataConfig();
      delete (config as { tokenSafety?: unknown }).tokenSafety;
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: config,
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn(),
      });

      const result = await adapter.checkSwapTarget(baseRequest);
      expect(result.ok).toBe(true);
    });
  });

  describe('override ticket flow', () => {
    it('approves with overridden=true when override is found and consumed', async () => {
      const row = makeOverrideRow('override-abc');
      const overrideRepo = makeOverrideRepo({ fetchActiveResult: row, consumeResult: true });
      const resolveTokenData = vi.fn();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo,
        resolveTokenData,
      });

      const result = await adapter.checkSwapTarget({ ...baseRequest, overrideId: 'override-abc' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.overridden).toBe(true);
        expect(result.data.tokenAddress).toBe(baseRequest.tokenAddress);
      }
      expect(overrideRepo.consume).toHaveBeenCalledWith('override-abc', baseRequest.botId);
      expect(resolveTokenData).not.toHaveBeenCalled();
    });

    it('falls through to normal check when override is not found', async () => {
      const overrideRepo = makeOverrideRepo({ fetchActiveResult: null });
      const resolveTokenData = vi.fn().mockResolvedValue(makeGoodToken());
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo,
        resolveTokenData,
      });

      const result = await adapter.checkSwapTarget({ ...baseRequest, overrideId: 'nonexistent' });

      // Falls through to normal safety check — resolveTokenData should be called
      expect(resolveTokenData).toHaveBeenCalledWith(baseRequest.network, baseRequest.tokenAddress);
      expect(result.ok).toBe(true);
    });

    it('falls through to normal check when consume returns false (already consumed)', async () => {
      const row = makeOverrideRow('override-used');
      const overrideRepo = makeOverrideRepo({ fetchActiveResult: row, consumeResult: false });
      const resolveTokenData = vi.fn().mockResolvedValue(makeGoodToken());
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo,
        resolveTokenData,
      });

      const result = await adapter.checkSwapTarget({ ...baseRequest, overrideId: 'override-used' });

      expect(resolveTokenData).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('uses actorId as fallback when botId is absent', async () => {
      const row = makeOverrideRow('override-xyz');
      const overrideRepo = makeOverrideRepo({ fetchActiveResult: row, consumeResult: true });
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo,
        resolveTokenData: vi.fn(),
      });

      await adapter.checkSwapTarget({ ...baseRequest, botId: undefined, overrideId: 'override-xyz' });

      expect(overrideRepo.consume).toHaveBeenCalledWith('override-xyz', baseRequest.actorId);
    });
  });

  describe('token resolution', () => {
    it('rejects with token.not_found when resolveTokenData returns null', async () => {
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(null),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('token.not_found');
        expect(result.error.retryable).toBe(false);
        expect(result.error.message).toContain(baseRequest.tokenSymbol);
      }
    });

    it('includes token address in not_found message when symbol is absent', async () => {
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(null),
      });

      const result = await adapter.checkSwapTarget({ ...baseRequest, tokenSymbol: undefined });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain(baseRequest.tokenAddress);
    });

    it('rejects when age-based policy is active but poolCreatedAt is unavailable', async () => {
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: false, minTokenAgeHours: 24 }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue({
          ...makeGoodToken(),
          poolCreatedAt: undefined,
          ageResolution: 'missing',
        }),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('token.safety_rejected');
        expect(result.error.message).toContain('age could not be resolved');
        expect(result.error.retryable).toBe(false);
        expect(result.error.details?.reasonCodes).toEqual(['token.age_unknown']);
      }
    });

    it('rejects when age-based policy is active and age resolution is indeterminate', async () => {
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: false, minTokenAgeHours: 24 }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue({
          ...makeGoodToken(),
          poolCreatedAt: undefined,
          ageResolution: 'indeterminate',
        }),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('token.safety_rejected');
        expect(result.error.details?.reasonCodes).toEqual(['token.age_unknown']);
      }
    });
  });

  describe('safety evaluation', () => {
    it('approves token when it passes all safety criteria', async () => {
      const token = makeGoodToken();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.overridden).toBe(false);
        expect(result.data.liquidityUsd).toBe(token.liquidityUsd);
        expect(result.data.volume24hUsd).toBe(token.volume24hUsd);
      }
    });

    it('rejects token with low liquidity and issues override ticket when allowOverrides=true', async () => {
      const issuedRow = makeOverrideRow('new-override-1');
      const overrideRepo = makeOverrideRepo({ issueResult: issuedRow });
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: true }),
        overrideRepo,
        resolveTokenData: vi.fn().mockResolvedValue(makeBadToken()),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('token.safety_rejected');
        expect(result.error.retryable).toBe(true);
        expect(result.error.overrideTicket).toBeDefined();
        expect(result.error.overrideTicket!.id).toBe('new-override-1');
        expect(result.error.overrideTicket!.reasonCodes.length).toBeGreaterThan(0);
      }
      expect(overrideRepo.issue).toHaveBeenCalledOnce();
    });

    it('rejects without override ticket when allowOverrides=false', async () => {
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(makeBadToken()),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.retryable).toBe(false);
        expect(result.error.overrideTicket).toBeUndefined();
      }
    });

    it('includes safety details in rejection', async () => {
      const token = makeBadToken();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget(baseRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.details).toBeDefined();
        expect(result.error.details!.liquidityUsd).toBe(token.liquidityUsd);
        expect(result.error.details!.volume24hUsd).toBe(token.volume24hUsd);
      }
    });
  });

  describe('instance thresholds', () => {
    it('blocks token that passes operator policy but fails tightened instance minLiquidityUsd', async () => {
      // Token has $50k liquidity — passes operator's $10k, fails instance's $100k
      const token = { ...makeGoodToken(), liquidityUsd: 50_000 };
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ minLiquidityUsd: 10_000, allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        instanceThresholds: { minLiquidityUsd: 100_000 },
      });

      expect(result.ok).toBe(false);
    });

    it('blocks token that passes operator policy but fails tightened instance minVolume24hUsd', async () => {
      // Token has $30k volume — passes operator's $25k, fails instance's $200k
      const token = { ...makeGoodToken(), volume24hUsd: 30_000 };
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ minVolume24hUsd: 25_000, allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        instanceThresholds: { minVolume24hUsd: 200_000 },
      });

      expect(result.ok).toBe(false);
    });

    it('does not relax thresholds below operator defaults', async () => {
      // Token just under operator's $10k threshold — instance sets $5k (lower), still blocked
      const token = { ...makeGoodToken(), liquidityUsd: 7_000 };
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ minLiquidityUsd: 10_000, allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        instanceThresholds: { minLiquidityUsd: 5_000 },
      });

      expect(result.ok).toBe(false);
    });

    it('suppresses override ticket issuance when instanceThresholds.allowOverrides=false', async () => {
      // Operator allows overrides, but instance disables them
      const overrideRepo = makeOverrideRepo();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: true }),
        overrideRepo,
        resolveTokenData: vi.fn().mockResolvedValue(makeBadToken()),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        instanceThresholds: { allowOverrides: false },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.retryable).toBe(false);
        expect(result.error.overrideTicket).toBeUndefined();
      }
      expect(overrideRepo.issue).not.toHaveBeenCalled();
    });

    it('instance cannot force override issuance when operator disables it', async () => {
      // Operator disables overrides — instance cannot loosen this
      const overrideRepo = makeOverrideRepo();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ allowOverrides: false }),
        overrideRepo,
        resolveTokenData: vi.fn().mockResolvedValue(makeBadToken()),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        instanceThresholds: { allowOverrides: true },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.retryable).toBe(false);
        expect(result.error.overrideTicket).toBeUndefined();
      }
      expect(overrideRepo.issue).not.toHaveBeenCalled();
    });
  });

  describe('dynamic liquidity floor from notional', () => {
    it('raises minLiquidityUsd floor when estimated notional is high (liquidityMultiplier * notional > base)', async () => {
      // Base minLiquidity=$10k, multiplier=5, notional=$50k → floor=$250k
      // Token has $100k liquidity — passes base $10k but fails dynamic $250k
      const token = { ...makeGoodToken(), liquidityUsd: 100_000 };
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ minLiquidityUsd: 10_000, liquidityMultiplier: 5, allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        estimatedOrderNotionalUsd: '50000',
      });

      expect(result.ok).toBe(false);
    });

    it('does not raise floor below base when notional is small', async () => {
      // Base minLiquidity=$10k, multiplier=5, notional=$100 → dynamic floor=$500 < base $10k
      // Token has $15k liquidity — passes base $10k
      const token = { ...makeGoodToken(), liquidityUsd: 15_000 };
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig({ minLiquidityUsd: 10_000, liquidityMultiplier: 5, allowOverrides: false }),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        estimatedOrderNotionalUsd: '100',
      });

      expect(result.ok).toBe(true);
    });

    it('ignores invalid notional values', async () => {
      const token = makeGoodToken();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        estimatedOrderNotionalUsd: 'not-a-number',
      });

      expect(result.ok).toBe(true);
    });

    it('ignores zero notional', async () => {
      const token = makeGoodToken();
      const adapter = createSwapTokenSafetyAdapter({
        marketDataConfig: makeMarketDataConfig(),
        overrideRepo: makeOverrideRepo(),
        resolveTokenData: vi.fn().mockResolvedValue(token),
      });

      const result = await adapter.checkSwapTarget({
        ...baseRequest,
        estimatedOrderNotionalUsd: '0',
      });

      expect(result.ok).toBe(true);
    });
  });
});
