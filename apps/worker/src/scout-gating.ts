import type { ScoutDecision } from './scout-dispatch.js';
import { normalizeTrackedSymbol } from './venue-intelligence.js';

/**
 * @deprecated Use {@link evaluatePositionCoverage} from `position-coverage.ts`
 * instead — it provides structured watch metadata matching (purpose,
 * instrument identity, coverage links) rather than coarse symbol matching.
 */
export function hasUncoveredTrackedPosition(params: {
  openPositionSymbols: readonly string[];
  watchSymbols: readonly string[];
}): boolean {
  const coveredSymbols = new Set(
    params.watchSymbols
      .map((symbol) => normalizeTrackedSymbol(symbol))
      .filter((symbol): symbol is string => symbol !== null),
  );

  return params.openPositionSymbols.some((symbol) => {
    const normalized = normalizeTrackedSymbol(symbol);
    return normalized !== null && !coveredSymbols.has(normalized);
  });
}

export type ForcedPreScoutBillingOutcome =
  | { action: 'skip_tick'; reason: 'billing.limit_exceeded' }
  | { action: 'continue'; decision: ScoutDecision };

export function resolveForcedPreScoutBillingOutcome(params: {
  preScoutDecision: ScoutDecision;
  isHardLimited: boolean;
}): ForcedPreScoutBillingOutcome {
  if (params.isHardLimited) {
    return { action: 'skip_tick', reason: 'billing.limit_exceeded' };
  }

  return {
    action: 'continue',
    decision: params.preScoutDecision,
  };
}

export interface PreScoutResolution {
  decision: ScoutDecision | null;
  source: 'forced_first_tick' | 'forced_user_message' | 'forced_judge_reminder' | 'forced_stale_coverage' | 'forced_open_positions' | 'scout';
}

export function resolvePreScoutDecision(params: {
  tickCount: number;
  reminderScheduledBy: 'scout' | 'judge' | null;
  /**
   * True when the current tick was triggered by (or carries) an inbound user
   * message. A direct message from the user must always reach the judge so the
   * agent can compose and send a reply — it must never be held at the scout
   * triage step (which is designed for market-monitoring, not conversation).
   */
  userMessageReceived?: boolean;
  hasOpenPositions?: boolean;
  /** Per-agent open position escalation to judge policy. Defaults to 'uncovered_or_triggered' for backward compatibility. */
  openPositionEscalationToJudgePolicy?: 'never' | 'uncovered_or_triggered' | 'always';
  /** True when at least one active watch has its condition met (e.g. stop-loss or take-profit crossed). */
  hasTriggeredWatch?: boolean;
  /** True when at least one open position has no active watch (unprotected exposure). */
  hasUncoveredPosition?: boolean;
  /** True when at least one protective watch is stale (lastCheckedAt exceeds threshold). */
  hasStaleCoverage?: boolean;
  /**
   * True when at least one open position has NEITHER watch-based coverage NOR native
   * exit-level protection (in-process stopLoss/takeProfit). When false (all positions
   * have SOME protection), suppresses open_position_uncovered escalation under
   * uncovered_or_triggered policy. When undefined, falls back to hasUncoveredPosition behavior.
   */
  hasUnprotectedPosition?: boolean;
}): PreScoutResolution {
  if (params.tickCount === 1) {
    return {
      decision: { disposition: 'escalate', reason: 'first_tick_always_escalates' },
      source: 'forced_first_tick',
    };
  }

  // A user message always escalates to the judge — the scout must not hold a
  // direct message from the user (that would leave the user with no response).
  if (params.userMessageReceived) {
    return {
      decision: { disposition: 'escalate', reason: 'user_message' },
      source: 'forced_user_message',
    };
  }

  if (params.reminderScheduledBy === 'judge') {
    return {
      decision: { disposition: 'escalate', reason: 'judge_scheduled_reminder' },
      source: 'forced_judge_reminder',
    };
  }

  // Stale protective coverage is inherently unsafe regardless of the
  // openPositionEscalationToJudgePolicy setting — stale data means the
  // system can't trust its risk assessment. This check happens before
  // the policy evaluation so it always escalates.
  // Requires hasOpenPositions because no positions = nothing to cover.
  if (params.hasOpenPositions && params.hasStaleCoverage) {
    const reason = params.hasTriggeredWatch
      ? 'stale_protective_coverage_with_triggered_watch'
      : 'stale_protective_coverage';
    return {
      decision: { disposition: 'escalate', reason },
      source: 'forced_stale_coverage',
    };
  }

  const requestedPolicy = params.openPositionEscalationToJudgePolicy;
  const policy = requestedPolicy === 'never' || requestedPolicy === 'always' || requestedPolicy === 'uncovered_or_triggered'
    ? requestedPolicy
    : 'uncovered_or_triggered';

  if (params.hasOpenPositions) {
    if (policy === 'always') {
      return {
        decision: { disposition: 'escalate', reason: 'open_positions_require_active_management' },
        source: 'forced_open_positions',
      };
    }
    if (policy === 'uncovered_or_triggered') {
      if (params.hasTriggeredWatch) {
        return {
          decision: { disposition: 'escalate', reason: 'watch_triggered' },
          source: 'forced_open_positions',
        };
      }
      // When hasUnprotectedPosition is provided, use it as the definitive signal.
      // If false, all positions have SOME protection (native or watch) → suppress escalation.
      // If undefined, fall back to hasUncoveredPosition for backward compatibility.
      const shouldEscalateUncovered = params.hasUnprotectedPosition !== undefined
        ? params.hasUnprotectedPosition
        : params.hasUncoveredPosition;
      if (shouldEscalateUncovered) {
        return {
          decision: { disposition: 'escalate', reason: 'open_position_uncovered' },
          source: 'forced_open_positions',
        };
      }
    }
    // 'never': do not force judge for open positions (scout runs as normal).
    // 'uncovered_or_triggered' without a triggered watch or uncovered position:
    // positions are covered and no watch fired — scout runs as normal.
  }

  return {
    decision: null,
    source: 'scout',
  };
}