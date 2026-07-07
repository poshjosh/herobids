/**
 * Position coverage evaluator.
 *
 * Computes per-position protective coverage status using structured watch
 * metadata (purpose, instrument identity, coverage links).
 *
 * This is a pure function — no I/O. It receives position and watch data
 * and returns a structured evaluation result.
 */

import type { WatchPurpose } from '@herobids/domain';
import { normalizeTrackedSymbol } from './venue-intelligence.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Watch purposes that provide protective coverage (i.e., price-level defence). */
export const PROTECTIVE_WATCH_PURPOSES: readonly WatchPurpose[] = [
  'stop_loss',
  'take_profit',
  'exit',
] as const;

/** Default max age in ms before a protective watch is considered stale. */
export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PositionCoverageStatus {
  /** Derived key: `${instrumentId|symbol}::${side}` */
  positionKey: string;
  /** Number of protective watches matched to this position. */
  protectiveWatchCount: number;
  /** True when at least one matched watch has a protective purpose. */
  hasProtectiveCoverage: boolean;
  /** True when at least one matched protective watch has lastConditionMet === true. */
  triggeredProtectiveWatch: boolean;
  /** True when at least one matched protective watch has a stale lastCheckedAt. */
  staleProtectiveWatch: boolean;
}

export interface CoverageEvaluationResult {
  /** Per-position coverage status (same order as input positions). */
  positions: PositionCoverageStatus[];
  /** True when any position lacks protective coverage. */
  hasUncoveredPosition: boolean;
  /** True when any position has a triggered protective watch. */
  hasTriggeredProtectiveWatch: boolean;
  /** True when any position has a stale protective watch. */
  hasStaleProtectiveWatch: boolean;
  /** Total number of open positions evaluated. */
  totalOpenPositions: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface PositionInput {
  instrumentId?: string;
  symbol: string;
  side: string;
}

export interface WatchInput {
  watchId: string;
  symbol: string;
  purpose?: string;
  /** Schema version discriminator. undefined = legacy, 2 = v2. */
  schemaVersion?: number;
  instrument?: {
    venue: string;
    instrumentId: string;
    symbol: string;
  };
  coverage?: {
    positionKey?: string;
  };
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function derivePositionKey(position: PositionInput): string {
  const id = position.instrumentId ?? position.symbol;
  return `${id}::${position.side}`;
}

function isProtectivePurpose(purpose: string | undefined): boolean {
  return (PROTECTIVE_WATCH_PURPOSES as readonly string[]).includes(purpose ?? '');
}

function isStale(lastCheckedAt: string | undefined, staleThresholdMs: number): boolean {
  // Never checked is not stale — a newly created watch may not have had its
  // first monitor check yet. The watch will become stale after the first
  // check if the monitor subsequently falls behind the threshold.
  if (!lastCheckedAt) return false;
  const age = Date.now() - new Date(lastCheckedAt).getTime();
  return age > staleThresholdMs;
}

/**
 * Returns true when a watch can be trusted for protective coverage evaluation.
 * Legacy watches (no schemaVersion >= 2, no coverage.positionKey, no instrument.instrumentId)
 * cannot be trusted — they rely on symbol-only heuristics that may conflate different
 * instruments across venues.
 *
 * @returns true when the watch has sufficient structured identity to be trusted for protective coverage evaluation.
 */
function isTrustableForCoverage(watch: WatchInput): boolean {
  // V2 watches with schema version are trustable
  if (watch.schemaVersion && watch.schemaVersion >= 2) {
    return true;
  }
  // Watches with explicit position key linkage are trustable
  if (watch.coverage?.positionKey) {
    return true;
  }
  // Watches with canonical instrument identity are trustable
  if (watch.instrument?.instrumentId) {
    return true;
  }
  // Legacy watches without structured identity are NOT trustable for coverage
  return false;
}

/**
 * Match a watch to a position using a 3-tier strategy:
 * 1. Direct linkage via coverage.positionKey
 * 2. Instrument identity via instrument.instrumentId
 * 3. Symbol fallback via normalizeTrackedSymbol (only for trustable watches)
 */
function watchMatchesPosition(watch: WatchInput, position: PositionInput, positionKey: string): boolean {
  // Tier 1: Direct linkage
  if (watch.coverage?.positionKey && watch.coverage.positionKey === positionKey) {
    return true;
  }

  // Tier 2: Instrument identity
  // NOTE: This tier is currently unreachable for most positions because
  // live position inputs only carry `symbol` and `side` (no instrumentId).
  // It is intended for future use when positions carry full instrument
  // identity from the database (e.g. after venue-instrument-cache
  // enrichment flows through the position tracker).
  if (watch.instrument?.instrumentId && position.instrumentId) {
    if (watch.instrument.instrumentId === position.instrumentId) {
      return true;
    }
  }

  // Tier 3: Symbol fallback (normalized comparison)
  const normalizedWatchSymbol = normalizeTrackedSymbol(watch.symbol);
  const normalizedPositionSymbol = normalizeTrackedSymbol(position.symbol);
  if (normalizedWatchSymbol && normalizedPositionSymbol) {
    if (normalizedWatchSymbol === normalizedPositionSymbol) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

export function evaluatePositionCoverage(params: {
  positions: PositionInput[];
  watches: WatchInput[];
  /** Max age in ms before a watch is considered stale. Default: 5 minutes. */
  staleThresholdMs?: number;
}): CoverageEvaluationResult {
  const staleThresholdMs = params.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const positions: PositionCoverageStatus[] = [];
  let hasUncoveredPosition = false;
  let hasTriggeredProtectiveWatch = false;
  let hasStaleProtectiveWatch = false;

  for (const position of params.positions) {
    const positionKey = derivePositionKey(position);
    let protectiveWatchCount = 0;
    let hasProtectiveCoverage = false;
    let triggeredProtectiveWatch = false;
    let staleProtectiveWatch = false;

    for (const watch of params.watches) {
      if (!watchMatchesPosition(watch, position, positionKey)) {
        continue;
      }

      // Legacy watches without structured identity cannot be trusted for
      // protective coverage — skip them.
      if (!isTrustableForCoverage(watch)) {
        continue;
      }

      if (isProtectivePurpose(watch.purpose)) {
        protectiveWatchCount++;
        hasProtectiveCoverage = true;

        if (watch.lastConditionMet === true) {
          triggeredProtectiveWatch = true;
        }

        if (isStale(watch.lastCheckedAt, staleThresholdMs)) {
          staleProtectiveWatch = true;
        }
      }
    }

    if (!hasProtectiveCoverage) {
      hasUncoveredPosition = true;
    }

    const status: PositionCoverageStatus = {
      positionKey,
      protectiveWatchCount,
      hasProtectiveCoverage,
      triggeredProtectiveWatch,
      staleProtectiveWatch,
    };

    positions.push(status);

    if (triggeredProtectiveWatch) hasTriggeredProtectiveWatch = true;
    if (staleProtectiveWatch) hasStaleProtectiveWatch = true;
  }

  return {
    positions,
    hasUncoveredPosition,
    hasTriggeredProtectiveWatch,
    hasStaleProtectiveWatch,
    totalOpenPositions: params.positions.length,
  };
}
