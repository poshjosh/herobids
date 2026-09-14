import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, TradertonReadResult } from '@herobids/domain';
import { marketDataTools } from './market-data.js';

const discoverTokensTool = marketDataTools.find((tool) => tool.name === 'discover_tokens');
const searchTokensTool = marketDataTools.find((tool) => tool.name === 'search_tokens');
const checkRegimeTool = marketDataTools.find((tool) => tool.name === 'check_regime');
const getFundingRatesTool = marketDataTools.find((tool) => tool.name === 'get_funding_rates');
const getMarketOverviewTool = marketDataTools.find((tool) => tool.name === 'get_market_overview');

/** A stubbed tradertonBoundary whose invoke returns a fixed result and records calls. */
function stubBoundary(result: TradertonReadResult) {
  const invoke = vi.fn(async () => result);
  return { boundary: { invoke }, invoke };
}

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

// ── Fail-closed degrade (B7) ──────────────────────────────────────────────
// The in-process market-data path has been removed. When ctx.tradertonBoundary
// is absent, each tool degrades with `market_data_not_configured` and never
// touches the registry or price service (which are no longer consulted).

describe('market-data tools degrade (fail-closed) when no Traderton boundary is configured', () => {
  it('discover_tokens degrades without touching the registry or price service', async () => {
    const discover = vi.fn();
    const getPrice = vi.fn();

    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: { discovery: { discover } } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
    expect(result.retryable).toBe(false);
    expect(discover).not.toHaveBeenCalled();
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('search_tokens degrades without touching the registry', async () => {
    const search = vi.fn();

    const result = await searchTokensTool!.execute(
      { query: 'SOL', network: 'solana' },
      makeContext({
        marketDataRegistry: { dexscreener: { search } } as ToolContext['marketDataRegistry'],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
    expect(result.retryable).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it('check_regime degrades without touching the registry', async () => {
    const candles = vi.fn();

    const result = await checkRegimeTool!.execute(
      { benchmarkSymbol: 'BTC/USD' },
      makeContext({
        marketDataRegistry: { binance: { candles } } as ToolContext['marketDataRegistry'],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
    expect(result.retryable).toBe(false);
    expect(candles).not.toHaveBeenCalled();
  });

  it('get_funding_rates degrades when no boundary is configured', async () => {
    const result = await getFundingRatesTool!.execute(
      { symbols: ['BTC'] },
      makeContext({ marketDataRegistry: {} as ToolContext['marketDataRegistry'] }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
    expect(result.retryable).toBe(false);
  });

  it('get_market_overview degrades when no boundary is configured', async () => {
    const result = await getMarketOverviewTool!.execute(
      { venue: 'hyperliquid' },
      makeContext({ marketDataRegistry: {} as ToolContext['marketDataRegistry'] }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
    expect(result.retryable).toBe(false);
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

// ── Traderton boundary routing (B4) ───────────────────────────────────────
// When ctx.tradertonBoundary is present, each read routes over the boundary
// (ctx.tradertonBoundary.invoke) instead of the in-process registry/price
// service. The boundary branch forwards { toolName, payload } and maps the
// result through mapReadResultToToolResult.

describe('market-data tools route over the Traderton boundary when present', () => {
  it('search_tokens forwards its params to the boundary and returns the mapped success payload', async () => {
    const boundaryData = { ok: true, tokens: [{ symbol: 'SOL', network: 'solana' }], freshness: { isStale: false, ageMs: 0 } };
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: boundaryData });
    const search = vi.fn();
    const getPrice = vi.fn();

    const result = await searchTokensTool!.execute(
      { query: 'SOL', network: 'solana', minLiquidityUsd: 5000, limit: 5 },
      makeContext({
        tradertonBoundary: boundary,
        marketDataRegistry: { dexscreener: { search } } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'search_tokens',
      payload: {
        query: 'SOL',
        network: 'solana',
        minLiquidityUsd: 5000,
        minVolume24hUsd: undefined,
        minTokenAgeHours: undefined,
        includeBlocked: undefined,
        limit: 5,
      },
    });
    expect(search).not.toHaveBeenCalled();
    expect(getPrice).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('discover_tokens forwards its params to the boundary without touching the registry or price service', async () => {
    const boundaryData = { ok: true, tokens: [{ symbol: 'BONK', network: 'solana' }] };
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: boundaryData });
    const discover = vi.fn();
    const getPrice = vi.fn();

    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5, minLiquidityUsd: 10000 },
      makeContext({
        tradertonBoundary: boundary,
        marketDataRegistry: { discovery: { discover } } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'discover_tokens',
      payload: { network: 'solana', limit: 5, minLiquidityUsd: 10000 },
    });
    expect(discover).not.toHaveBeenCalled();
    expect(getPrice).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('check_regime forwards its params to the boundary without touching the registry', async () => {
    const boundaryData = { ok: true, regime: 'trending', tradeable: true };
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: boundaryData });
    const candles = vi.fn();

    const result = await checkRegimeTool!.execute(
      { benchmarkSymbol: 'BTC', emaFast: 20, emaAlignment: 'bullish' },
      makeContext({
        tradertonBoundary: boundary,
        marketDataRegistry: { binance: { candles } } as ToolContext['marketDataRegistry'],
      }),
    );

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'check_regime',
      payload: {
        benchmarkSymbol: 'BTC',
        emaFast: 20,
        emaSlow: undefined,
        emaTrend: undefined,
        adxMin: undefined,
        emaAlignment: 'bullish',
        marketStructure: undefined,
        priceAboveVwap: undefined,
        disableWhenChoppy: undefined,
      },
    });
    expect(candles).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('get_funding_rates forwards its params to the boundary and returns the mapped success payload', async () => {
    const boundaryData = { ok: true, fundingRates: [{ symbol: 'BTC', rate: '0.0001' }] };
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: boundaryData });

    const result = await getFundingRatesTool!.execute(
      { symbols: ['BTC', 'ETH'], venue: 'hyperliquid' },
      makeContext({ tradertonBoundary: boundary, marketDataRegistry: {} as ToolContext['marketDataRegistry'] }),
    );

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'get_funding_rates',
      payload: { symbols: ['BTC', 'ETH'], venue: 'hyperliquid' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('get_market_overview forwards its params to the boundary and returns the mapped success payload', async () => {
    const boundaryData = { ok: true, movers: [], breadth: {} };
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: boundaryData });

    const result = await getMarketOverviewTool!.execute(
      { venue: 'hyperliquid', symbols: ['BTC'] },
      makeContext({ tradertonBoundary: boundary, marketDataRegistry: {} as ToolContext['marketDataRegistry'] }),
    );

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'get_market_overview',
      payload: { venue: 'hyperliquid', symbols: ['BTC'] },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('maps a boundary validation failure to a typed non-fault failure preserving code', async () => {
    const { boundary } = stubBoundary({
      kind: 'failure',
      code: 'validation.invalid_payload',
      message: 'bad query',
      retryable: false,
    });

    const result = await searchTokensTool!.execute(
      { query: 'SOL' },
      makeContext({ tradertonBoundary: boundary }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('bad query');
    expect(result.errorCode).toBe('validation.invalid_payload');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
  });
});