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

  it('forces escalation when there are open positions', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: null, hasOpenPositions: true })).toEqual({
      decision: { disposition: 'escalate', reason: 'open_positions_require_active_management' },
      source: 'forced_open_positions',
    });
  });

  it('runs the scout when there are no open positions', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: null, hasOpenPositions: false })).toEqual({
      decision: null,
      source: 'scout',
    });
  });

  it('judge reminder takes priority over open positions', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: 'judge', hasOpenPositions: true })).toEqual({
      decision: { disposition: 'escalate', reason: 'judge_scheduled_reminder' },
      source: 'forced_judge_reminder',
    });
  });
});