import type { Decision, DecisionId, HybridPricingIdentity, InstrumentId, VenueAccountId, RiskConfig, TechnicalConfig } from '@herobids/domain';
import { quantity, scannerTargetKey } from '@herobids/domain';
import type { SwapExecutionIdentity, ScannerCandleTarget } from '@herobids/domain';
import type { PositionState } from '@herobids/engine';
import type { PriceCandle, RegimeParams, RegimeResult } from '@herobids/market-data';
import { scanCandidates, scoreCandidate } from '@herobids/strategy';
import type { CandidateContext, ScanConfig, ScoredSignal } from '@herobids/strategy';
import type { RetryOptions } from './candle-fetch-retry.js';
import { retryWithBackoff } from './candle-fetch-retry.js';
import type { CandleFetchBreaker } from './candle-fetch-breaker.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DiscoveredInstrument {
  symbol: string;
  instrumentId: string;
  venue: string;
  venueType: 'orderbook' | 'swap';
  candleTarget: ScannerCandleTarget;
  pricingIdentity: HybridPricingIdentity;
  swapExecutionIdentity?: SwapExecutionIdentity;
  volume24hUsd?: number;
  liquidityUsd?: number;
  priceChange24hPct?: number;
}

export type FilterConfig = TechnicalConfig['filters'];

/** Classification of a single candle-fetch attempt in the technical scan. */
export type CandleFetchStatus = 'eligible_fetched' | 'eligible_empty' | 'unsupported' | 'transient_failure' | 'skipped_breaker_open';

