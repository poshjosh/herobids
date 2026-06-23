import type { Decision, DecisionId, InstrumentId, VenueAccountId, RiskConfig, TechnicalConfig } from '@herobids/domain';
import { quantity } from '@herobids/domain';
import type { PositionState } from '@herobids/engine';
import type { PriceCandle, RegimeParams, RegimeResult } from '@herobids/market-data';
import { scanCandidates, scoreCandidate } from '@herobids/strategy';
import type { CandidateContext, ScanConfig, ScoredSignal } from '@herobids/strategy';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DiscoveredInstrument {
  symbol: string;
  instrumentId: string;
  volume24hUsd?: number;
  liquidityUsd?: number;
  priceChange24hPct?: number;
}

export type FilterConfig = TechnicalConfig['filters'];

export interface PositionIndicatorUpdate {
  symbol: string;
  side: 'long' | 'flat';
  /** Venue-specific instrument identifier for this position. Falls back to symbol when unavailable. */
  instrumentId?: string;
  entryPrice?: number;
  currentPrice?: number;
  unrealizedPnlPct?: number;
  rsi?: number;
  signalNote?: string;
  /** Set to true when the scanner found this position should exit but advisory mode held back the direct submission. */
  exitAdvisory?: boolean;
}

export interface TechnicalPhaseDeps {
  config: TechnicalConfig;
  riskConfig: RiskConfig & { maxOpenPositions: number };
  agentId: string;
  venueAccountId: string;
  /** When true, the scanner only generates signals — it does NOT submit decisions directly.
   *  Entries are always held back in advisory mode. Exits are held back unless autonomousExit is true. */
  advisoryMode?: boolean;
  discoverCandidates: (filters: FilterConfig) => Promise<DiscoveredInstrument[]>;
  fetchCandles: (symbol: string, interval: string, limit: number) => Promise<PriceCandle[]>;
  evaluateRegime: (params: RegimeParams) => Promise<RegimeResult>;
  submitDecision: (decision: Decision) => Promise<void>;
  getOpenPositions: () => PositionState[];
  generateDecisionId: () => string;
  logger: {
    info: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    error: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

export interface TechnicalPhaseResult {
  candidatesDiscovered: number;
  candidatesScored: number;
  signalsGenerated: number;
  entriesSubmitted: number;
  exitsSubmitted: number;
  regimeBlocked: boolean;
  errors: string[];
  signals: ScoredSignal[];
  regimeResult: RegimeResult | null;
  positionIndicators: PositionIndicatorUpdate[];
  summary: { scanned: number; rejected: number; passed: number };
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function runTechnicalPhase(deps: TechnicalPhaseDeps): Promise<TechnicalPhaseResult> {
  const { config, riskConfig, agentId, venueAccountId, logger } = deps;
  const result: TechnicalPhaseResult = {
    candidatesDiscovered: 0,
    candidatesScored: 0,
    signalsGenerated: 0,
    entriesSubmitted: 0,
    exitsSubmitted: 0,
    regimeBlocked: false,
    errors: [],
    signals: [],
    regimeResult: null,
    positionIndicators: [],
    summary: { scanned: 0, rejected: 0, passed: 0 },
  };

  // 1. Discover candidates
  let candidates: DiscoveredInstrument[];
  try {
    candidates = await deps.discoverCandidates(config.filters);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`discovery_failed: ${msg}`);
    logger.error({ err }, 'Technical phase: candidate discovery failed');
    return result;
  }
  result.candidatesDiscovered = candidates.length;

  // 2. Regime gate
  if (config.regime) {
    try {
      const regimeResult = await deps.evaluateRegime(config.regime);
      result.regimeResult = regimeResult;
      if (!regimeResult.pass) {
        result.regimeBlocked = true;
        logger.info({ reasons: regimeResult.reasons }, 'Technical phase: regime blocked — skipping new entries');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`regime_eval_failed: ${msg}`);
      logger.warn({ err }, 'Technical phase: regime evaluation failed — proceeding without gate');
    }
  }

  // 3. Get open positions
  const openPositions = deps.getOpenPositions().filter((p) => p.side !== 'flat');
  const openInstrumentIds = new Set(openPositions.map((p) => p.symbol));

  // 4. Collect all symbols to fetch (candidates + open positions for exit eval)
  const openSymbols = [...openInstrumentIds].filter(
    (sym) => !candidates.some((c) => c.symbol === sym),
  );
  const allSymbols = [
    ...candidates.map((c) => c.symbol),
    ...openSymbols,
  ];

  // 5. Fetch candles in batches
  const candlesBySymbol = new Map<string, PriceCandle[]>();
  for (let i = 0; i < allSymbols.length; i += config.scanBatchSize) {
    const batch = allSymbols.slice(i, i + config.scanBatchSize);
    await Promise.all(
      batch.map(async (symbol) => {
        try {
          const candles = await deps.fetchCandles(symbol, config.candles.interval, config.candles.limit);
          candlesBySymbol.set(symbol, candles);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`candle_fetch_failed(${symbol}): ${msg}`);
          logger.warn({ err, symbol }, 'Technical phase: candle fetch failed — skipping symbol');
        }
      }),
    );
  }

  // 6. Build CandidateContext[] for successfully-fetched candidates
  const candidateContexts: CandidateContext[] = [];
  for (const candidate of candidates) {
    const candles = candlesBySymbol.get(candidate.symbol);
    if (!candles) continue;
    candidateContexts.push({
      symbol: candidate.symbol,
      instrumentId: candidate.instrumentId,
      candles,
      meta: {
        volume24hUsd: candidate.volume24hUsd,
        liquidityUsd: candidate.liquidityUsd,
        priceChange24hPct: candidate.priceChange24hPct,
      },
    });
  }

  // 7. Score candidates via scan engine
  const scanConfig: ScanConfig = {
    indicators: config.indicators,
    signalBias: config.signalBias,
  };
  const signals = scanCandidates(candidateContexts, scanConfig);
  result.candidatesScored = candidateContexts.length;
  result.signalsGenerated = signals.length;
  result.signals = signals;
  result.summary = {
    scanned: result.candidatesDiscovered,
    passed: signals.length,
    rejected: result.candidatesDiscovered - signals.length,
  };

  // 8. New entries: filter out already-open, respect maxPositions budget
  const maxPositions = riskConfig.maxOpenPositions;
  const entryBudget = Math.max(0, maxPositions - openPositions.length);
  const entrySignals = signals.filter((s) => !openInstrumentIds.has(s.instrumentId));
  const topEntries = entrySignals.slice(0, entryBudget);

  // 9. Submit entry decisions (if regime permits and not in advisory mode)
  if (!result.regimeBlocked) {
    if (deps.advisoryMode) {
      // Advisory mode: signals are stored in result.signals for the LLM to ratify.
      // Do NOT submit entry decisions directly.
      logger.info({ signalCount: topEntries.length }, 'Technical phase: advisory mode — skipping entry submissions');
    } else {
      for (const signal of topEntries) {
      const targetSize = riskConfig.maxPositionSize
        ? quantity(riskConfig.maxPositionSize)
        : quantity('1');

      const decision: Decision = {
        id: deps.generateDecisionId() as DecisionId,
        venueAccountId: venueAccountId as VenueAccountId,
        instrumentId: signal.instrumentId as InstrumentId,
        intent: 'go_long',
        targetSize,
        timestamp: new Date().toISOString(),
        actorType: 'agent',
        actorId: agentId,
        metadata: {
          trigger: 'technical_scan',
          confidence: signal.confidence,
          reasons: signal.reasons,
        },
      };

      try {
        await deps.submitDecision(decision);
        result.entriesSubmitted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`entry_submit_failed(${signal.instrumentId}): ${msg}`);
        logger.error({ err, instrumentId: signal.instrumentId }, 'Technical phase: entry submission failed');
      }
    }
    }
  }

