import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HyperliquidMarkSource } from './hyperliquid-mark-source.js';

describe('HyperliquidMarkSource', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns hyperliquid_mid mark on successful fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ BTC: '97234.5', ETH: '3421.0' }),
    });

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 });
    const result = await source.fetchMark('BTC-PERP');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('hyperliquid_mid');
      expect(result.data.price.toString()).toBe('97234.5');
      expect(result.data.instrument).toBe('BTC-PERP');
    }
  });

  it('strips -PERP suffix when looking up mid prices', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ LIT: '2.225' }),
    });

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 });
    const result = await source.fetchMark('LIT-PERP');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.price.toString()).toBe('2.225');
    }
  });

  it('is case-insensitive on instrument symbol', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ BTC: '97234.5' }),
    });

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 });
    const result = await source.fetchMark('btc-perp');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.price.toString()).toBe('97234.5');
    }
  });

  it('returns error for unlisted instrument', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ BTC: '97234.5', ETH: '3421.0' }),
    });

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 });
    const result = await source.fetchMark('UNKNOWN-PERP');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.hyperliquid_unknown_symbol');
    }
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 });
    const result = await source.fetchMark('BTC-PERP');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.hyperliquid_fetch_failed');
    }
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 });
    const result = await source.fetchMark('BTC-PERP');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.hyperliquid_fetch_failed');
    }
  });

  it('caches mid prices within TTL window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ BTC: '97234.5' }),
    });
    globalThis.fetch = fetchMock;

    const source = new HyperliquidMarkSource({ cacheTtlMs: 60_000 });

    // First call — should hit the API
    const result1 = await source.fetchMark('BTC-PERP');
    expect(result1.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL — should use cache
    const result2 = await source.fetchMark('ETH-PERP');
    expect(result2.ok).toBe(false); // ETH not in response, but cache is used
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second API call
  });

  it('refreshes cache when TTL expires', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ BTC: '97234.5' }),
    });
    globalThis.fetch = fetchMock;

    const source = new HyperliquidMarkSource({ cacheTtlMs: 0 }); // 0 TTL = always refresh

    await source.fetchMark('BTC-PERP');
    await source.fetchMark('BTC-PERP');

    // With 0 TTL, each call should hit the API
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