export interface SymbolFetchOutcome {
  symbol: string;
  /** Exact instrument ID this outcome corresponds to. */
  instrumentId: string;
  /** For orderbook targets, the provider symbol used for candle fetching. Undefined for swap targets. */
  resolvedProviderSymbol?: string;
  status: CandleFetchStatus;
  candleCount?: number;
  errorDetail?: string;
}

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
  fetchCandles: (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>;
  evaluateRegime: (params: RegimeParams) => Promise<RegimeResult>;
  submitDecision: (decision: Decision) => Promise<void>;
  getOpenPositions: () => PositionState[];
  generateDecisionId: () => string;
  logger: {
    info: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    error: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
  /** Optional in-cycle retry config for transient candle fetch failures. Fail-open when absent. */
  candleFetchRetry?: RetryOptions;
  /** Optional cross-scan circuit breaker for symbols that fail every retry. Fail-open when absent. */
  candleFetchBreaker?: CandleFetchBreaker;
  /** Monotonically increasing scan identifier used by the breaker to express skip durations in scan cycles. */
  currentScanEpoch?: number;
}

export interface TechnicalPhaseResult {
  candidatesDiscovered: number;
  /** Count of symbols selected for candle fetch. Includes both entry candidates AND
   *  open-position symbols (for exit evaluation). Not limited to new-entry candidates. */
  symbolsSelected: number;
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
  /** Per-symbol fetch outcomes for scanner health observability. */
  symbolOutcomes: SymbolFetchOutcome[];
  /** Count of symbols classified as unsupported by the provider. */
  unsupportedCount: number;
  /** Count of symbols that encountered transient fetch failures. */
  fetchFailures: number;
  /** Count of symbols skipped because the circuit breaker is open. */
  breakerSkips: number;
  /** Count of symbols that returned eligible data (eligible_fetched + eligible_empty). */
  eligibleCount: number;
  /** Count of symbols that returned non-empty candles (eligible_fetched only). */
  fetchedCount: number;
  /** Whether this scan was skipped due to an overlapping scan in progress. */
  overlapSkipped?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Classify a candle-fetch error into one of four outcome statuses.
 * Uses error message patterns since HttpError (from @herobids/market-data/http)
 * is not re-exported through the market-data barrel.
 *
 * Orderbook errors (Binance) and swap errors (GeckoTerminal) follow the same
 * classification logic: HTTP 400 = unsupported, HTTP 429/5xx/timeout = transient.
 * No Binance-specific HTTP assumptions are applied to GeckoTerminal errors.
 */
export function classifyCandleError(err: unknown): { status: CandleFetchStatus; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);

  // HTTP 400 → unsupported instrument (pool not found, invalid symbol, etc.)
  if (msg.includes('HTTP error: 400') || msg.includes('Invalid symbol')) {
    return { status: 'unsupported', detail: msg };
  }

  // HTTP 404 → pool not found (GeckoTerminal-specific)
  if (msg.includes('HTTP error: 404')) {
    return { status: 'unsupported', detail: msg };
  }

  // Rate-limit exhaustion (local TokenBucketRateLimiter or coordinated limiter)
  if (msg.includes('Rate limit exceeded')) {
    return { status: 'transient_failure', detail: msg };
  }

  // HTTP 429 → upstream rate limit
  if (msg.includes('HTTP error: 429')) {
    return { status: 'transient_failure', detail: msg };
  }

  // HTTP 5xx → transient server error (Binance, GeckoTerminal, etc.)
  if (msg.includes('HTTP error: 5')) {
    return { status: 'transient_failure', detail: msg };
  }

  // Timeout / abort
  if (
    msg.includes('abort') ||
    msg.includes('timeout') ||
    msg.includes('Timeout') ||
    msg.includes('AbortError')
  ) {
    return { status: 'transient_failure', detail: msg };
  }

  // Unknown error — treat as transient to avoid permanent blacklisting
  return { status: 'transient_failure', detail: msg };
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function runTechnicalPhase(deps: TechnicalPhaseDeps): Promise<TechnicalPhaseResult> {
  const { config, riskConfig, agentId, venueAccountId, logger } = deps;
  const result: TechnicalPhaseResult = {
    candidatesDiscovered: 0,
    symbolsSelected: 0,
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
    symbolOutcomes: [],
    unsupportedCount: 0,
    fetchFailures: 0,
    breakerSkips: 0,
    eligibleCount: 0,
    fetchedCount: 0,
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

  // 3. Get open positions — apply position-identity migration guard:
  //    - orderbook positions may use instrumentId ?? symbol as their scan key.
  //    - swap positions with null/non-exact instrumentId are skipped for exit scanning
  //      and emit scanner.swap_exit_unresolved.
  const SWAP_VENUES = new Set(['jupiter', '1inch']);
  const allOpenPositions = deps.getOpenPositions().filter((p) => p.side !== 'flat');
  const openPositions: PositionState[] = [];
  for (const pos of allOpenPositions) {
    if (SWAP_VENUES.has(pos.venue)) {
      // Intentionally simple check for Phase 0 — Phase 2 replaces this with parseSwapInstrumentId().
      if (!pos.instrumentId || !pos.instrumentId.includes(':')) {
        logger.warn(
          {
            venue: pos.venue,
            symbol: pos.symbol,
            instrumentId: pos.instrumentId ?? null,
            event: 'scanner.swap_exit_unresolved',
            reason: 'non_exact_instrument_id',
          },
          'Swap position has no exact instrumentId — skipped for exit scanning',
        );
        continue;
      }
    }
    openPositions.push(pos);
  }

  // Use exact instrumentId as scan key; orderbook positions fall back to symbol.
  const openInstrumentIds = new Set(
    openPositions.map((p) => p.instrumentId ?? p.symbol),
  );

  // 4. Collect all instrument IDs to fetch (candidates + open positions for exit eval)
  const candidateIds = candidates.map((c) => c.instrumentId);
  const openIds = [...openInstrumentIds].filter(
    (id) => !candidates.some((c) => c.instrumentId === id),
  );
  const allIds = [...candidateIds, ...openIds];
  result.symbolsSelected = allIds.length; // includes both entry candidates + open-position symbols

  // Build instrumentId → ScannerCandleTarget map so fetchCandles receives venue-aware targets.
  // Candidates carry explicit candle targets; open positions fall back to the symbol itself
  // as an orderbook target.
  const candleTargetByInstrumentId = new Map<string, ScannerCandleTarget>();
  for (const candidate of candidates) {
    candleTargetByInstrumentId.set(candidate.instrumentId, candidate.candleTarget);
  }
  // ── Phase 3 swap exit block ─────────────────────────────────────────────
  // NOTE: This block is infrastructure pre-built for Phase 4. Swap exit
  // positions always reach the `missing_pool_address` skip below because pool
  // addresses are not yet persisted with positions. When Phase 4 lands, pool
  // addresses will be stored on position open and this path will resolve.
  //
  // Construct swap candle targets from position identity.
  // For swap positions with a valid exact instrumentId, derive the network from
  // the venue (jupiter → solana, 1inch → base). The pool address is not
  // available from position data alone — swap exit positions that cannot
  // resolve a pool address are skipped with scanner.swap_exit_unresolved.
  //
  // NETWORK_BY_SWAP_VENUE intentionally duplicates resolveSwapNetwork's
  // venue → network mapping. resolveSwapNetwork is not available in the
  // exit evaluation context (it requires a binding, not a position).
  const NETWORK_BY_SWAP_VENUE: Record<string, string> = {
    jupiter: 'solana',
    '1inch': 'base',
  };
  for (const pos of openPositions) {
    const id = pos.instrumentId ?? pos.symbol;
    if (SWAP_VENUES.has(pos.venue)) {
      // Attempt to resolve a candle target from swap position identity.
      const network = NETWORK_BY_SWAP_VENUE[pos.venue];
      if (!network) {
        logger.warn(
          {
            venue: pos.venue,
            symbol: pos.symbol,
            instrumentId: id,
            event: 'scanner.swap_exit_unresolved',
            reason: 'unknown_network',
          },
          'Swap position exit skipped — cannot resolve network from venue',
        );
        continue;
      }
      // Parse instrumentId to extract base/quote addresses.
      // Format: BASE:ADDR/QUOTE:ADDR (exact) or BASE/QUOTE (legacy).
      const colonIdx = id.indexOf(':');
      const slashIdx = id.indexOf('/');
      if (colonIdx === -1 || slashIdx === -1 || colonIdx >= slashIdx) {
        logger.warn(
          {
            venue: pos.venue,
            symbol: pos.symbol,
            instrumentId: id,
            event: 'scanner.swap_exit_unresolved',
            reason: 'unparseable_instrument_id',
          },
          'Swap position exit skipped — instrumentId is not an exact address-qualified pair',
        );
        continue;
      }
      // Pool address is not available from position identity alone.
      // The position was opened from a discovered pool, but the poolAddress
      // is not persisted with the position. Emit unresolved and skip.
      logger.warn(
        {
          venue: pos.venue,
          symbol: pos.symbol,
          instrumentId: id,
          network,
          event: 'scanner.swap_exit_unresolved',
          reason: 'missing_pool_address',
        },
        'Swap position exit skipped — pool address not available from position identity',
      );
      continue;
    }
    if (!candleTargetByInstrumentId.has(id)) {
      candleTargetByInstrumentId.set(id, { venueType: 'orderbook', providerSymbol: pos.symbol });
    }
  }

  // Build an instrumentId → display symbol reverse map for symbolOutcomes.
  const displaySymbolById = new Map<string, string>();
  for (const candidate of candidates) {
    displaySymbolById.set(candidate.instrumentId, candidate.symbol);
  }
  for (const pos of openPositions) {
    const id = pos.instrumentId ?? pos.symbol;
    if (!displaySymbolById.has(id)) {
      displaySymbolById.set(id, pos.symbol);
    }
  }

  // 5. Fetch candles in batches — classify per-instrument outcomes for health matrix.
  //    Transient failures are retried in-cycle with jittered backoff; instruments that
  //    fail every retry across consecutive scans are skipped by the circuit breaker.
  //    Keyed by exact instrumentId to avoid same-ticker collisions.
  const candlesByInstrumentId = new Map<string, PriceCandle[]>();
  const unsupportedIds = new Set<string>(); // per-scan cache: skip unsupported in subsequent batches
  const { candleFetchRetry, candleFetchBreaker } = deps;
  const scanEpoch = deps.currentScanEpoch;

  for (let i = 0; i < allIds.length; i += config.scanBatchSize) {
    const batch = allIds.slice(i, i + config.scanBatchSize)
      .filter((id) => !unsupportedIds.has(id)); // skip already-classified-unsupported
    if (batch.length === 0) continue;

    await Promise.all(
      batch.map(async (id) => {
        const target = candleTargetByInstrumentId.get(id);
        const displaySymbol = displaySymbolById.get(id) ?? id;
        if (!target) {
          // Should never happen with the map construction above, but defensive.
          result.symbolOutcomes.push({ symbol: displaySymbol, instrumentId: id, status: 'unsupported', errorDetail: 'No candle target mapped' });
          result.unsupportedCount++;
          return;
        }

        // Circuit breaker: skip instruments that have failed every retry across consecutive scans.
        // Key is derived from the full ScannerCandleTarget, not just providerSymbol.
        if (candleFetchBreaker && scanEpoch != null) {
          const breakerKey = scannerTargetKey(target);
          const skip = await candleFetchBreaker.shouldSkip(agentId, breakerKey, scanEpoch);
          if (skip) {
            result.symbolOutcomes.push({
              symbol: displaySymbol,
              instrumentId: id,
              status: 'skipped_breaker_open',
              resolvedProviderSymbol: target.venueType === 'orderbook' ? target.providerSymbol : undefined,
            });
            result.breakerSkips++;
            return;
          }
        }

        const fetchAttempt = async () => deps.fetchCandles(target, config.candles.interval, config.candles.limit);

        try {
          let candles: PriceCandle[];

          if (candleFetchRetry) {
            const retryResult = await retryWithBackoff(fetchAttempt, {
              ...candleFetchRetry,
              shouldRetry: (err) => classifyCandleError(err).status !== 'unsupported',
            });
            if (!retryResult.ok) {
              throw retryResult.error;
            }
            candles = retryResult.value;
          } else {
            candles = await fetchAttempt();
          }

          candlesByInstrumentId.set(id, candles);
          const candleCount = candles.length;
          const status: CandleFetchStatus = candleCount > 0 ? 'eligible_fetched' : 'eligible_empty';
          result.symbolOutcomes.push({ symbol: displaySymbol, instrumentId: id, status, candleCount });

          // Successful fetch (after any retries) — close the breaker for this target.
          if (candleFetchBreaker) {
            const breakerKey = scannerTargetKey(target);
            await candleFetchBreaker.recordSuccess(agentId, breakerKey);
          }
        } catch (err) {
          const { status, detail } = classifyCandleError(err);
          result.symbolOutcomes.push({ symbol: displaySymbol, instrumentId: id, status, errorDetail: detail });
          if (status === 'unsupported') {
            unsupportedIds.add(id);
            result.unsupportedCount++;
            // Unsupported (HTTP 400) — never retry, never open breaker. Permanent skip.
          } else {
            result.fetchFailures++;
            // Transient failure after all retries exhausted — record for breaker.
            if (candleFetchBreaker && scanEpoch != null) {
              const breakerKey = scannerTargetKey(target);
              await candleFetchBreaker.recordFailure(agentId, breakerKey, scanEpoch);
            }
          }
          const outcomeMsg = `candle_fetch_${status}(${id}): ${detail}`;
          result.errors.push(outcomeMsg);
          logger.warn({ err, instrumentId: id, status }, `Technical phase: candle fetch ${status} — skipping instrument`);
        }
      }),
    );
  }

  // Compute eligible/fetched counts once to avoid re-filtering symbolOutcomes downstream.
  for (const outcome of result.symbolOutcomes) {
    if (outcome.status === 'eligible_fetched') {
      result.fetchedCount++;
      result.eligibleCount++;
    } else if (outcome.status === 'eligible_empty') {
      result.eligibleCount++;
    }
  }

  // 6. Build CandidateContext[] for successfully-fetched candidates (keyed by instrumentId)
  const candidateContexts: CandidateContext[] = [];
  for (const candidate of candidates) {
    const candles = candlesByInstrumentId.get(candidate.instrumentId);
    if (!candles) continue;
    candidateContexts.push({
      symbol: candidate.symbol,
      instrumentId: candidate.instrumentId,
      candles,
      venue: candidate.venue,
      venueType: candidate.venueType,
      candleTarget: candidate.candleTarget,
      pricingIdentity: candidate.pricingIdentity,
      swapExecutionIdentity: candidate.swapExecutionIdentity,
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

  // 10. Exit evaluation for open positions (swap-identity guard already applied above)
  for (const openPos of openPositions) {
    const posId = openPos.instrumentId ?? openPos.symbol;
    const candles = candlesByInstrumentId.get(posId);
    if (!candles) {
      // Cannot evaluate exit without candles — skip
      continue;
    }

    const candidateCtx: CandidateContext = {
      symbol: openPos.symbol,
      instrumentId: posId,
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
      instrumentId: posId,
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
        logger.info({ symbol: openPos.symbol, instrumentId: posId, reason: scored === null ? 'hard_reject' : 'confidence_below_threshold' },
          'Technical phase: advisory mode — skipping exit submission for LLM review');
        continue;
      }

      const exitDecision: Decision = {
        id: deps.generateDecisionId() as DecisionId,
        venueAccountId: venueAccountId as VenueAccountId,
        instrumentId: posId as InstrumentId,
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
        result.errors.push(`exit_submit_failed(${posId}): ${msg}`);
        logger.error({ err, instrumentId: posId }, 'Technical phase: exit submission failed');
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
