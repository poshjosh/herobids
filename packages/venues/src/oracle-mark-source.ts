import type { MarkSource, Mark, MarkError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, price } from '@herobids/domain';

/**
 * Hardcoded CoinGecko coin IDs keyed by bare ticker.
 * CoinGecko IDs are permanent — they never change once assigned.
 */
const COIN_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  HYPE: 'hyperliquid',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  ARB: 'arbitrum',
  OP: 'optimism',
  SUI: 'sui',
  JUP: 'jupiter-exchange-solana',
  BONK: 'bonk',
};

const TICKER_ALIAS_MAP: Record<string, string> = {
  WBTC: 'BTC',
  WETH: 'ETH',
  WSOL: 'SOL',
};

function normalizeTicker(symbol: string): string {
  const upperSymbol = symbol.toUpperCase();
  return TICKER_ALIAS_MAP[upperSymbol] ?? upperSymbol;
}

/**
 * Resolve a CoinGecko coin ID from any instrument format.
 *
 * Supported input formats:
 *   - Bare ticker (perps agent boundary): "BTC", "SOL", "HYPE"
 *   - Qualified perpetual (CCXT-unified): "BTC/USD:USD", "ETH/USDT:USDT"
 *   - Swap pair: "SOL/USDC", "ETH/USDC"
 *   - Dash-suffixed: "BTC-PERP"
 *
 * Resolution order:
 *   1. Direct match in COIN_ID_MAP (handles bare tickers)
 *   2. Extract base from qualified form via split('/')[0], strip -PERP suffix
 */
export function resolveCoinId(instrument: string): string | undefined {
  const direct = COIN_ID_MAP[normalizeTicker(instrument)];
  if (direct) return direct;

  // Extract bare ticker: "BTC/USD:USD" → "BTC", "BTC-PERP" → "BTC"
  const base = normalizeTicker(instrument.split(/[/\-]/)[0] ?? '');
  return COIN_ID_MAP[base];
}

export interface OracleMarkSourceConfig {
  /** Base URL for the pricing oracle. Default: 'https://api.coingecko.com/api/v3' */
  baseUrl?: string;
  timeoutMs?: number;
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
  private readonly vsCurrency: string;

  constructor(config: OracleMarkSourceConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.vsCurrency = config.vsCurrency ?? 'usd';
  }

  async fetchMark(instrument: string): Promise<Result<Mark, MarkError>> {
    const coinId = resolveCoinId(instrument);
    if (!coinId) {
      return err({
        code: 'mark.unknown_instrument',
        message: `No CoinGecko mapping for instrument: ${instrument}`,
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
