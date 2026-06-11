import type { ScoutDecision } from './scout-dispatch.js';

export interface PreScoutResolution {
  decision: ScoutDecision | null;
  source: 'forced_first_tick' | 'forced_judge_reminder' | 'scout';
}

export function resolvePreScoutDecision(params: {
  tickCount: number;
  reminderScheduledBy: 'scout' | 'judge' | null;
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

  return {
    decision: null,
    source: 'scout',
  };
}