import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VenueInstrumentCache,
  normalizeHyperliquidSymbol,
  normalizeBybitSymbol,
  identityNormalize,
  type VenueSymbolProvider,
} from './venue-instrument-cache.js';
import type { Logger } from 'pino';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: 'info',
    silent: vi.fn(),
  } as unknown as Logger;
}

function makeProvider(
  venue: string,
  symbols: string[],
  normalizeSymbol?: (raw: string) => string,
): VenueSymbolProvider {
  return {
    venue,
    normalizeSymbol,
    fetchSymbols: vi.fn().mockResolvedValue(symbols),
  };
}

describe('VenueInstrumentCache', () => {
  let cache: VenueInstrumentCache;
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    cache = new VenueInstrumentCache(logger);
  });

  describe('isReady', () => {
    it('returns false before warmup', () => {
      expect(cache.isReady()).toBe(false);
    });

    it('returns true after warmup completes', async () => {
      await cache.warmup([makeProvider('hyperliquid', ['BTC', 'ETH'])]);
      expect(cache.isReady()).toBe(true);
    });
  });

  describe('hasSymbol', () => {
    it('returns true for all symbols when cache is not ready (fail-open)', () => {
      expect(cache.hasSymbol('hyperliquid', 'NONEXISTENT')).toBe(true);
      expect(cache.hasSymbol('unknown-venue', 'ANYTHING')).toBe(true);
    });

    it('returns true for unknown venues when cache is ready', async () => {
      await cache.warmup([makeProvider('hyperliquid', ['BTC'])]);
      expect(cache.hasSymbol('unknown-venue', 'BTC')).toBe(true);
    });

    it('finds a known symbol after warmup', async () => {
      await cache.warmup([makeProvider('hyperliquid', ['BTC', 'ETH', 'SOL'])]);
      expect(cache.hasSymbol('hyperliquid', 'BTC')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'ETH')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'SOL')).toBe(true);
    });

    it('rejects an unknown symbol after warmup', async () => {
      await cache.warmup([makeProvider('hyperliquid', ['BTC', 'ETH'])]);
      expect(cache.hasSymbol('hyperliquid', 'DOGE')).toBe(false);
    });

    it('applies Hyperliquid normalization on lookup', async () => {
      await cache.warmup([
        makeProvider('hyperliquid', ['BTC/USD:USD', 'ETH/USD:USD'], normalizeHyperliquidSymbol),
      ]);
      // Cache stores normalized: BTC, ETH
      expect(cache.hasSymbol('hyperliquid', 'BTC-PERP')).toBe(true);  // strip -PERP → BTC
      expect(cache.hasSymbol('hyperliquid', 'BTC/USD:USD')).toBe(true); // strip /USD:USD → BTC
      expect(cache.hasSymbol('hyperliquid', 'btc')).toBe(true);         // uppercase → BTC
      expect(cache.hasSymbol('hyperliquid', 'ETH-PERP')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'SOL-PERP')).toBe(false);
    });

    it('applies Bybit normalization on lookup', async () => {
      await cache.warmup([
        makeProvider('bybit', ['BTCUSDT', 'ETHUSDT'], normalizeBybitSymbol),
      ]);
      // Cache stores normalized: BTCUSDT, ETHUSDT
      // normalizeBybitSymbol strips ALL - / : characters and uppercases.
      // 'BTC-USDT' → 'BTCUSDT' (matches cache)
      expect(cache.hasSymbol('bybit', 'BTC-USDT')).toBe(true);
      // 'BTC/USDT:USDT' → 'BTCUSDTUSDT' (does NOT match 'BTCUSDT' in cache)
      // Known limitation: normalizer cannot distinguish quote/settle separators
      expect(cache.hasSymbol('bybit', 'BTC/USDT:USDT')).toBe(false);
      expect(cache.hasSymbol('bybit', 'btcusdt')).toBe(true);        // uppercase
      expect(cache.hasSymbol('bybit', 'SOLUSDT')).toBe(false);
    });

    it('applies identity normalization on lookup (Jupiter mint addresses)', async () => {
      const mint = 'So11111111111111111111111111111111111111112';
      await cache.warmup([
        makeProvider('jupiter', [mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'], identityNormalize),
      ]);
      expect(cache.hasSymbol('jupiter', mint)).toBe(true);
      expect(cache.hasSymbol('jupiter', mint.toLowerCase())).toBe(false); // identity: exact match
      expect(cache.hasSymbol('jupiter', 'UnknownMintAddress')).toBe(false);
    });

    it('uses identity normalizer when no normalizer is provided', async () => {
      await cache.warmup([
        makeProvider('test-venue', ['SYMBOL1', 'SYMBOL2']), // no normalizeSymbol
      ]);
      expect(cache.hasSymbol('test-venue', 'SYMBOL1')).toBe(true);
      expect(cache.hasSymbol('test-venue', 'symbol1')).toBe(false); // exact match only
    });
  });

  describe('warmup', () => {
    it('populates multiple venues independently', async () => {
      await cache.warmup([
        makeProvider('hyperliquid', ['BTC', 'ETH'], normalizeHyperliquidSymbol),
        makeProvider('bybit', ['BTCUSDT', 'ETHUSDT'], normalizeBybitSymbol),
      ]);
      expect(cache.isReady()).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'BTC-PERP')).toBe(true);
      expect(cache.hasSymbol('bybit', 'BTC-USDT')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'BTCUSDT')).toBe(false); // wrong venue
      expect(cache.hasSymbol('bybit', 'BTC')).toBe(false);           // wrong venue
    });

    it('skips a failing provider and keeps warmup going', async () => {
      const failingProvider = makeProvider('bad-venue', []);
      failingProvider.fetchSymbols = vi.fn().mockRejectedValue(new Error('API down'));
      // Should NOT throw — worker must not crash because one token list is unreachable
      await cache.warmup([makeProvider('hyperliquid', ['BTC', 'ETH'], normalizeHyperliquidSymbol), failingProvider]);
      expect(cache.isReady()).toBe(true);
      // Failed venue is explicitly tracked
      expect(cache.getFailedProviders().has('bad-venue')).toBe(true);
      expect(cache.getFailedProviders().has('hyperliquid')).toBe(false);
      // Failed venue is fail-open
      expect(cache.hasSymbol('bad-venue', 'ANYTHING')).toBe(true);
      // Healthy venues still validate correctly
      expect(cache.hasSymbol('hyperliquid', 'BTC')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'DOGE')).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });

    it('tracks all failed providers when every provider fails', async () => {
      const failing = makeProvider('bad-venue', []);
      failing.fetchSymbols = vi.fn().mockRejectedValue(new Error('API down'));
      await cache.warmup([failing]);
      expect(cache.isReady()).toBe(true);
      expect(cache.getFailedProviders().has('bad-venue')).toBe(true);
      expect(cache.hasSymbol('bad-venue', 'ANYTHING')).toBe(true);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled(); // degraded warmup summary
    });

    it('clears degraded status on a successful re-warmup', async () => {
      const fetchSymbols = vi.fn()
        .mockRejectedValueOnce(new Error('API down')) // first warmup fails
        .mockResolvedValueOnce(['BTC', 'ETH']);        // second warmup succeeds

      const provider: VenueSymbolProvider = {
        venue: 'hyperliquid',
        fetchSymbols,
        normalizeSymbol: normalizeHyperliquidSymbol,
      };

      await cache.warmup([provider]);
      expect(cache.getFailedProviders().has('hyperliquid')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'BTC')).toBe(true); // fail-open while degraded

      await cache.warmup([provider]);
      expect(cache.getFailedProviders().has('hyperliquid')).toBe(false);
      expect(cache.hasSymbol('hyperliquid', 'BTC')).toBe(true);   // known symbol passes
      expect(cache.hasSymbol('hyperliquid', 'DOGE')).toBe(false); // unknown symbol blocked
    });

    it('handles empty symbol lists gracefully', async () => {
      await cache.warmup([makeProvider('empty-venue', [])]);
      expect(cache.isReady()).toBe(true);
      expect(cache.hasSymbol('empty-venue', 'ANYTHING')).toBe(false);
      expect(cache.getSymbolCount('empty-venue')).toBe(0);
    });
  });

  describe('periodic refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('refreshes symbols on interval', async () => {
      const fetchSymbols = vi.fn()
        .mockResolvedValueOnce(['BTC', 'ETH'])       // warmup
        .mockResolvedValueOnce(['BTC', 'ETH', 'SOL']); // first refresh

      const provider: VenueSymbolProvider = {
        venue: 'hyperliquid',
        fetchSymbols,
        normalizeSymbol: normalizeHyperliquidSymbol,
      };

      await cache.warmup([provider]);
      expect(cache.hasSymbol('hyperliquid', 'SOL-PERP')).toBe(false);

      cache.startPeriodicRefresh([provider], 60_000);
      // Advance past the first interval
      await vi.advanceTimersByTimeAsync(61_000);

      expect(cache.hasSymbol('hyperliquid', 'SOL-PERP')).toBe(true);
      expect(fetchSymbols).toHaveBeenCalledTimes(2); // warmup + 1 refresh
    });

    it('keeps stale cache on refresh failure', async () => {
      const fetchSymbols = vi.fn()
        .mockResolvedValueOnce(['BTC', 'ETH'])       // warmup
        .mockRejectedValueOnce(new Error('API down')); // refresh fails

      const provider: VenueSymbolProvider = {
        venue: 'hyperliquid',
        fetchSymbols,
        normalizeSymbol: normalizeHyperliquidSymbol,
      };

      await cache.warmup([provider]);
      cache.startPeriodicRefresh([provider], 60_000);
      await vi.advanceTimersByTimeAsync(61_000);

      // Stale cache is preserved — symbols from warmup still valid
      expect(cache.hasSymbol('hyperliquid', 'BTC')).toBe(true);
      expect(cache.hasSymbol('hyperliquid', 'ETH')).toBe(true);
      expect(logger.error).toHaveBeenCalled();
    });

    it('clears degraded status and re-enables validation after a successful refresh', async () => {
      // Warmup fails for jupiter — venue is degraded, hasSymbol is fail-open
      const fetchSymbols = vi.fn()
        .mockRejectedValueOnce(new Error('token list unreachable')) // warmup fails
        .mockResolvedValueOnce(['So11111111111111111111111111111111111111112']);  // refresh succeeds

      const provider: VenueSymbolProvider = {
        venue: 'jupiter',
        fetchSymbols,
        normalizeSymbol: identityNormalize,
      };

      await cache.warmup([provider]);
      expect(cache.getFailedProviders().has('jupiter')).toBe(true);
      expect(cache.hasSymbol('jupiter', 'UnknownMint')).toBe(true); // fail-open while degraded

      cache.startPeriodicRefresh([provider], 60_000);
      await vi.advanceTimersByTimeAsync(61_000);

      // Venue recovered — degraded flag cleared, validation active
      expect(cache.getFailedProviders().has('jupiter')).toBe(false);
      const knownMint = 'So11111111111111111111111111111111111111112';
      expect(cache.hasSymbol('jupiter', knownMint)).toBe(true);
      expect(cache.hasSymbol('jupiter', 'UnknownMint')).toBe(false); // now validates
    });
  });

  describe('stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops periodic refresh and does not fire again', async () => {
      const fetchSymbols = vi.fn()
        .mockResolvedValueOnce(['BTC'])
        .mockResolvedValueOnce(['BTC', 'ETH']);

      const provider: VenueSymbolProvider = {
        venue: 'hyperliquid',
        fetchSymbols,
      };

      await cache.warmup([provider]);
      cache.startPeriodicRefresh([provider], 60_000);
      cache.stop();
      await vi.advanceTimersByTimeAsync(120_000);

      // Only the warmup call — refresh was stopped before first interval
      expect(fetchSymbols).toHaveBeenCalledTimes(1);
    });

    it('is safe to call stop multiple times', () => {
      cache.stop();
      cache.stop();
      // Should not throw
    });
  });

  describe('getSymbolCount', () => {
    it('returns 0 for unknown venues', () => {
      expect(cache.getSymbolCount('nonexistent')).toBe(0);
    });

    it('returns cached count after warmup', async () => {
      await cache.warmup([makeProvider('hyperliquid', ['BTC', 'ETH', 'SOL'])]);
      expect(cache.getSymbolCount('hyperliquid')).toBe(3);
    });
  });
});

