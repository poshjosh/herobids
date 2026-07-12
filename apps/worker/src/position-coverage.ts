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
  /** True when the position has native exit-level protection (stopLoss / takeProfit armed in-process). */
  hasNativeProtection: boolean;
}

export interface CoverageEvaluationResult {
  /** Per-position coverage status (same order as input positions). */
  positions: PositionCoverageStatus[];
  /** True when any position lacks watch-based protective coverage. */
  hasUncoveredPosition: boolean;
  /** True when any position has neither native protection NOR watch-based coverage. */
  hasUnprotectedPosition: boolean;
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
  /** Canonical venue identifier (e.g. "hyperliquid", "jupiter"). Required for venue-disambiguated positionKey derivation. */
  venue: string;
  /** Canonical instrument ID from the venue's instrument repository. When present, used for Tier 2 identity matching. */
  instrumentId?: string;
  symbol: string;
  side: string;
  /** Native exit-level state from open positions — indicates in-process per-trade protection. */
  nativeExitLevels?: {
    stopLoss?: boolean;
    takeProfit?: boolean;
  };
}

export interface WatchInput {
  watchId: string;
  symbol: string;
  purpose?: string;
  /** Schema version discriminator (inert metadata). */
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

/**
 * Derive a canonical, stable position key for coverage matching.
 *
 * Contract:
 * - The same position MUST produce the same key in all relevant flows.
 * - The key MUST distinguish venue-specific exposures (e.g. Hyperliquid vs Jupiter BTC).
 * - Perp positions use canonical venue/instrument identity when available.
 * - Spot positions use chain/address when available (via instrumentId).
 *
 * Format: `${venue}::${instrumentId ?? symbol}::${side}`
 */
export function derivePositionKey(position: PositionInput): string {
  const id = position.instrumentId ?? position.symbol;
  return `${position.venue}::${id}::${position.side}`;
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
 *
 * A watch is trustable when it carries structured identity:
 * - schemaVersion >= 2 (the current structured watch model — only supported shape)
 * - coverage.positionKey (direct, worker-derived linkage)
 * - instrument.instrumentId (canonical venue instrument identity)
 *
 * Watches that lack ALL of these rely on symbol-only heuristics that may
 * conflate different instruments across venues and are NOT trustable.
 */
function isTrustableForCoverage(watch: WatchInput): boolean {
  // V2 structured watches are trustable — they carry purpose, instrument identity, etc.
  if (watch.schemaVersion && watch.schemaVersion >= 2) {
    return true;
  }
  // Direct position key linkage is the strongest signal
  if (watch.coverage?.positionKey) {
    return true;
  }
  // Canonical instrument identity provides venue-disambiguated matching
  if (watch.instrument?.instrumentId) {
    return true;
  }
  return false;
}

/**
 * Match a watch to a position using a 2-tier strategy:
 * 1. Direct linkage via coverage.positionKey (worker-derived)
 * 2. Instrument identity via instrument.instrumentId (canonical venue instrument)
 *
 * Symbol-only fallback has been removed — all supported watches carry
 * structured identity (schemaVersion >= 2), and coverage matching relies
 * on explicit linkage rather than same-symbol heuristics.
 */
function watchMatchesPosition(watch: WatchInput, position: PositionInput, positionKey: string): boolean {
  // Tier 1: Direct linkage via worker-derived positionKey
  if (watch.coverage?.positionKey && watch.coverage.positionKey === positionKey) {
    return true;
  }

  // Tier 2: Instrument identity matching via canonical instrumentId.
  // Both the watch and the position must carry instrumentId, and the venue
  // must match to prevent cross-venue false positives (e.g. same instrumentId
  // on Hyperliquid and Jupiter).
  if (watch.instrument?.instrumentId && position.instrumentId) {
    if (watch.instrument.instrumentId === position.instrumentId &&
        watch.instrument.venue === position.venue) {
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
  let hasUnprotectedPosition = false;
  let hasTriggeredProtectiveWatch = false;
  let hasStaleProtectiveWatch = false;

  for (const position of params.positions) {
    const positionKey = derivePositionKey(position);
    let protectiveWatchCount = 0;
    let hasProtectiveCoverage = false;
    let triggeredProtectiveWatch = false;
    let staleProtectiveWatch = false;

    for (const watch of params.watches) {
      // Skip watches that cannot be trusted for coverage — avoid wasting
      // symbol-normalization work on watches that will be rejected anyway.
      if (!isTrustableForCoverage(watch)) {
        continue;
      }

      if (!watchMatchesPosition(watch, position, positionKey)) {
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

    // Native protection: position has in-process exit levels (stopLoss / takeProfit)
    const hasNativeProtection = position.nativeExitLevels
      ? (position.nativeExitLevels.stopLoss === true || position.nativeExitLevels.takeProfit === true)
      : false;

    if (!hasProtectiveCoverage) {
      hasUncoveredPosition = true;
    }

    // A position is truly unprotected when it has NEITHER watch-based NOR native protection
    if (!hasProtectiveCoverage && !hasNativeProtection) {
      hasUnprotectedPosition = true;
    }

    const status: PositionCoverageStatus = {
      positionKey,
      protectiveWatchCount,
      hasProtectiveCoverage,
      triggeredProtectiveWatch,
      staleProtectiveWatch,
      hasNativeProtection,
    };

    positions.push(status);

    if (triggeredProtectiveWatch) hasTriggeredProtectiveWatch = true;
    if (staleProtectiveWatch) hasStaleProtectiveWatch = true;
  }

  return {
    positions,
    hasUncoveredPosition,
    hasUnprotectedPosition,
    hasTriggeredProtectiveWatch,
    hasStaleProtectiveWatch,
    totalOpenPositions: params.positions.length,
  };
}
