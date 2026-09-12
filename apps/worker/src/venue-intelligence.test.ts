import { describe, expect, it } from 'vitest';
import { buildDiscoveryNetworkMap, buildDiscoveryAddressMap, collectDexTrackedSymbols, collectDexTrackedTargets, findDexPositionForTarget, collectPerpsTrackedSymbols, normalizeTrackedSymbol, parseRegimeBoundaryPayload, parseMarketOverviewPayload, parseDexTokensPayload } from './venue-intelligence.js';
import type { RuntimeSessionMetrics } from './runtime-composition.js';

function buildSessionMetrics(): RuntimeSessionMetrics {
  return {
    decisionsSubmitted: 0,
    decisionsAccepted: 0,
    decisionsRejected: 0,
    lastPnlSummary: null,
    lastPositionSide: null,
    managedBots: [{ id: 'bot-1', status: 'running', symbol: 'ETH-PERP' }],
    market: {
      symbol: 'BTC/USDT',
      price: null,
      freshness: { state: 'fresh', provider: 'runtime' },
    },
    portfolio: {
      exposureUsd: null,
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
      drawdownPct: null,
      availableCapitalUsd: null,
      netDelta: null,
      freshness: { state: 'fresh', provider: 'runtime' },
    },
    openPositions: [
      {
        instrumentId: 'SOL:USDT',
        side: 'long',
        size: '10',
        entryPrice: '100',
        unrealizedPnlUsd: null,
        openedAt: null,
        holdDurationMinutes: null,
        venueType: 'unknown',
        freshness: { state: 'fresh', provider: 'runtime' },
      },
    ],
    recentEvents: [],
    venueSignals: [],
    regime: {
      result: null,
      freshness: { state: 'unavailable', note: 'none' },
    },
    sessionCosts: {
      llmTokensUsed: 0,
      hiddenReasoningTokensUsed: 0,
      llmCostUsd: 0,
      estimatedServerCostUsdPerHour: 0.02,
    },
    performance: {
      startingCapitalUsd: null,
      winRate: null,
      riskAdjustedReturn: null,
      drawdownPct: null,
      netPnlUsd: null,
    },
  };
}

describe('normalizeTrackedSymbol', () => {
  it('normalizes perp and spot-like symbols to a shared token symbol', () => {
    expect(normalizeTrackedSymbol('btc-perp')).toBe('BTC');
    expect(normalizeTrackedSymbol('BONK/USDT')).toBe('BONK');
    expect(normalizeTrackedSymbol('sol:usd')).toBe('SOL');
  });

  it('normalizes real open-position symbol formats used by the worker', () => {
    expect(normalizeTrackedSymbol('BTC/USD:USD')).toBe('BTC');
    expect(normalizeTrackedSymbol('ETH/USDT:USDT')).toBe('ETH');
    expect(normalizeTrackedSymbol('BTCUSDT')).toBe('BTC');
    expect(normalizeTrackedSymbol('SOL-PERP')).toBe('SOL');
  });
});

describe('collectPerpsTrackedSymbols', () => {
  it('collects symbols from positions, bots, and the market snapshot', () => {
    expect(collectPerpsTrackedSymbols(buildSessionMetrics())).toEqual(['SOL', 'ETH', 'BTC']);
  });
});

describe('collectDexTrackedSymbols', () => {
  it('adds explicit DEX watchlist symbols to the tracked set', () => {
    expect(collectDexTrackedSymbols(buildSessionMetrics(), ['BONK', 'WIF/USDT', 'SOL'])).toEqual(['BONK', 'WIF', 'SOL']);
  });

  it('retains network-qualified watchlist entries for composite matching', () => {
    const sessionMetrics = buildSessionMetrics();
    sessionMetrics.openPositions.push({
      instrumentId: 'SOL:USDT',
      side: 'long',
      size: '12',
      entryPrice: '100',
      unrealizedPnlUsd: null,
      openedAt: null,
      holdDurationMinutes: null,
      venueType: 'dex',
      freshness: { state: 'fresh', provider: 'runtime' },
    });

    expect(collectDexTrackedTargets(sessionMetrics, ['solana:BONK', 'BONK'])).toEqual([
      { raw: 'SOL:USDT', network: null, symbol: 'SOL' },
      { raw: 'solana:BONK', network: 'solana', symbol: 'BONK' },
      { raw: 'BONK', network: null, symbol: 'BONK' },
    ]);
  });

  it('includes DEX positions without inheriting perps-only symbols', () => {
    const sessionMetrics = buildSessionMetrics();
    sessionMetrics.openPositions.push({
      instrumentId: 'JUP/USDT',
      side: 'long',
      size: '15',
      entryPrice: '1.1',
      unrealizedPnlUsd: null,
      openedAt: null,
      holdDurationMinutes: null,
      venueType: 'dex',
      freshness: { state: 'fresh', provider: 'runtime' },
    });

    expect(collectDexTrackedSymbols(sessionMetrics, undefined)).toEqual(['JUP']);
  });
});

