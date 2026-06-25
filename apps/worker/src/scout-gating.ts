import type { ScoutDecision } from './scout-dispatch.js';

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

  const policy = params.openPositionEscalationToJudgePolicy ?? 'uncovered_or_triggered';

  if (params.hasOpenPositions) {
    if (policy === 'always') {
      return {
        decision: { disposition: 'escalate', reason: 'open_positions_require_active_management' },
        source: 'forced_open_positions',
      };
    }
    // 'never': do not force judge for open positions (scout runs as normal).
    // 'uncovered_or_triggered': future — will force judge only when coverage is missing
    // or a watch fires. Until structured watch coverage exists, proxied as allow-scout
    // (same as 'never') — the narrowest trustworthy proxy available.
  }

  return {
    decision: null,
    source: 'scout',
  };
}