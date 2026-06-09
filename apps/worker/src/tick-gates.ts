import crypto from 'node:crypto';
import type { PriceCandle, RegimeResult } from '@herobids/market-data';

export interface TickGateState {
  tickNumber: number;
  hasOpenPositions: boolean;
  tradingHours?: TradingHoursConfig;
  now?: Date;
  positionSide?: string | null;
  latestPrice?: number | null;
  portfolioPnlUsd?: number | null;
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
  fetchVolatilityCandles?: () => Promise<PriceCandle[]>;
}

export interface TradingHoursConfig {
  allowedHoursUtc?: number[];
  weekendPause?: boolean;
}

export interface TickSkipDecision {
  skip: boolean;
  reason?: string;
  gate?: 'session' | 'regime' | 'context_hash';
  regime?: RegimeResult;
  contextHash?: string;
  nextTickIntervalMs: number;
  volatilityPct?: number;
}

const DEFAULT_BASE_INTERVAL_MS = 900_000;
const LOW_VOL_THRESHOLD_PCT = 0.3;
const FORCE_FULL_EVALUATION_EVERY_TICK = 10;

export function isWithinTradingHours(now: Date, tradingHours?: TradingHoursConfig): boolean {
  if (!tradingHours) {
    return true;
  }

  const allowedHours = tradingHours.allowedHoursUtc ?? [];
  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const weekendPaused = Boolean(tradingHours.weekendPause)
    && (day === 6 || (day === 0 && hour < 12));

  if (weekendPaused) {
    return false;
  }

  if (allowedHours.length === 0) {
    return true;
  }

  return allowedHours.includes(hour);
}

function computePriceBucket(price?: number | null): string {
  if (!price || !Number.isFinite(price) || price <= 0) {
    return 'unknown';
  }
  return String(Math.round(Math.log(price) / Math.log(1.005)));
}

function computePnlBucket(portfolioPnlUsd?: number | null): string {
  if (portfolioPnlUsd === null || portfolioPnlUsd === undefined || !Number.isFinite(portfolioPnlUsd)) {
    return 'unknown';
  }
  return String(Math.round(portfolioPnlUsd / 10) * 10);
}

export function computeDecisionContextHash(input: {
  positionSide?: string | null;
  latestPrice?: number | null;
  portfolioPnlUsd?: number | null;
  regimePass?: boolean | null;
}): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      positionSide: input.positionSide ?? 'flat',
      priceBucket: computePriceBucket(input.latestPrice),
      pnlBucket: computePnlBucket(input.portfolioPnlUsd),
      regimePass: input.regimePass ?? 'unknown',
    }))
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
  candles?: PriceCandle[];
  baseTickIntervalMs?: number;
  currentTickIntervalMs?: number;
}): { nextTickIntervalMs: number; volatilityPct?: number } {
  const baseTickIntervalMs = params.baseTickIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
  const currentTickIntervalMs = params.currentTickIntervalMs ?? baseTickIntervalMs;
  const volatilityPct = params.candles ? calculateAtrPercent(params.candles) : null;

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

  const adaptiveInterval = enabledGates.adaptiveInterval && dependencies.fetchVolatilityCandles
    ? resolveAdaptiveIntervalMs({
        candles: await dependencies.fetchVolatilityCandles(),
        baseTickIntervalMs: state.baseTickIntervalMs,
        currentTickIntervalMs: state.currentTickIntervalMs,
      })
    : { nextTickIntervalMs: state.currentTickIntervalMs ?? state.baseTickIntervalMs ?? DEFAULT_BASE_INTERVAL_MS };

  if (enabledGates.session && !state.hasOpenPositions && !isWithinTradingHours(state.now ?? new Date(), state.tradingHours)) {
    return {
      skip: true,
      gate: 'session',
      reason: 'outside_trading_hours',
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
    };
  }

  if (state.hasOpenPositions) {
    const contextHash = computeDecisionContextHash({
      positionSide: state.positionSide,
      latestPrice: state.latestPrice,
      portfolioPnlUsd: state.portfolioPnlUsd,
      regimePass: null,
    });

    if (
      enabledGates.contextHash
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
      };
    }

    return {
      skip: false,
      contextHash,
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
    };
  }

  if (!enabledGates.regime || !dependencies.evaluateRegime) {
    const contextHash = computeDecisionContextHash({
      positionSide: state.positionSide,
      latestPrice: state.latestPrice,
      portfolioPnlUsd: state.portfolioPnlUsd,
      regimePass: null,
    });
    if (
      enabledGates.contextHash
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
      };
    }

    return {
      skip: false,
      contextHash,
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
    };
  }

  const regime = await dependencies.evaluateRegime();
  const contextHash = computeDecisionContextHash({
    positionSide: state.positionSide,
    latestPrice: state.latestPrice,
    portfolioPnlUsd: state.portfolioPnlUsd,
    regimePass: regime.pass,
  });

  if (regime.pass) {
    if (
      enabledGates.contextHash
      && state.previousContextHash
      && state.tickNumber % FORCE_FULL_EVALUATION_EVERY_TICK !== 0
      && contextHash === state.previousContextHash
    ) {
      return {
        skip: true,
        gate: 'context_hash',
        reason: 'context_unchanged',
        regime,
        contextHash,
        nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
        volatilityPct: adaptiveInterval.volatilityPct,
      };
    }

    return {
      skip: false,
      regime,
      gate: 'regime',
      contextHash,
      nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
      volatilityPct: adaptiveInterval.volatilityPct,
    };
  }

  return {
    skip: true,
    gate: 'regime',
    regime,
    reason: `regime_unfavorable: ${regime.reasons.join('; ')}`,
    contextHash,
    nextTickIntervalMs: adaptiveInterval.nextTickIntervalMs,
    volatilityPct: adaptiveInterval.volatilityPct,
  };
}