// Regression: DEX venue intelligence was joining discovery data on symbol alone,
// which caused cross-chain ticker collisions (e.g. USDC on Solana vs USDC on
// Ethereum) to attach pool-age and discovery vectors from the wrong network.
describe('buildDiscoveryNetworkMap', () => {
  it('distinguishes tokens with the same symbol on different networks', () => {
    const solanaUsdc = { symbol: 'USDC', network: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
    const ethUsdc = { symbol: 'USDC', network: 'ethereum', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' };

    const map = buildDiscoveryNetworkMap([solanaUsdc, ethUsdc]);

    expect(map.size).toBe(2);
    expect(map.get('solana:USDC')?.address).toBe(solanaUsdc.address);
    expect(map.get('ethereum:USDC')?.address).toBe(ethUsdc.address);
  });

  it('normalizes network to lowercase and symbol to uppercase for the composite key', () => {
    const token = { symbol: 'bonk', network: 'Solana', address: 'DezX...' };
    const map = buildDiscoveryNetworkMap([token]);

    expect(map.has('solana:BONK')).toBe(true);
    expect(map.has('Solana:bonk')).toBe(false);
  });

  it('preserves the first occurrence when two tokens share the same network:symbol key', () => {
    const first = { symbol: 'WIF', network: 'solana', address: 'addr-1', liquidityUsd: 5_000_000 };
    const second = { symbol: 'WIF', network: 'solana', address: 'addr-2', liquidityUsd: 100 };

    const map = buildDiscoveryNetworkMap([first, second]);

    expect(map.size).toBe(1);
    expect(map.get('solana:WIF')?.address).toBe('addr-1');
  });
});

describe('findDexPositionForTarget', () => {
  it('prefers an exact network-qualified position match when available', () => {
    const positions = [
      { instrumentId: 'solana:BONK/USDC', side: 'long', size: '1', entryPrice: '0.1', unrealizedPnlUsd: null, openedAt: null, holdDurationMinutes: null, venueType: 'dex', freshness: { state: 'fresh', provider: 'runtime' } },
      { instrumentId: 'ethereum:BONK/USDC', side: 'long', size: '2', entryPrice: '0.2', unrealizedPnlUsd: null, openedAt: null, holdDurationMinutes: null, venueType: 'dex', freshness: { state: 'fresh', provider: 'runtime' } },
    ] as const;

    const target = { raw: 'solana:BONK', network: 'solana', symbol: 'BONK' };
    const match = findDexPositionForTarget([...positions], target);

    expect(match?.instrumentId).toBe('solana:BONK/USDC');
  });
});

describe('buildDiscoveryAddressMap', () => {
  it('keys by network:address instead of network:symbol', () => {
    const tokens = [
      { network: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      { network: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
    ];
    const map = buildDiscoveryAddressMap(tokens);
    expect(map.size).toBe(2);
    expect(map.get('solana:so11111111111111111111111111111111111111112')?.symbol).toBe('SOL');
    expect(map.get('solana:epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v')?.symbol).toBe('USDC');
  });

  it('prevents same-symbol fakes from inheriting metadata', () => {
    const canonical = { network: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' };
    const fake = { network: 'solana', address: 'FAKE_SOL_ADDRESS', symbol: 'SOL' };
    const map = buildDiscoveryAddressMap([canonical, fake]);

    // Both are separate entries
    expect(map.size).toBe(2);
    expect(map.get('solana:so11111111111111111111111111111111111111112')).toBeDefined();
    expect(map.get('solana:fake_sol_address')).toBeDefined();

    // A lookup for the fake address does NOT return canonical metadata
    expect(map.get('solana:fake_sol_address')?.address).toBe('FAKE_SOL_ADDRESS');
  });

  it('normalizes network and address to lowercase', () => {
    const token = { network: 'Solana', address: '0xABC123', symbol: 'TEST' };
    const map = buildDiscoveryAddressMap([token]);
    expect(map.has('solana:0xabc123')).toBe(true);
  });
});

// ── B2 read-boundary payload parsers ────────────────────────────────────────
// These narrow the Traderton `check_regime` / `get_market_overview` /
// `discover_tokens` / `search_tokens` success payloads (which arrive as
// `unknown` over REST) into the exact in-process shapes the regime tick gate +
// venue-intelligence consumers already build. The runtime boundary re-point in
// agent.ts relies on these to preserve field/freshness parity, so they mirror
// the mapping the coordinator's parseRegimePayload asserts.

describe('parseRegimeBoundaryPayload', () => {
  it('maps a check_regime success payload into a RegimeResult plus freshness', () => {
    const parsed = parseRegimeBoundaryPayload({
      ok: true,
      pass: true,
      reasons: ['bullish', 'trend confirmed'],
      details: {
        benchmarkSymbol: 'BTC',
        currentPrice: 65000,
        emaFast: 1,
        emaSlow: 2,
        emaTrend: 3,
        emaAlignment: 'bullish',
        adxValue: 27.5,
        choppy: false,
        vwap: 64000,
        priceAboveVwap: true,
        marketStructure: 'higherHighs',
      },
      freshness: { provider: 'binance', source: 'upstream', ageMs: 1234, isStale: false },
    });

    expect(parsed.regime.pass).toBe(true);
    expect(parsed.regime.reasons).toEqual(['bullish', 'trend confirmed']);
    expect(parsed.regime.details).toEqual({
      benchmarkSymbol: 'BTC',
      currentPrice: 65000,
      emaFast: 1,
      emaSlow: 2,
      emaTrend: 3,
      emaAlignment: 'bullish',
      adxValue: 27.5,
      choppy: false,
      vwap: 64000,
      priceAboveVwap: true,
      marketStructure: 'higherHighs',
    });
    expect(parsed.freshness).toEqual({ provider: 'binance', source: 'upstream', ageMs: 1234, isStale: false });
  });

  it('reports a failing regime with an absent freshness as null', () => {
    const parsed = parseRegimeBoundaryPayload({ ok: true, pass: false, reasons: ['choppy'], details: {} });
    expect(parsed.regime.pass).toBe(false);
    expect(parsed.regime.reasons).toEqual(['choppy']);
    expect(parsed.freshness).toBeNull();
  });

  it('defaults a cache freshness source and stale flag from the boundary payload', () => {
    const parsed = parseRegimeBoundaryPayload({
      pass: true,
      reasons: [],
      details: {},
      freshness: { source: 'cache', ageMs: 5000, isStale: true },
    });
    expect(parsed.freshness).toEqual({ provider: 'binance', source: 'cache', ageMs: 5000, isStale: true });
  });

  it('narrows a malformed payload without throwing', () => {
    const parsed = parseRegimeBoundaryPayload(null);
    expect(parsed.regime.pass).toBe(false);
    expect(parsed.regime.reasons).toEqual([]);
    expect(parsed.regime.details.emaAlignment).toBe('bullish');
    expect(parsed.regime.details.marketStructure).toBe('mixed');
    expect(parsed.freshness).toBeNull();
  });

  it('drops non-string reasons entries', () => {
    const parsed = parseRegimeBoundaryPayload({ pass: true, reasons: ['ok', 42, null], details: {} });
    expect(parsed.regime.reasons).toEqual(['ok']);
  });
});

describe('parseMarketOverviewPayload', () => {
  it('preserves every per-symbol perps field the venue-intel signal renders', () => {
    const parsed = parseMarketOverviewPayload({
      ok: true,
      overview: [
        {
          symbol: 'BTC',
          price: 65000,
          change24hPct: 1.5,
          volume24hUsd: 1_000_000,
          fundingRate: 0.0001,
          openInterest: 2500,
          markOracleSpreadPct: 0.05,
          longShortRatio: 1.8,
        },
      ],
      freshness: { source: 'upstream', ageMs: 0, isStale: false },
    });

    expect(parsed.overview).toEqual([
      {
        symbol: 'BTC',
        price: 65000,
        change24hPct: 1.5,
        volume24hUsd: 1_000_000,
        fundingRate: 0.0001,
        openInterest: 2500,
        markOracleSpreadPct: 0.05,
        longShortRatio: 1.8,
      },
    ]);
    expect(parsed.freshness).toEqual({ isStale: false, ageMs: 0 });
  });

  it('coerces missing or non-numeric fields to null and preserves stale freshness', () => {
    const parsed = parseMarketOverviewPayload({
      overview: [{ symbol: 'ETH', longShortRatio: null }],
      freshness: { isStale: true, ageMs: 8000 },
    });

    expect(parsed.overview[0]).toEqual({
      symbol: 'ETH',
      price: null,
      change24hPct: null,
      volume24hUsd: null,
      fundingRate: null,
      openInterest: null,
      markOracleSpreadPct: null,
      longShortRatio: null,
    });
    expect(parsed.freshness).toEqual({ isStale: true, ageMs: 8000 });
  });

  it('narrows a malformed payload to an empty overview', () => {
    const parsed = parseMarketOverviewPayload({});
    expect(parsed.overview).toEqual([]);
    expect(parsed.freshness).toEqual({ isStale: false, ageMs: 0 });
  });
});

describe('parseDexTokensPayload', () => {
  it('preserves every DEX field the venue-intel signal + discovery join consume', () => {
    const parsed = parseDexTokensPayload({
      ok: true,
      tokens: [
        {
          symbol: 'BONK',
          network: 'solana',
          address: 'DezX',
          priceUsd: 0.000012,
          liquidityUsd: 500_000,
          volume24hUsd: 250_000,
          priceChange24hPct: 12.5,
          poolCreatedAt: '2026-06-09T00:00:00.000Z',
          discoveryVectors: ['trending', 'volume'],
        },
      ],
      freshness: { source: 'upstream', ageMs: 100, isStale: false },
    });

    expect(parsed.tokens).toEqual([
      {
        symbol: 'BONK',
        network: 'solana',
        address: 'DezX',
        priceUsd: 0.000012,
        liquidityUsd: 500_000,
        volume24hUsd: 250_000,
        priceChange24hPct: 12.5,
        poolCreatedAt: '2026-06-09T00:00:00.000Z',
        discoveryVectors: ['trending', 'volume'],
      },
    ]);
    expect(parsed.freshness).toEqual({ isStale: false, ageMs: 100 });
  });

  it('narrows a missing poolCreatedAt to null and missing vectors to an empty array', () => {
    const parsed = parseDexTokensPayload({
      tokens: [{ symbol: 'WIF', network: 'solana', address: 'addr' }],
      freshness: { isStale: true, ageMs: 4000 },
    });

    expect(parsed.tokens[0]).toEqual({
      symbol: 'WIF',
      network: 'solana',
      address: 'addr',
      priceUsd: 0,
      liquidityUsd: 0,
      volume24hUsd: 0,
      priceChange24hPct: 0,
      poolCreatedAt: null,
      discoveryVectors: [],
    });
    expect(parsed.freshness).toEqual({ isStale: true, ageMs: 4000 });
  });

  it('drops non-string discovery vectors and narrows a malformed payload', () => {
    const parsed = parseDexTokensPayload({ tokens: [{ symbol: 'A', network: 'n', address: 'x', discoveryVectors: ['v', 3, null] }] });
    expect(parsed.tokens[0]?.discoveryVectors).toEqual(['v']);
    expect(parseDexTokensPayload(undefined).tokens).toEqual([]);
  });

  it('parses the address map join key produced from a boundary discovery payload', () => {
    const parsed = parseDexTokensPayload({
      tokens: [{ symbol: 'SOL', network: 'Solana', address: '0xABC', poolCreatedAt: '2026-06-01T00:00:00.000Z', discoveryVectors: ['trending'] }],
    });
    const map = buildDiscoveryAddressMap(parsed.tokens);
    expect(map.get('solana:0xabc')?.poolCreatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(map.get('solana:0xabc')?.discoveryVectors).toEqual(['trending']);
  });
});
