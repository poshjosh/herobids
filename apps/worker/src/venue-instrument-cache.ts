import type { Logger } from 'pino';

export interface VenueSymbolProvider {
  venue: string;
  /**
   * Fetch available symbols as raw string[].
   * Callers must unwrap `Result<string[], E>` from venue adapters before passing to the cache.
   */
  fetchSymbols: () => Promise<string[]>;
  normalizeSymbol?: (raw: string) => string;
}

/**
 * In-memory cache of available symbols per venue.
 *
 * Periodic refresh keeps the cache in sync with venue instrument listings.
 * The cache gates decision intake validation — unknown symbols are rejected
 * before they reach the executor (critical for paper/shadow mode).
 */
export class VenueInstrumentCache {
  private cache = new Map<string, Set<string>>(); // venue → Set<normalized symbols>
  private normalizers = new Map<string, (raw: string) => string>();
  private ready = false;
  private refreshInterval?: ReturnType<typeof setInterval>;
  private readonly logger: Logger;

  constructor(log: Logger) {
    this.logger = log;
  }

  /**
   * Fetch all symbols from all providers and populate the in-memory cache.
   * Blocks until all providers have been fetched (fail-closed: one failure fails warmup).
   */
  async warmup(providers: VenueSymbolProvider[]): Promise<void> {
    this.logger.info('VenueInstrumentCache: starting warmup...');

    for (const provider of providers) {
      try {
        const symbols = await provider.fetchSymbols();
        const normalizedSet = new Set<string>();
        const normalize = provider.normalizeSymbol ?? ((s: string) => s);
        this.normalizers.set(provider.venue, normalize);

        for (const symbol of symbols) {
          normalizedSet.add(normalize(symbol));
        }

        this.cache.set(provider.venue, normalizedSet);
        this.logger.info(
          `VenueInstrumentCache: ${provider.venue} — ${normalizedSet.size} symbols cached`,
        );
      } catch (err) {
        this.logger.error(
          { err },
          `VenueInstrumentCache: failed to fetch symbols for ${provider.venue}`,
        );
        throw err; // fail-closed
      }
    }

    this.ready = true;
    this.logger.info('VenueInstrumentCache: warmup complete, ready for validation');
  }

  /**
   * Check if a symbol exists on a given venue.
   * Symbol is normalized before lookup using the provider's normalizeSymbol function.
   *
   * Returns true for unknown venues and when not ready — fail-open at the cache level.
   * Callers should guard with {@link isReady} before accepting decisions.
   */
  hasSymbol(venue: string, symbol: string): boolean {
    if (!this.ready) return true;
    const symbols = this.cache.get(venue);
    if (!symbols) return true; // unknown venue — don't block
    const normalizer = this.normalizers.get(venue);
    if (normalizer) {
      symbol = normalizer(symbol);
    }
    return symbols.has(symbol);
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Start periodic cache refresh. Refreshes all providers every intervalMs.
   * On refresh failure, the stale cache is kept (don't clear on error).
   */
  startPeriodicRefresh(providers: VenueSymbolProvider[], intervalMs: number): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    this.refreshInterval = setInterval(async () => {
      this.logger.info('VenueInstrumentCache: periodic refresh starting...');
      for (const provider of providers) {
        try {
          const symbols = await provider.fetchSymbols();
          const normalizedSet = new Set<string>();
          const normalize = provider.normalizeSymbol ?? ((s: string) => s);
          this.normalizers.set(provider.venue, normalize);
          for (const symbol of symbols) {
            normalizedSet.add(normalize(symbol));
          }
          this.cache.set(provider.venue, normalizedSet);
          this.logger.info(
            `VenueInstrumentCache: ${provider.venue} refreshed — ${normalizedSet.size} symbols`,
          );
        } catch (err) {
          this.logger.error(
            { err },
            `VenueInstrumentCache: refresh failed for ${provider.venue}, keeping stale cache`,
          );
          // Keep stale cache on refresh failure
        }
      }
      this.logger.info('VenueInstrumentCache: periodic refresh complete');
    }, intervalMs);
  }

  /**
   * Stop periodic refresh. Safe to call multiple times.
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /**
   * Get the number of cached symbols for a venue. Useful for diagnostics.
   */
  getSymbolCount(venue: string): number {
    return this.cache.get(venue)?.size ?? 0;
  }
}

/**
 * Normalize Hyperliquid symbols: strip -PERP suffix, uppercase.
 * "BTC-PERP" → "BTC", "eth-perp" → "ETH"
 */
export function normalizeHyperliquidSymbol(raw: string): string {
  const upper = raw.toUpperCase();
  // Strip /QUOTE:QUOTE suffix first, then strip -PERP.
  // Order matters: 'ETH-PERP/USD:USD' → /USD:USD removed → 'ETH-PERP' → -PERP removed → 'ETH'
  return upper.replace(/\/.*$/, '').replace(/-PERP$/i, '');
}

/**
 * Normalize Bybit symbols: strip separators, uppercase.
 * "BTC-USDT" → "BTCUSDT", "BTC/USDT:USDT" → "BTCUSDT"
 */
export function normalizeBybitSymbol(raw: string): string {
  return raw.toUpperCase().replace(/[-/:]/g, '');
}

/**
 * Identity normalizer for venues that use exact addresses (Jupiter mint addresses, 1inch token addresses).
 */
export function identityNormalize(raw: string): string {
  return raw;
}
