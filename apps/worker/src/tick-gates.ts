import crypto from 'node:crypto';
import type { PriceCandle, RegimeResult, TradingSessionName } from '@herobids/domain';
import type { RuntimeActiveWatchSummary } from './runtime-composition.js';

/** Per-instrument summary used for stable context hashing across multi-instrument batches. */
export interface InstrumentHashEntry {
  symbol: string;
  priceBucket: string;
  pnlBucket: string;
  side: string;
}

export interface TickGateState {
  tickNumber: number;
  hasOpenPositions: boolean;
  /** When true, the current tick was triggered by a wake signal (e.g. reminder,
   * market event). The context_hash gate is bypassed so the LLM always runs to
   * handle the wake payload, even if trading context is unchanged. */
  hasWakeSignal?: boolean;
  tradingHours?: TradingHoursConfig;
  now?: Date;
  positionSide?: string | null;
  latestPrice?: number | null;
  portfolioPnlUsd?: number | null;
  /** Sorted per-instrument summaries for stable multi-instrument context hashing. */
  instrumentSnapshots?: InstrumentHashEntry[];
  /** Stable digest of the active watch summary. When "__unknown__", the watch
   * state could not be loaded and the gate should err on the side of running
   * the LLM. Undefined means watch state is not incorporated (backward compat). */
  watchSummaryDigest?: string;
  /** Stable digest of the pending wake signal buffer (source+reason pairs,
   * sorted by source, NO timestamps). When "__none__", the buffer was empty.
   * Undefined means wake signal state is not incorporated (backward compat). */
  wakeSignalDigest?: string;
  /** Stable digest of risk/playbook data that materially affects agent
   * actionability (drawdown bucket + open position count). When "__unknown__",
   * the data was unavailable and the gate will err on the side of running the
   * LLM. Undefined means risk state is not incorporated (backward compat). */
  riskPlaybookDigest?: string;
  /** Stable digest of pending market context-only events (no agent.wake).
   * When "__none__", the buffer was empty. Undefined means context events are
   * not incorporated (backward compat). */
  marketEventDigest?: string;
  previousContextHash?: string | null;
  baseTickIntervalMs?: number;
  currentTickIntervalMs?: number;
  enabledGates?: {
    session?: boolean;
    regime?: boolean;
    contextHash?: boolean;
    adaptiveInterval?: boolean;
  };
}

export interface TickGateDependencies {
  evaluateRegime?: () => Promise<RegimeResult>;
  /**
   * Returns the pre-computed volatility measure (ATR%) driving adaptive tick
   * cadence, or null when there is no usable reading (treated as "no
   * adjustment"). The ATR% is derived UPSTREAM of this callback — over the
   * Traderton `get_volatility` boundary when present, else in-process from
   * registry candles via {@link calculateAtrPercent}. Deriving it upstream keeps
   * raw candles out of the tick gate and off the boundary path (legal isolation).
   */
  fetchVolatilityPct?: () => Promise<number | null>;
}

export interface TradingHoursConfig {
  allowedHoursUtc?: number[];
  weekendPause?: boolean;
  tradingSessions?: TradingSessionName[];
}

export interface TickSkipDecision {
  skip: boolean;
  reason?: string;
  gate?: 'session' | 'regime' | 'context_hash';
  regime?: RegimeResult;
  contextHash?: string;
  nextTickIntervalMs: number;
  volatilityPct?: number;
  degraded?: boolean;
  degradationReason?: 'adaptive_interval_unavailable' | 'regime_unavailable';
}

const DEFAULT_BASE_INTERVAL_MS = 900_000;
const LOW_VOL_THRESHOLD_PCT = 0.3;
const FORCE_FULL_EVALUATION_EVERY_TICK = 10;

const nyHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
});

function getNyUtcOffsetHours(now: Date): number {
  const parts = nyHourFormatter.formatToParts(now);
  const hourPart = parts.find(p => p.type === 'hour');
  if (!hourPart) {
    throw new Error('Intl.DateTimeFormat did not return an hour part');
  }
  const nyHour = parseInt(hourPart.value, 10);
  const utcHour = now.getUTCHours();
  const diff = (utcHour - nyHour + 24) % 24;
  if (diff !== 4 && diff !== 5) {
    throw new Error(`Unexpected UTC offset for America/New_York: ${diff}`);
  }
  return diff;
}

const SESSION_LOCAL_HOURS: Record<TradingSessionName, number[]> = {
  'asia':         [20, 21, 22, 23],
  'london':       [1, 2, 3, 4],
  'ny-morning':   [7, 8, 9],
  'ny-mid':       [10, 11],
  'ny-afternoon': [12, 13, 14, 15],
};

