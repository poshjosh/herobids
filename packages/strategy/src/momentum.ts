import type { Strategy, MarketSnapshot, StrategyError } from '@herobids/domain';
import type { Decision } from '@herobids/domain';
import type { DecisionId, TradingInstanceId, InstrumentId } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok } from '@herobids/domain';
import { quantity, Decimal } from '@herobids/domain';

/**
 * Momentum strategy configuration (from trading_instances.config).
 */
export interface MomentumConfig {
  /** Number of price snapshots to track for momentum calculation */
  lookbackPeriod: number;
  /** Minimum price change % to trigger a signal (e.g. 0.02 = 2%) */
  threshold: number;
  /** Position size in base units */
  positionSize: string;
  /** Instrument ID */
  instrumentId: string;
}

const DEFAULT_CONFIG: MomentumConfig = {
  lookbackPeriod: 5,
  threshold: 0.02,
  positionSize: '1',
  instrumentId: '',
};

/**
 * Simple momentum strategy.
 * Goes long when price rises > threshold% over lookback period.
 * Goes short when price drops > threshold% over lookback period.
 * Goes flat when momentum is within threshold.
 */
export class MomentumStrategy implements Strategy {
  readonly id = 'momentum-v1';
  readonly name = 'Simple Momentum';

  private priceHistory: Decimal[] = [];

  constructor(private readonly idGen: () => string) {}

  async evaluate(
    snapshot: MarketSnapshot,
    rawConfig: Record<string, unknown>,
  ): Promise<Result<Decision | null, StrategyError>> {
    const config = parseConfig(rawConfig);
    const currentPrice = snapshot.price;

    this.priceHistory.push(currentPrice);

    // Not enough data yet
    if (this.priceHistory.length < config.lookbackPeriod) {
      return ok(null);
    }

    // Trim to lookback window
    if (this.priceHistory.length > config.lookbackPeriod) {
      this.priceHistory = this.priceHistory.slice(-config.lookbackPeriod);
    }

    const oldest = this.priceHistory[0]!;
    const momentum = currentPrice.minus(oldest).div(oldest);

    let decision: Decision | null = null;

    if (momentum.gt(config.threshold)) {
      // Upward momentum → go long
      decision = {
        id: this.idGen() as DecisionId,
        tradingInstanceId: '' as TradingInstanceId, // caller sets this
        instrumentId: config.instrumentId as InstrumentId,
        intent: 'go_long',
        targetSize: quantity(config.positionSize),
        timestamp: snapshot.timestamp,
        metadata: { momentum: momentum.toString(), signal: 'long' },
      };
    } else if (momentum.lt(-config.threshold)) {
      // Downward momentum → go short
      decision = {
        id: this.idGen() as DecisionId,
        tradingInstanceId: '' as TradingInstanceId,
        instrumentId: config.instrumentId as InstrumentId,
        intent: 'go_short',
        targetSize: quantity(config.positionSize),
        timestamp: snapshot.timestamp,
        metadata: { momentum: momentum.toString(), signal: 'short' },
      };
    }
    // Within threshold → hold (return null)

    return ok(decision);
  }

  /** Reset internal state (useful for testing or instance restart) */
  reset(): void {
    this.priceHistory = [];
  }
}

function parseConfig(raw: Record<string, unknown>): MomentumConfig {
  return {
    lookbackPeriod: typeof raw['lookbackPeriod'] === 'number' ? raw['lookbackPeriod'] : DEFAULT_CONFIG.lookbackPeriod,
    threshold: typeof raw['threshold'] === 'number' ? raw['threshold'] : DEFAULT_CONFIG.threshold,
    positionSize: typeof raw['positionSize'] === 'string' ? raw['positionSize'] : DEFAULT_CONFIG.positionSize,
    instrumentId: typeof raw['instrumentId'] === 'string' ? raw['instrumentId'] : DEFAULT_CONFIG.instrumentId,
  };
}
