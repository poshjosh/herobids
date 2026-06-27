import type { ScoutDecision } from './scout-dispatch.js';
import { normalizeTrackedSymbol } from './venue-intelligence.js';

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
  source: 'forced_first_tick' | 'forced_judge_reminder' | 'forced_open_positions' | 'scout';
}

export function resolvePreScoutDecision(params: {
  tickCount: number;
  reminderScheduledBy: 'scout' | 'judge' | null;
  hasOpenPositions?: boolean;
  /** Per-agent open position escalation to judge policy. Defaults to 'uncovered_or_triggered' for backward compatibility. */
  openPositionEscalationToJudgePolicy?: 'never' | 'uncovered_or_triggered' | 'always';
  /** True when at least one active watch has its condition met (e.g. stop-loss or take-profit crossed). */
  hasTriggeredWatch?: boolean;
  /** True when at least one open position has no active watch (unprotected exposure). */
  hasUncoveredPosition?: boolean;
}): PreScoutResolution {
  if (params.tickCount === 1) {
    return {
      decision: { disposition: 'escalate', reason: 'first_tick_always_escalates' },
      source: 'forced_first_tick',
    };
  }

  if (params.reminderScheduledBy === 'judge') {
    return {
      decision: { disposition: 'escalate', reason: 'judge_scheduled_reminder' },
      source: 'forced_judge_reminder',
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
      if (params.hasUncoveredPosition) {
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