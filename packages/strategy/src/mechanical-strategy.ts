import type {
  Strategy,
  MarketSnapshot,
  StrategyError,
  Decision,
  DecisionId,
  VenueAccountId,
  InstrumentId,
  CandleFetcher,
  SentimentProvider,
  MechanicalParams,
  Result,
} from '@herobids/domain';
import { ok, err, quantity, MechanicalParamsSchema } from '@herobids/domain';
import { scoreCandidate } from './scan-engine.js';
import type { ScanConfig, CandidateContext } from './scan-engine.js';

export class MechanicalStrategy implements Strategy {
  readonly id = 'mechanical-v1';
  readonly name = 'Mechanical Strategy';

  private _playbookWarned = false;

  constructor(
    private readonly candleFetcher: CandleFetcher,
    private readonly sentimentProvider: SentimentProvider | null,
    private readonly idGen: () => string,
    private readonly debug?: (msg: string, ctx?: Record<string, unknown>) => void,
  ) {}

  async evaluate(
    snapshot: MarketSnapshot,
    rawConfig: Record<string, unknown>,
  ): Promise<Result<Decision | null, StrategyError>> {
    // 1. Parse config
    const parseResult = MechanicalParamsSchema.safeParse(rawConfig);
    if (!parseResult.success) {
      return err({
        code: 'strategy.config_invalid',
        message: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const params: MechanicalParams = parseResult.data;

    // 2. Fetch candles
    let candles;
    try {
      candles = await this.candleFetcher.fetchCandles(
        snapshot.symbol,
        params.candleInterval,
        params.candleLimit,
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ code: 'strategy.candle_fetch_failed', message });
    }

    if (candles.length < params.minCandleCount) {
      return ok(null);
    }

    // 3. Build synthetic CandidateContext and score via shared indicator engine
    const context: CandidateContext = {
      symbol: snapshot.symbol,
      instrumentId: snapshot.symbol,
      candles,
      meta: {
        priceChange24hPct: typeof snapshot.data?.['priceChange24hPct'] === 'number'
          ? snapshot.data['priceChange24hPct'] as number
          : undefined,
      },
    };
    const scanConfig: ScanConfig = {
      indicators: params.indicators,
      signalBias: params.signalBias,
    };
    const signal = scoreCandidate(context, scanConfig);

    // Resolve open position state from snapshot.data (injected by the trading actor)
    const hasOpenPosition = resolveHasOpenPosition(snapshot);

    // Exit path: no signal + open position → go flat
    if (!signal && hasOpenPosition) {
      return ok(makeDecision(snapshot, 'go_flat', '0', this.idGen, { reason: 'signal_lost' }));
    }

    if (!signal) {
      return ok(null);
    }

    // Playbook: avoidParabolicMovePct — skip entry if last candle's move is too large
    const avoidParabolicMovePct = snapshot.playbook?.avoidParabolicMovePct;

    // Diagnostic: if playbook is entirely absent but this is a live path (data has position state),
    // the TradingActor may have forgotten to populate it. Log once per strategy lifetime.
    if (!this._playbookWarned && snapshot.playbook === undefined && snapshot.data?.['hasOpenPosition'] !== undefined) {
      this._playbookWarned = true;
      this.debug?.('snapshot.playbook absent — playbook guards skipped (TradingActor may need updating)', {
        symbol: snapshot.symbol,
      });
    }

    if (avoidParabolicMovePct != null) {
      const lastCandle = candles[candles.length - 1]!;
      const movePct = Math.abs((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;
      if (movePct >= avoidParabolicMovePct) {
        if (hasOpenPosition) {
          return ok(makeDecision(snapshot, 'go_flat', '0', this.idGen, { reason: 'parabolic_move' }));
        }
        return ok(null);
      }
    }

    // Playbook: maxNewPositionsPerDay — skip if daily new-position limit reached
    // newPositionsToday is runtime position state (counter), not a playbook guard,
    // so it lives in snapshot.data alongside openPositionSize / hasOpenPosition.
    const newPositionsToday = typeof snapshot.data?.['newPositionsToday'] === 'number'
      ? (snapshot.data['newPositionsToday'] as number)
      : undefined;
    const maxNewPositionsPerDay = snapshot.playbook?.maxNewPositionsPerDay;
    if (newPositionsToday != null && maxNewPositionsPerDay != null && newPositionsToday >= maxNewPositionsPerDay) {
      if (hasOpenPosition) {
        return ok(makeDecision(snapshot, 'go_flat', '0', this.idGen, { reason: 'daily_limit_reached' }));
      }
      return ok(null);
    }

    // 4. Sentiment adjustment (optional)
    let adjustedConfidence = signal.confidence;
    if (params.sentiment.enabled && this.sentimentProvider != null) {
      const sentResult = await this.sentimentProvider.getScore(snapshot.symbol);
      if (sentResult.ok && sentResult.data != null) {
        // Hard veto: strongly negative sentiment with high confidence
        if (
          sentResult.data.score < params.sentiment.negativeThreshold &&
          sentResult.data.confidence > 0.5
        ) {
          return ok(null); // sentiment veto
        }
        // Boost: positive sentiment above threshold
        if (sentResult.data.score > params.sentiment.positiveThreshold) {
          const boost = sentResult.data.score * sentResult.data.confidence * params.sentiment.maxBoost;
          adjustedConfidence = Math.min(1, Math.max(0, signal.confidence + boost));
        }
      }
    }

    // 5. Final confidence gate (post-sentiment re-check)
    const minConf = params.indicators.confidence.minConfidence;
    const minReasons = params.indicators.confidence.minReasons;
    if (adjustedConfidence < minConf || signal.reasons.length < minReasons) {
      if (hasOpenPosition) {
        return ok(makeDecision(snapshot, 'go_flat', '0', this.idGen, { reason: 'sentiment_suppressed' }));
      }
      return ok(null);
    }

    // 6. Entry confirmed → pass signal intent through (go_long or go_short)
    return ok(
      makeDecision(snapshot, signal.intent, resolvePositionSize(params, snapshot, this.debug), this.idGen, {
        confidence: adjustedConfidence,
        reasons: signal.reasons,
        indicators: signal.indicators,
      }),
    );
  }
}

/**
 * Resolve the dollar-denominated position size from the strategy params.
 *
 * When positionSizeMode is 'percent_equity', the positionSize string is
 * interpreted as a percentage of account equity (e.g. "5" = 5% of equity).
 * The equity value must be injected into snapshot.data.accountEquity by the
 * trading actor before calling strategy.evaluate().
 *
 * Returns the dollar amount as a fixed-precision string, or '0' to signal
 * that a trade should be skipped (insufficient or missing equity data).
 */
function resolvePositionSize(
  params: MechanicalParams,
  snapshot: MarketSnapshot,
  debug?: (msg: string, ctx?: Record<string, unknown>) => void,
): string {
  if (params.positionSizeMode === 'percent_equity') {
    const equity = snapshot.data?.['accountEquity'];
    if (typeof equity !== 'number' || equity <= 0) {
      debug?.('percent_equity: skipping trade — accountEquity missing, zero, or negative', {
        equityType: typeof equity,
        equityValue: equity,
        symbol: snapshot.symbol,
      });
      return '0';
    }
    const pct = parseFloat(params.positionSize);
    if (isNaN(pct) || pct <= 0) {
      debug?.('percent_equity: skipping trade — positionSize is not a valid positive number', {
        positionSize: params.positionSize,
        symbol: snapshot.symbol,
      });
      return '0';
    }
    const amount = (equity * pct) / 100;
    // Guard against computed amounts that round to zero at 6 decimal places.
    // $0.01 is a reasonable minimum notional for any venue-supported trade.
    if (amount < 0.01) {
      debug?.('percent_equity: skipping trade — computed amount too small', {
        amount,
        equity,
        pct,
        symbol: snapshot.symbol,
      });
      return '0';
    }
    // 6 decimal places preserves sub-cent precision for small accounts
    // while being precise enough for crypto token quantities.
    return amount.toFixed(6);
  }
  return params.positionSize;
}

function resolveHasOpenPosition(snapshot: MarketSnapshot): boolean {
  if (!snapshot.data) return false;
  const size = snapshot.data['openPositionSize'];
  if (typeof size === 'number') return size !== 0;
  if (typeof size === 'string') return size !== '0' && size !== '';
  return snapshot.data['hasOpenPosition'] === true;
}

function makeDecision(
  snapshot: MarketSnapshot,
  intent: 'go_long' | 'go_short' | 'go_flat',
  size: string,
  idGen: () => string,
  metadata?: Record<string, unknown>,
): Decision {
  return {
    id: idGen() as DecisionId,
    venueAccountId: '' as VenueAccountId, // stamped by TradingActor before intake
    actorType: 'system',
    actorId: 'mechanical-v1',
    instrumentId: snapshot.symbol as InstrumentId,
    intent,
    targetSize: quantity(size),
    timestamp: snapshot.timestamp,
    metadata,
  };
}