  // 10. Exit evaluation for open positions
  for (const openPos of openPositions) {
    const candles = candlesBySymbol.get(openPos.symbol);
    if (!candles) {
      // Cannot evaluate exit without candles — skip
      continue;
    }

    const candidateCtx: CandidateContext = {
      symbol: openPos.symbol,
      instrumentId: openPos.symbol,
      candles,
    };

    const scored = scoreCandidate(candidateCtx, scanConfig);
    const minConfidence = config.indicators.confidence?.minConfidence ?? 0.45;
    const shouldExit = scored === null || scored.confidence < minConfidence;

    // Build position indicator for context enrichment
    const entryPriceNum = parseFloat(openPos.entryPrice.toString());
    const rsiVal = scored?.indicators?.rsi;
    let signalNote: string | undefined;
    if (rsiVal !== undefined) {
      const overbought = config.indicators.rsi?.overbought ?? 80;
      const healthyMax = config.indicators.rsi?.healthyMax ?? 70;
      if (rsiVal >= overbought) {
        signalNote = 'Overbought';
      } else if (rsiVal >= healthyMax) {
        signalNote = 'Weakening (approaching overbought)';
      } else if (rsiVal < (config.indicators.rsi?.weakBelow ?? 30)) {
        signalNote = 'Oversold';
      }
    }
    const posIndicator: PositionIndicatorUpdate = {
      symbol: openPos.symbol,
      side: openPos.side as 'long' | 'flat',
      instrumentId: openPos.symbol,
      entryPrice: Number.isFinite(entryPriceNum) ? entryPriceNum : undefined,
      rsi: rsiVal,
      signalNote,
    };

    if (shouldExit) {
      if (deps.advisoryMode && !config.autonomousExit) {
        // Advisory mode with autonomousExit disabled:
        // flag this position for LLM exit review, do NOT submit directly.
        posIndicator.exitAdvisory = true;
        result.positionIndicators.push(posIndicator);
        logger.info({ symbol: openPos.symbol, reason: scored === null ? 'hard_reject' : 'confidence_below_threshold' },
          'Technical phase: advisory mode — skipping exit submission for LLM review');
        continue;
      }

      const exitDecision: Decision = {
        id: deps.generateDecisionId() as DecisionId,
        venueAccountId: venueAccountId as VenueAccountId,
        instrumentId: openPos.symbol as InstrumentId,
        intent: 'go_flat',
        targetSize: quantity('0'),
        timestamp: new Date().toISOString(),
        actorType: 'agent',
        actorId: agentId,
        metadata: {
          trigger: 'technical_exit',
          reason: scored === null ? 'hard_reject' : 'confidence_below_threshold',
          confidence: scored?.confidence,
        },
      };

      try {
        await deps.submitDecision(exitDecision);
        result.exitsSubmitted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`exit_submit_failed(${openPos.symbol}): ${msg}`);
        logger.error({ err, symbol: openPos.symbol }, 'Technical phase: exit submission failed');
      }
    }
    result.positionIndicators.push(posIndicator);
  }

  logger.info({
    candidatesDiscovered: result.candidatesDiscovered,
    candidatesScored: result.candidatesScored,
    signalsGenerated: result.signalsGenerated,
    entriesSubmitted: result.entriesSubmitted,
    exitsSubmitted: result.exitsSubmitted,
    regimeBlocked: result.regimeBlocked,
    errorCount: result.errors.length,
  }, 'Technical phase complete');

  return result;
}