describe('normalizeHyperliquidSymbol', () => {
  it('strips -PERP suffix', () => {
    expect(normalizeHyperliquidSymbol('BTC-PERP')).toBe('BTC');
    expect(normalizeHyperliquidSymbol('ETH-PERP')).toBe('ETH');
    expect(normalizeHyperliquidSymbol('SOL-PERP')).toBe('SOL');
  });

  it('strips /QUOTE:QUOTE ccxt suffix', () => {
    expect(normalizeHyperliquidSymbol('BTC/USD:USD')).toBe('BTC');
    expect(normalizeHyperliquidSymbol('ETH/USDC:USDC')).toBe('ETH');
  });

  it('strips both -PERP and /QUOTE:QUOTE', () => {
    // Note: /QUOTE:QUOTE is stripped first internally, then -PERP.
    // Input 'BTC-PERP/USD:USD' → strip /USD:USD → 'BTC-PERP' → strip -PERP → 'BTC'
    expect(normalizeHyperliquidSymbol('BTC-PERP/USD:USD')).toBe('BTC');
  });

  it('uppercases input', () => {
    expect(normalizeHyperliquidSymbol('btc-perp')).toBe('BTC');
    expect(normalizeHyperliquidSymbol('eth/usd:usd')).toBe('ETH');
  });

  it('returns base currency unchanged if no suffix', () => {
    expect(normalizeHyperliquidSymbol('BTC')).toBe('BTC');
    expect(normalizeHyperliquidSymbol('1000PEPE')).toBe('1000PEPE');
  });
});

describe('normalizeBybitSymbol', () => {
  it('strips separators', () => {
    expect(normalizeBybitSymbol('BTC-USDT')).toBe('BTCUSDT');
    expect(normalizeBybitSymbol('BTC/USDT:USDT')).toBe('BTCUSDTUSDT');
  });

  it('uppercases input', () => {
    expect(normalizeBybitSymbol('btc-usdt')).toBe('BTCUSDT');
  });

  it('returns unchanged if no separators', () => {
    expect(normalizeBybitSymbol('BTCUSDT')).toBe('BTCUSDT');
  });
});

describe('identityNormalize', () => {
  it('returns input unchanged', () => {
    expect(identityNormalize('So11111111111111111111111111111111111111112')).toBe('So11111111111111111111111111111111111111112');
    expect(identityNormalize('0xABC')).toBe('0xABC');
    expect(identityNormalize('lowercase')).toBe('lowercase');
    expect(identityNormalize('AnOtHeR')).toBe('AnOtHeR');
  });
});
