import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { marketDataTools } from './market-data.js';

const discoverTokensTool = marketDataTools.find((tool) => tool.name === 'discover_tokens');
const searchTokensTool = marketDataTools.find((tool) => tool.name === 'search_tokens');
const checkRegimeTool = marketDataTools.find((tool) => tool.name === 'check_regime');

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-market-data-test',
    sessionId: 'session-market-data-test',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

describe('discover_tokens tool', () => {
  it('reuses the shared price service to enrich returned discovery tokens', async () => {
    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [{ symbol: 'BONK', network: 'solana', priceUsd: 0.00001, discoveryVectors: ['trending'] }],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: {
          getPrice: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              priceUsd: 0.00002,
              source: 'oracle',
              fetchedAt: '2026-06-09T00:00:00.000Z',
              stale: false,
            },
          }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [
        expect.objectContaining({
          symbol: 'BONK',
          network: 'solana',
          priceUsd: 0.00002,
          priceSource: 'oracle',
          priceStale: false,
        }),
      ],
    });
  });

  it('keeps discovery prices when the shared price lookup fails', async () => {
    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [{ symbol: 'WIF', network: 'solana', priceUsd: 2.5, discoveryVectors: ['boosted'] }],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: {
          getPrice: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: 'price.unavailable', message: 'missing' },
          }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [expect.objectContaining({ symbol: 'WIF', priceUsd: 2.5 })],
    });
  });

  it('does not overwrite prices when multiple discovery tokens share the same symbol on one network', async () => {
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        priceUsd: 1.23,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [
                { address: 'token-a', symbol: 'PEPE', network: 'solana', priceUsd: 0.1, discoveryVectors: ['trending'] },
                { address: 'token-b', symbol: 'PEPE', network: 'solana', priceUsd: 0.2, discoveryVectors: ['boosted'] },
              ],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [
        expect.objectContaining({ address: 'token-a', priceUsd: 0.1 }),
        expect.objectContaining({ address: 'token-b', priceUsd: 0.2 }),
      ],
    });
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('passes token address to price service so address-aware lookup prevents repricing with a different same-symbol token', async () => {
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        priceUsd: 0.00005,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [
                { address: '0xdiscovered', symbol: 'PEPE', network: 'solana', priceUsd: 0.00003, discoveryVectors: ['trending'] },
              ],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(result.success).toBe(true);
    // Price service must have been called with the token address so it can
    // distinguish the discovered token from other same-symbol tokens.
    expect(getPrice).toHaveBeenCalledWith('PEPE', 'solana', '0xdiscovered');
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [
        expect.objectContaining({
          symbol: 'PEPE',
          priceUsd: 0.00005,
          priceSource: 'oracle',
        }),
      ],
    });
  });
});

describe('search_tokens tool', () => {
  it('uses the shared registry search wrapper when policy filtering is enabled', async () => {
    const search = vi.fn().mockResolvedValue({
      data: [
        {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
          name: 'Wrapped SOL',
          network: 'solana',
          priceUsd: 150,
          volume24hUsd: 500_000,
          liquidityUsd: 2_000_000,
          priceChange24hPct: 1,
          dexId: 'raydium',
        },
      ],
      meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'dexscreener' },
    });

    const result = await searchTokensTool!.execute(
      { query: 'SOL', network: 'solana' },
      makeContext({
        marketDataConfig: {
          dexscreener: { baseUrl: 'https://api.dexscreener.com', search: { requestsPerMinute: 100 }, discovery: { requestsPerMinute: 100 } },
          geckoterminal: { baseUrl: 'https://api.geckoterminal.com', candles: { requestsPerMinute: 100 }, discovery: { requestsPerMinute: 100 } },
          hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz', intelligencePath: '/info', intelligence: { requestsPerMinute: 100 } },
          bybit: { baseUrl: 'https://api.bybit.com', longShortRatioPath: '/v5/market/account-ratio', intelligence: { requestsPerMinute: 100 } },
          binance: { baseUrl: 'https://api.binance.com', requestsPerMinute: 100 },
          birdeye: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
          coinMarketCap: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
          tokenSafety: {
            enabled: true,
            defaults: {
              minLiquidityUsd: 10_000,
              minVolume24hUsd: 25_000,
              minTokenAgeHours: 0,
              deadPoolMinAgeHours: 720,
              deadPoolMaxVolume24hUsd: 1_000,
              preferCanonical: true,
              requireCanonicalForKnownSymbols: false,
              includeBlockedSearchResults: false,
            },
            tradeGuard: { enabled: false, liquidityMultiplier: 5, allowOverrides: true, overrideTtlMs: 60_000 },
            canonicalTokens: {
              solana: {
                SOL: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', aliases: ['WSOL'] },
              },
            },
          },
          timeoutMs: 5_000,
        },
        marketDataRegistry: {
          dexscreener: {
            search,
          },
        } as ToolContext['marketDataRegistry'],
      }),
    );

    expect(search).toHaveBeenCalledWith('SOL');
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      freshness: { isStale: false, ageMs: 0 },
      tokens: [expect.objectContaining({ symbol: 'SOL', network: 'solana' })],
    });
  });
});

describe('check_regime tool', () => {
  it('normalizes the benchmark symbol through the candle provider registry before fetching candles', async () => {
    const candles = Array.from({ length: 220 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1_000 + index,
    }));
    const candlesSpy = vi.fn().mockResolvedValue({
      data: candles,
      meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'binance' },
    });

    const result = await checkRegimeTool!.execute(
      { benchmarkSymbol: 'BTC/USD' },
      makeContext({
        marketDataRegistry: {
          binance: {
            candles: candlesSpy,
          },
        } as ToolContext['marketDataRegistry'],
      }),
    );

    expect(candlesSpy).toHaveBeenCalledWith('BTCUSDT', { interval: '1h', limit: 200 });
    expect(result.success).toBe(true);
  });
});

describe('DiscoverTokensParamsSchema', () => {
  it('accepts limit: 100', () => {
    const result = discoverTokensTool!.parametersSchema.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it('rejects limit: 101', () => {
    const result = discoverTokensTool!.parametersSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });
});