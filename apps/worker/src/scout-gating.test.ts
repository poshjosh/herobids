import { describe, expect, it } from 'vitest';
import { resolvePreScoutDecision } from './scout-gating.js';

describe('resolvePreScoutDecision', () => {
  it('forces escalation on the first tick before the scout runs', () => {
    expect(resolvePreScoutDecision({ tickCount: 1, reminderScheduledBy: null })).toEqual({
      decision: { disposition: 'escalate', reason: 'first_tick_always_escalates' },
      source: 'forced_first_tick',
    });
  });

  it('forces escalation when a reminder was scheduled by the judge', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: 'judge' })).toEqual({
      decision: { disposition: 'escalate', reason: 'judge_scheduled_reminder' },
      source: 'forced_judge_reminder',
    });
  });

  it('still runs the scout for scout-scheduled reminders', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: 'scout' })).toEqual({
      decision: null,
      source: 'scout',
    });
  });
});