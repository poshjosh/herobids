/**
 * Validated and extracted momentum-style params.
 * Used internally by translateMomentumToMechanicalParams.
 */
interface MomentumInput {
  lookbackPeriod?: number;
  threshold?: number;
  positionSize?: string;
  candleInterval?: string;
}

const VALID_CANDLE_INTERVALS = new Set(['5m', '15m', '1H', '4H', '1D']);

/**
 * Safely extracts known momentum-style fields from a raw config object,
 * discarding invalid or unexpected values.
 */
function extractMomentumInput(rawConfig: Record<string, unknown>): MomentumInput {
  const result: MomentumInput = {};

  if (
    typeof rawConfig.lookbackPeriod === 'number' &&
    Number.isInteger(rawConfig.lookbackPeriod) &&
    rawConfig.lookbackPeriod >= 2
  ) {
    result.lookbackPeriod = rawConfig.lookbackPeriod;
  }

  if (
    typeof rawConfig.threshold === 'number' &&
    rawConfig.threshold >= 0
  ) {
    result.threshold = rawConfig.threshold;
  }

  if (typeof rawConfig.positionSize === 'string' && rawConfig.positionSize.length > 0) {
    result.positionSize = rawConfig.positionSize;
  }

  if (
    typeof rawConfig.candleInterval === 'string' &&
    VALID_CANDLE_INTERVALS.has(rawConfig.candleInterval)
  ) {
    result.candleInterval = rawConfig.candleInterval;
  }

  return result;
}

/**
 * Translates old momentum-style strategy params to mechanical-style params.
 *
 * Momentum bots carried `lookbackPeriod`, `threshold`, `positionSize` in config.
 * MechanicalStrategy expects `candleInterval`, `candleLimit`, `signalBias`,
 * `positionSize`, `positionSizeMode`, plus the nested indicator config.
 *
 * The `threshold` field (old momentum signal sensitivity, default 0.02) is
 * mapped to `indicators.confidence.minConfidence` using a 5× multiplier to
 * bridge the scoring-scale gap between the two engines (new default is 0.10).
 *
 * @param rawConfig - The raw config object from the bot's strategy.params
 * @returns Mechanical-style params compatible with MechanicalParamsSchema
 */
export function translateMomentumToMechanicalParams(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  const p = extractMomentumInput(rawConfig);

  // threshold (old default 0.02) -> minConfidence (new default 0.10).
  // 5× multiplier keeps proportional behavior for users who tuned threshold.
  const minConfidence =
    p.threshold != null
      ? Math.max(0.01, Math.min(1, p.threshold * 5))
      : undefined;

  // NOTE: lookbackPeriod was the old momentum RSI period (a small number like
  // 5-14). candleLimit is the total number of candles to fetch for all
  // indicators (RSI, MACD, S/R, volume avg). A direct 1:1 mapping would
  // produce a candleLimit too small for multi-indicator computation and
  // would fail MechanicalParamsSchema validation (min=20). We take the max
  // with 20 (the schema floor) so user-configured values ≥ 20 pass through
  // while small values are raised to the minimum viable count.
  const translated: Record<string, unknown> = {
    candleInterval: p.candleInterval ?? '15m',
    candleLimit: Math.max(20, p.lookbackPeriod ?? 100),
    signalBias: 'trend-following',
    positionSize: p.positionSize ?? '1',
    positionSizeMode: 'fixed',
  };

  // Only inject indicators block if threshold was explicitly provided, to let
  // MechanicalParamsSchema apply its full indicator defaults otherwise.
  if (minConfidence != null) {
    translated.indicators = { confidence: { minConfidence } };
  }

  return translated;
}
