import type { MarkSource, Mark, MarkError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, price } from '@herobids/domain';

/**
 * HyperliquidMarkSource — fetches mid prices from Hyperliquid's own API.
 *
 * Hyperliquid's /info endpoint with {"type": "allMids"} returns mid prices
 * for every listed perpetual: {"BTC": "97234.5", "LIT": "2.225", ...}.
 * This is the authoritative price source for Hyperliquid's own instruments,
 * eliminating the need for CoinGecko fallback on perp symbols.
 *
 * Used as an intermediate fallback in the mark source chain:
 *   LastFillMarkSource → HyperliquidMarkSource → OracleMarkSource (CoinGecko)
 */
export class HyperliquidMarkSource implements MarkSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private midPrices: Map<string, string> = new Map();
  private lastFetchMs: number = 0;
  /** How long cached mid prices are considered fresh (30s default) */
  private readonly cacheTtlMs: number;

  constructor(config?: { baseUrl?: string; timeoutMs?: number; cacheTtlMs?: number }) {
    this.baseUrl = (config?.baseUrl ?? 'https://api.hyperliquid.xyz/info').replace(/\/$/, '');
    this.timeoutMs = config?.timeoutMs ?? 5_000;
    this.cacheTtlMs = config?.cacheTtlMs ?? 30_000;
  }

  async fetchMark(instrument: string): Promise<Result<Mark, MarkError>> {
    // Strip -PERP suffix: "LIT-PERP" → "LIT", "BTC-PERP" → "BTC"
    const ticker = instrument.replace(/-PERP$/i, '').toUpperCase();

    try {
      // Refresh cache if stale
      const now = Date.now();
      if (now - this.lastFetchMs > this.cacheTtlMs || this.midPrices.size === 0) {
        await this.refreshMidPrices();
      }

      const midPrice = this.midPrices.get(ticker);
      if (!midPrice) {
        return err({
          code: 'mark.hyperliquid_unknown_symbol',
          message: `Hyperliquid has no mid price for: ${ticker}`,
        });
      }

      return ok({
        price: price(midPrice),
        source: 'hyperliquid_mid' as const,
        instrument,
        timestamp: new Date(this.lastFetchMs).toISOString(),
      });
    } catch (error) {
      return err({
        code: 'mark.hyperliquid_fetch_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshMidPrices(): Promise<void> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid /info returned ${response.status}: ${await response.text().catch(() => '')}`);
    }

    const raw = await response.json() as Record<string, string>;
    // Response: {"BTC": "97234.5", "ETH": "3421.0", ...}
    // Convert all keys to uppercase for case-insensitive lookup
    const prices = new Map<string, string>();
    for (const [key, value] of Object.entries(raw)) {
      prices.set(key.toUpperCase(), value);
    }

    this.midPrices = prices;
    this.lastFetchMs = Date.now();
  }
}
