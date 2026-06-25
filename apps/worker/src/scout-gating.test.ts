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

  it('forces escalation when there are open positions and policy is always', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: null, hasOpenPositions: true, openPositionEscalationToJudgePolicy: 'always' })).toEqual({
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

  it('allows scout for open positions when policy is never', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: null, hasOpenPositions: true, openPositionEscalationToJudgePolicy: 'never' })).toEqual({
      decision: null,
      source: 'scout',
    });
  });

  it('allows scout for open positions when policy is uncovered_or_triggered (explicit)', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: null, hasOpenPositions: true, openPositionEscalationToJudgePolicy: 'uncovered_or_triggered' })).toEqual({
      decision: null,
      source: 'scout',
    });
  });

  it('judge reminder still overrides all policies', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: 'judge', hasOpenPositions: true, openPositionEscalationToJudgePolicy: 'never' })).toEqual({
      decision: { disposition: 'escalate', reason: 'judge_scheduled_reminder' },
      source: 'forced_judge_reminder',
    });
  });

  it('first tick still overrides all policies', () => {
    expect(resolvePreScoutDecision({ tickCount: 1, reminderScheduledBy: null, hasOpenPositions: false, openPositionEscalationToJudgePolicy: 'never' })).toEqual({
      decision: { disposition: 'escalate', reason: 'first_tick_always_escalates' },
      source: 'forced_first_tick',
    });
  });

  it('treats invalid policy values like uncovered_or_triggered (default)', () => {
    expect(resolvePreScoutDecision({ tickCount: 2, reminderScheduledBy: null, hasOpenPositions: true, openPositionEscalationToJudgePolicy: 'invalid' as any })).toEqual({
      decision: null,
      source: 'scout',
    });
  });
});