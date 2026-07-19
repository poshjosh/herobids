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
  private failedProviders = new Set<string>(); // venues whose symbol fetch failed at warmup
  private refreshInterval?: ReturnType<typeof setInterval>;
  private readonly logger: Logger;

  constructor(log: Logger) {
    this.logger = log;
  }

  /**
   * Fetch all symbols from all providers and populate the in-memory cache.
   * Failed providers are skipped with an error log — symbol validation for that
   * venue falls back to fail-open (hasSymbol returns true for unknown venues).
   * This prevents a single unreachable external token list from crashing the worker.
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
        // Clear any prior degraded state from a previous failed warmup call.
        this.failedProviders.delete(provider.venue);
        this.logger.info(
          `VenueInstrumentCache: ${provider.venue} — ${normalizedSet.size} symbols cached`,
        );
      } catch (err) {
        this.failedProviders.add(provider.venue);
        this.logger.error(
          { err },
          `VenueInstrumentCache: failed to fetch symbols for ${provider.venue} — symbol validation disabled for this venue`,
        );
        // Skip this provider; hasSymbol() returns true for degraded venues (fail-open).
      }
    }

    this.ready = true;
    const degraded = [...this.failedProviders];
    if (degraded.length > 0) {
      this.logger.warn(
        { degradedVenues: degraded },
        `VenueInstrumentCache: warmup complete with degraded venues — symbol validation disabled for: ${degraded.join(', ')}`,
      );
    } else {
      this.logger.info('VenueInstrumentCache: warmup complete, ready for validation');
    }
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
    if (this.failedProviders.has(venue)) return true; // degraded provider — fail-open
    const symbols = this.cache.get(venue);
    if (!symbols) return true; // venue not configured — don't block
    const normalizer = this.normalizers.get(venue);
    if (normalizer) {
      symbol = normalizer(symbol);
    }
    return symbols.has(symbol);
  }

  /** Returns venues whose symbol fetch failed during the last warmup. */
  getFailedProviders(): ReadonlySet<string> {
    return this.failedProviders;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get the set of known normalized symbols for a venue.
   * Returns null if the cache is not ready, the venue is not configured,
   * or the provider is in a degraded/failed state.
   *
   * Unlike hasSymbol(), this does NOT fail-open — null means "cannot validate."
   */
  getKnownSymbols(venue: string): Set<string> | null {
    if (!this.ready) return null;
    if (this.failedProviders.has(venue)) return null;
    return this.cache.get(venue) ?? null;
  }

  /**
   * Returns true when the cache is ready, the venue is configured, and the
   * provider is not in a degraded/failed state — i.e. symbol validation is
   * reliable for this venue.
   */
  isVenueReady(venue: string): boolean {
    return this.ready && !this.failedProviders.has(venue) && this.cache.has(venue);
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
          if (this.failedProviders.has(provider.venue)) {
            this.failedProviders.delete(provider.venue);
            this.logger.info(
              { venue: provider.venue },
              `VenueInstrumentCache: ${provider.venue} recovered — symbol validation re-enabled`,
            );
          } else {
            this.logger.info(
              `VenueInstrumentCache: ${provider.venue} refreshed — ${normalizedSet.size} symbols`,
            );
          }
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
