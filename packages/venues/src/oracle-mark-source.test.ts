import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OracleMarkSource, resolveCoinId } from './oracle-mark-source.js';

describe('resolveCoinId', () => {
  it('resolves bare ticker', () => {
    expect(resolveCoinId('BTC')).toBe('bitcoin');
    expect(resolveCoinId('SOL')).toBe('solana');
    expect(resolveCoinId('HYPE')).toBe('hyperliquid');
  });

  it('resolves wrapped ticker aliases', () => {
    expect(resolveCoinId('WBTC')).toBe('bitcoin');
    expect(resolveCoinId('WETH')).toBe('ethereum');
    expect(resolveCoinId('WSOL')).toBe('solana');
  });

  it('resolves qualified perpetual format', () => {
    expect(resolveCoinId('BTC/USD:USD')).toBe('bitcoin');
    expect(resolveCoinId('ETH/USDT:USDT')).toBe('ethereum');
  });

  it('resolves documented swap pair symbols', () => {
    expect(resolveCoinId('ETH/USDC')).toBe('ethereum');
    expect(resolveCoinId('WBTC/USDC')).toBe('bitcoin');
  });

  it('resolves dash-suffixed format', () => {
    expect(resolveCoinId('BTC-PERP')).toBe('bitcoin');
  });

  it('is case-insensitive on bare ticker', () => {
    expect(resolveCoinId('btc')).toBe('bitcoin');
    expect(resolveCoinId('Eth')).toBe('ethereum');
  });

  it('returns undefined for unmapped instrument', () => {
    expect(resolveCoinId('UNKNOWN')).toBeUndefined();
    expect(resolveCoinId('XYZ/USD:USD')).toBeUndefined();
  });
});

describe('OracleMarkSource', () => {
  const config = {
    baseUrl: 'https://api.coingecko.com/api/v3',
    timeoutMs: 5000,
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns oracle mark on successful fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 67500.25 } }),
    });

    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('BTC');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
      expect(result.data.price.toString()).toBe('67500.25');
      expect(result.data.instrument).toBe('BTC');
      expect(result.data.timestamp).toBeDefined();
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('resolves qualified perpetual format', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 67500.25 } }),
    });

    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('BTC/USD:USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.instrument).toBe('BTC/USD:USD');
    }
  });

  it('returns error for unknown instrument', async () => {
    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('UNKNOWN_COIN');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.unknown_instrument');
      expect(result.error.message).toContain('UNKNOWN_COIN');
    }
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('BTC/USD:USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.oracle_fetch_failed');
      expect(result.error.message).toContain('429');
    }
  });

  it('returns error when response has no price data for coin', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: {} }), // no usd key
    });

    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('BTC/USD:USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.oracle_no_data');
      expect(result.error.message).toContain('bitcoin');
    }
  });

  it('returns error when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('ETH/USD:USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.oracle_error');
      expect(result.error.message).toContain('ECONNREFUSED');
    }
  });

  it('strips trailing slash from baseUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 67000 } }),
    });

    const source = new OracleMarkSource({
      ...config,
      baseUrl: 'https://api.coingecko.com/api/v3/',
    });
    await source.fetchMark('BTC/USD:USD');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.coingecko\.com\/api\/v3\/simple/),
      expect.anything(),
    );
  });

  it('uses custom vsCurrency', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { eur: 62000 } }),
    });

    const source = new OracleMarkSource({
      ...config,
      vsCurrency: 'eur',
    });
    const result = await source.fetchMark('BTC/USD:USD');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('vs_currencies=eur'),
      expect.anything(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.price.toString()).toBe('62000');
    }
  });

  it('builds the oracle request URL with the resolved coin id', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 100 } }),
    });

    const source = new OracleMarkSource({
      baseUrl: 'https://api.example.com',
    });
    await source.fetchMark('BTC');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('ids=bitcoin'),
      expect.anything(),
    );
  });

  it('returns error when coin data missing from response entirely', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}), // empty response
    });

    const source = new OracleMarkSource(config);
    const result = await source.fetchMark('BTC/USD:USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.oracle_no_data');
    }
  });
});
