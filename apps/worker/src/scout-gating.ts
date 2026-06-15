import type { ScoutDecision } from './scout-dispatch.js';

export interface PreScoutResolution {
  decision: ScoutDecision | null;
  source: 'forced_first_tick' | 'forced_judge_reminder' | 'forced_open_positions' | 'scout';
}

export function resolvePreScoutDecision(params: {
  tickCount: number;
  reminderScheduledBy: 'scout' | 'judge' | null;
  hasOpenPositions?: boolean;
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

  if (params.hasOpenPositions) {
    return {
      decision: { disposition: 'escalate', reason: 'open_positions_require_active_management' },
      source: 'forced_open_positions',
    };
  }

  return {
    decision: null,
    source: 'scout',
  };
}