function resolveTradingSessionHours(sessions: TradingSessionName[], now: Date): number[] {
  const offset = getNyUtcOffsetHours(now);
  const hours = new Set<number>();
  for (const session of sessions) {
    for (const localH of SESSION_LOCAL_HOURS[session]) {
      hours.add((localH + offset) % 24);
    }
  }
  return [...hours].sort((a, b) => a - b);
}

export function isWithinTradingHours(now: Date, tradingHours?: TradingHoursConfig): boolean {
  if (!tradingHours) {
    return true;
  }

  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const weekendPaused = Boolean(tradingHours.weekendPause)
    && (day === 6 || (day === 0 && hour < 12));

  if (weekendPaused) {
    return false;
  }

  const sessions = tradingHours.tradingSessions;
  if (sessions && sessions.length > 0) {
    return resolveTradingSessionHours(sessions, now).includes(hour);
  }

  const allowedHours = tradingHours.allowedHoursUtc ?? [];
  if (allowedHours.length === 0) {
    return true;
  }

  return allowedHours.includes(hour);
}

export function computePriceBucket(price?: number | null): string {
  if (!price || !Number.isFinite(price) || price <= 0) {
    return 'unknown';
  }
  return String(Math.round(Math.log(price) / Math.log(1.005)));
}

export function computePnlBucket(portfolioPnlUsd?: number | null): string {
  if (portfolioPnlUsd === null || portfolioPnlUsd === undefined || !Number.isFinite(portfolioPnlUsd)) {
    return 'unknown';
  }
  return String(Math.round(portfolioPnlUsd / 10) * 10);
}

/**
 * Produces a stable digest from an active watch summary for use in the tick gate
 * fingerprint. Only hashes counts and ordered status lines — NOT raw timestamps,
 * which change every second and would defeat the gate.
 *
 * Returns "__unknown__" when the summary is null (watch state unavailable).
 * The `shouldSkipTick` gate resolves this sentinel by appending the tick number,
 * ensuring the hash never matches and the LLM always runs.
 */
export function computeWatchSummaryDigest(summary: RuntimeActiveWatchSummary | null): string {
  if (!summary) {
    return '__unknown__';
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      totalCount: summary.totalCount,
      uniqueCount: summary.uniqueCount,
      lines: summary.lines,
      overflowCount: summary.overflowCount,
    }))
    .digest('hex');
}

/**
 * Produces a stable digest from a pending wake signal buffer for use in the
 * tick gate fingerprint. Only hashes source+reason pairs (sorted by source for
 * stability) — NOT timestamps, which change every tick and would defeat the gate.
 *
 * Returns "__none__" when the buffer is null, undefined, or empty.
 * This sentinel is stable between ticks with no pending signals, allowing the
 * gate to skip when nothing has changed.
 */
export function computeWakeSignalDigest(
  signals: Array<{ source: string; reason: string }> | null | undefined,
): string {
  if (!signals || signals.length === 0) {
    return '__none__';
  }
  // Sort by source then reason for stable, deterministic ordering
  const sorted = [...signals].sort((a, b) =>
    a.source.localeCompare(b.source, 'en') || a.reason.localeCompare(b.reason, 'en')
  );
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted.map((s) => ({ source: s.source, reason: s.reason }))))
    .digest('hex');
}

/**
 * Produces a stable digest from risk/playbook data that materially affects
 * agent actionability. Hashes the drawdown bucket (bucketed into bands so
 * small fluctuations within a band don't invalidate the hash) and the raw
 * open position count (every position opened/closed is meaningful).
 *
 * Returns "__unknown__" when both inputs are null/undefined (data unavailable).
 * The shouldSkipTick gate resolves this sentinel by appending the tick number,
 * ensuring the hash never matches and the LLM always runs.
 */
export function computeRiskPlaybookDigest(input: {
  openPositionCount?: number | null;
  drawdownPct?: number | null;
}): string {
  if (
    (input.openPositionCount === null || input.openPositionCount === undefined)
    && (input.drawdownPct === null || input.drawdownPct === undefined)
  ) {
    return '__unknown__';
  }

  const drawdownBucket = computeDrawdownBucket(input.drawdownPct ?? null);
  const openPositionCount = input.openPositionCount ?? 0;

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ drawdownBucket, openPositionCount }))
    .digest('hex');
}

/**
 * Bucket drawdown percentage into coarse bands so small fluctuations within a
 * band don't invalidate the tick gate fingerprint.
 */
function computeDrawdownBucket(drawdownPct: number | null): string {
  if (drawdownPct === null || drawdownPct === undefined || !Number.isFinite(drawdownPct)) {
    return '0';
  }
  const abs = Math.abs(drawdownPct);
  if (abs <= 0) return '0';
  if (abs <= 5) return '0-5';
  if (abs <= 10) return '5-10';
  if (abs <= 20) return '10-20';
  return '20+';
}

