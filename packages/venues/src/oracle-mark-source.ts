import type { MarkSource, Mark, MarkError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, price } from '@herobids/domain';

export interface OracleMarkSourceConfig {
  /** Base URL for the pricing oracle. Default: 'https://api.coingecko.com/api/v3' */
  baseUrl?: string;
  timeoutMs?: number;
  /** Mapping from instrument identifier to CoinGecko coin ID */
  instrumentToCoinId: Record<string, string>;
  /** Quote currency for price lookup. Default: 'usd' */
  vsCurrency?: string;
}

/**
 * OracleMarkSource — fetches reference mark prices from CoinGecko.
 * Used as fallback when last fill is stale (> stalenessThreshold).
 * Lives in venues/ (infrastructure) rather than engine (business logic).
 */
export class OracleMarkSource implements MarkSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly instrumentToCoinId: Record<string, string>;
  private readonly vsCurrency: string;

  constructor(config: OracleMarkSourceConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.instrumentToCoinId = config.instrumentToCoinId;
    this.vsCurrency = config.vsCurrency ?? 'usd';
  }

  async fetchMark(instrument: string): Promise<Result<Mark, MarkError>> {
    const coinId = this.instrumentToCoinId[instrument];
    if (!coinId) {
      return err({
        code: 'mark.unknown_instrument',
        message: `No CoinGecko mapping configured for instrument: ${instrument}`,
      });
    }

    try {
      const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=${this.vsCurrency}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({
          code: 'mark.oracle_fetch_failed',
          message: `CoinGecko API returned ${response.status}: ${await response.text()}`,
        });
      }

      const data = await response.json() as Record<string, Record<string, number>>;
      const coinData = data[coinId];
      const priceValue = coinData?.[this.vsCurrency];
      if (priceValue === undefined) {
        return err({
          code: 'mark.oracle_no_data',
          message: `CoinGecko returned no price data for ${coinId}`,
        });
      }

      return ok({
        price: price(priceValue.toString()),
        source: 'oracle' as const,
        instrument,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return err({
        code: 'mark.oracle_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