export function computeDecisionContextHash(input: {
  positionSide?: string | null;
  latestPrice?: number | null;
  portfolioPnlUsd?: number | null;
  regimePass?: boolean | null;
  instrumentSnapshots?: InstrumentHashEntry[];
  watchSummaryDigest?: string;
  wakeSignalDigest?: string;
  riskPlaybookDigest?: string;
  marketEventDigest?: string;
}): string {
  // When multi-instrument snapshots are available, use the sorted per-instrument
  // summary for a stable, order-independent hash. This ensures a price move in
  // any tracked instrument is detected regardless of message ordering.
  if (input.instrumentSnapshots && input.instrumentSnapshots.length > 0) {
    const payload: Record<string, unknown> = {
      instruments: input.instrumentSnapshots,
      regimePass: input.regimePass ?? 'unknown',
    };
    if (input.watchSummaryDigest !== undefined) {
      payload.watchSummaryDigest = input.watchSummaryDigest;
    }
    if (input.wakeSignalDigest !== undefined) {
      payload.wakeSignalDigest = input.wakeSignalDigest;
    }
    if (input.riskPlaybookDigest !== undefined) {
      payload.riskPlaybookDigest = input.riskPlaybookDigest;
    }
    if (input.marketEventDigest !== undefined) {
      payload.marketEventDigest = input.marketEventDigest;
    }
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  // Single-instrument fallback: uses aggregate scalars.
  const payload: Record<string, unknown> = {
    positionSide: input.positionSide ?? 'flat',
    priceBucket: computePriceBucket(input.latestPrice),
    pnlBucket: computePnlBucket(input.portfolioPnlUsd),
    regimePass: input.regimePass ?? 'unknown',
  };
  if (input.watchSummaryDigest !== undefined) {
    payload.watchSummaryDigest = input.watchSummaryDigest;
  }
  if (input.wakeSignalDigest !== undefined) {
    payload.wakeSignalDigest = input.wakeSignalDigest;
  }
  if (input.riskPlaybookDigest !== undefined) {
    payload.riskPlaybookDigest = input.riskPlaybookDigest;
  }
  if (input.marketEventDigest !== undefined) {
    payload.marketEventDigest = input.marketEventDigest;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

export function calculateAtrPercent(candles: PriceCandle[]): number | null {
  if (candles.length < 2) {
    return null;
  }

  const sample = candles.slice(-Math.min(14, candles.length));
  let totalTrueRange = 0;

  for (let index = 0; index < sample.length; index++) {
    const candle = sample[index]!;
    const previousClose = index === 0 ? candle.close : sample[index - 1]!.close;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    totalTrueRange += trueRange;
  }

  const lastClose = sample[sample.length - 1]!.close;
  if (!Number.isFinite(lastClose) || lastClose <= 0) {
    return null;
  }

  const atr = totalTrueRange / sample.length;
  return (atr / lastClose) * 100;
}

export function resolveAdaptiveIntervalMs(params: {
  volatilityPct?: number | null;
  baseTickIntervalMs?: number;
  currentTickIntervalMs?: number;
}): { nextTickIntervalMs: number; volatilityPct?: number } {
  const baseTickIntervalMs = params.baseTickIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
  const currentTickIntervalMs = params.currentTickIntervalMs ?? baseTickIntervalMs;
  const volatilityPct = params.volatilityPct ?? null;

  if (volatilityPct === null) {
    return { nextTickIntervalMs: currentTickIntervalMs };
  }

  if (volatilityPct < LOW_VOL_THRESHOLD_PCT) {
    return {
      nextTickIntervalMs: Math.min(baseTickIntervalMs * 2, baseTickIntervalMs * 2),
      volatilityPct,
    };
  }

  return {
    nextTickIntervalMs: Math.max(baseTickIntervalMs, Math.floor(currentTickIntervalMs / 2)),
    volatilityPct,
  };
}

export async function shouldSkipTick(
  state: TickGateState,
  dependencies: TickGateDependencies,
): Promise<TickSkipDecision> {
  const enabledGates = {
    session: state.enabledGates?.session ?? true,
    regime: state.enabledGates?.regime ?? true,
    contextHash: state.enabledGates?.contextHash ?? true,
    adaptiveInterval: state.enabledGates?.adaptiveInterval ?? true,
  };

  // Resolve the effective watch digest, handling the "__unknown__" sentinel.
  // When the watch state could not be loaded, append the tick number so the
  // hash always differs — the gate must err on the side of running the LLM.
  const effectiveWatchDigest = state.watchSummaryDigest === '__unknown__'
    ? `__unknown__${state.tickNumber}`
    : state.watchSummaryDigest;

  // Resolve the effective risk/playbook digest with the same "__unknown__"
  // sentinel semantics: when risk data is unavailable, append the tick number
  // so the hash never matches.
  const effectiveRiskPlaybookDigest = state.riskPlaybookDigest === '__unknown__'
    ? `__unknown__${state.tickNumber}`
    : state.riskPlaybookDigest;

  let adaptiveIntervalDegraded = false;
  let regimeDegraded = false;

  const degradationInfo = (): Pick<TickSkipDecision, 'degraded' | 'degradationReason'> | Record<string, never> => {
    if (adaptiveIntervalDegraded) {
      return { degraded: true, degradationReason: 'adaptive_interval_unavailable' };
    }
    if (regimeDegraded) {
      return { degraded: true, degradationReason: 'regime_unavailable' };
    }
    return {};
  };

  const adaptiveInterval =
    enabledGates.adaptiveInterval && dependencies.fetchVolatilityPct
      ? await (async () => {
          try {
            return resolveAdaptiveIntervalMs({
              volatilityPct: await dependencies.fetchVolatilityPct!(),
              baseTickIntervalMs: state.baseTickIntervalMs,
              currentTickIntervalMs: state.currentTickIntervalMs,
            });
          } catch {
            adaptiveIntervalDegraded = true;
            return {
              nextTickIntervalMs:
                state.currentTickIntervalMs ??
                state.baseTickIntervalMs ??
                DEFAULT_BASE_INTERVAL_MS,
            };
          }
        })()
      : { nextTickIntervalMs: state.currentTickIntervalMs ?? state.baseTickIntervalMs ?? DEFAULT_BASE_INTERVAL_MS };

  if (enabledGates.session && !state.hasOpenPositions && !isWithinTradingHours(state.now ?? new Date(), state.tradingHours)) {
    return {
      skip: true,
      gate: 'session',
      reason: 'outside_trading_hours',
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
      ...degradationInfo(),
    };
  }

  if (state.hasOpenPositions) {
    const contextHash = computeDecisionContextHash({
      positionSide: state.positionSide,
      latestPrice: state.latestPrice,
      portfolioPnlUsd: state.portfolioPnlUsd,
      regimePass: null,
      instrumentSnapshots: state.instrumentSnapshots,
      watchSummaryDigest: effectiveWatchDigest,
      wakeSignalDigest: state.wakeSignalDigest,
      riskPlaybookDigest: effectiveRiskPlaybookDigest,
      marketEventDigest: state.marketEventDigest,
    });

    if (
      enabledGates.contextHash
      && !state.hasWakeSignal
      && state.previousContextHash
      && state.tickNumber % FORCE_FULL_EVALUATION_EVERY_TICK !== 0
      && contextHash === state.previousContextHash
    ) {
      return {
        skip: true,
        gate: 'context_hash',
        reason: 'context_unchanged',
        contextHash,
        nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
        volatilityPct: adaptiveInterval.volatilityPct,
        ...degradationInfo(),
      };
    }

    return {
      skip: false,
      contextHash,
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
      ...degradationInfo(),
    };
  }

  let regime: RegimeResult | null = null;
  if (enabledGates.regime && dependencies.evaluateRegime) {
    try {
      regime = await dependencies.evaluateRegime();
    } catch {
      regimeDegraded = true;
    }
  }

  const contextHash = computeDecisionContextHash({
    positionSide: state.positionSide,
    latestPrice: state.latestPrice,
    portfolioPnlUsd: state.portfolioPnlUsd,
    regimePass: regime?.pass ?? null,
    instrumentSnapshots: state.instrumentSnapshots,
    watchSummaryDigest: effectiveWatchDigest,
    wakeSignalDigest: state.wakeSignalDigest,
    riskPlaybookDigest: effectiveRiskPlaybookDigest,
    marketEventDigest: state.marketEventDigest,
  });

  if (regime !== null && !regime.pass) {
    return {
      skip: true,
      gate: 'regime',
      regime,
      reason: `regime_unfavorable: ${regime.reasons.join('; ')}`,
      contextHash,
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
      ...degradationInfo(),
    };
  }

  if (
    enabledGates.contextHash
    && !state.hasWakeSignal
    && state.previousContextHash
    && state.tickNumber % FORCE_FULL_EVALUATION_EVERY_TICK !== 0
    && contextHash === state.previousContextHash
  ) {
    return {
      skip: true,
      gate: 'context_hash',
      reason: 'context_unchanged',
      ...(regime !== null ? { regime } : {}),
      contextHash,
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
      ...degradationInfo(),
    };
  }

  return {
    skip: false,
    ...(regime !== null ? { regime, gate: 'regime' as const } : {}),
    contextHash,
    nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
    volatilityPct: adaptiveInterval.volatilityPct,
    ...degradationInfo(),
  };
}