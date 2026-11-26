import { describe, expect, it } from 'vitest';
import type { ReasoningLevel } from '@herobids/domain';
import {
  buildTickRunInput,
  classifyIncomingUserMessages,
  classifyTickRun,
  extractDrawdownPct,
  hasMarketWake,
  resolveJudgeRunClassification,
  resolveRunReasoning,
  toReasoningEventFields,
  type RunImportance,
} from './tick-thinking.js';

const flat = { hasOpenPositions: false, drawdownThresholdPct: -2 };

describe('classifyTickRun', () => {
  it('treats a regime flip as important', () => {
    expect(classifyTickRun({ ...flat, previousRegimePass: false, regimePass: true }))
      .toEqual({ importance: 'important', reason: 'regime_flip' });
  });

  it('treats a drawdown at or past the threshold as important (inclusive)', () => {
    expect(classifyTickRun({ ...flat, hasOpenPositions: true, drawdownPct: -2 }))
      .toEqual({ importance: 'important', reason: 'drawdown_threshold' });
    expect(classifyTickRun({ ...flat, hasOpenPositions: true, drawdownPct: -5.1, drawdownThresholdPct: -5 }))
      .toEqual({ importance: 'important', reason: 'drawdown_threshold' });
  });

  it('does not treat a drawdown above the threshold as important', () => {
    expect(classifyTickRun({ ...flat, hasOpenPositions: true, drawdownPct: -1.9 }))
      .toEqual({ importance: 'lighter', reason: 'open_positions' });
  });

  it('treats a user message as important', () => {
    expect(classifyTickRun({ ...flat, userMessageReceived: true }))
      .toEqual({ importance: 'important', reason: 'user_message' });
  });

  it('treats a reminder wake that carries work as important', () => {
    expect(classifyTickRun({ ...flat, workWakeReceived: true }))
      .toEqual({ importance: 'important', reason: 'work_wake' });
  });

  it('treats a peer message or child report as important', () => {
    expect(classifyTickRun({ ...flat, agentMessageReceived: true }))
      .toEqual({ importance: 'important', reason: 'agent_message' });
  });

  it('treats a work wake as important even with open positions', () => {
    expect(classifyTickRun({ ...flat, hasOpenPositions: true, workWakeReceived: true }))
      .toEqual({ importance: 'important', reason: 'work_wake' });
  });

  it('names the trading trigger first, then the user message, when several apply', () => {
    expect(classifyTickRun({ ...flat, previousRegimePass: false, regimePass: true, userMessageReceived: true }).reason)
      .toBe('regime_flip');
    expect(classifyTickRun({ ...flat, userMessageReceived: true, workWakeReceived: true, agentMessageReceived: true }).reason)
      .toBe('user_message');
  });

  it('treats a protection gap as important, ahead of a user message', () => {
    expect(classifyTickRun({ ...flat, hasOpenPositions: true, protectionGap: true, userMessageReceived: true }))
      .toEqual({ importance: 'important', reason: 'protection_gap' });
  });

  it('treats a market wake as important, but names a user message first', () => {
    expect(classifyTickRun({ ...flat, marketWakeReceived: true }))
      .toEqual({ importance: 'important', reason: 'market_wake' });
    expect(classifyTickRun({ ...flat, marketWakeReceived: true, userMessageReceived: true }).reason).toBe('user_message');
  });

  it('treats the first run as important', () => {
    expect(classifyTickRun({ ...flat, firstRun: true })).toEqual({ importance: 'important', reason: 'first_run' });
  });

  it('treats a tick with open positions and no event as lighter', () => {
    expect(classifyTickRun({ ...flat, hasOpenPositions: true }))
      .toEqual({ importance: 'lighter', reason: 'open_positions' });
  });

  it('treats a tick with nothing to act on as routine', () => {
    expect(classifyTickRun(flat)).toEqual({ importance: 'routine', reason: 'routine_tick' });
  });
});

describe('classifyIncomingUserMessages', () => {
  it('tells the owner\'s message from an agent\'s', () => {
    expect(classifyIncomingUserMessages([{ type: 'user.message', initiatorType: 'user' }], false))
      .toEqual({ userMessageReceived: true, agentMessageReceived: false });
    expect(classifyIncomingUserMessages([
      { type: 'agent.user.message', initiatorType: 'agent', payload: { message: 'done', childReport: { childAgentId: 'c', childName: 'C' } } },
    ], false)).toEqual({ userMessageReceived: false, agentMessageReceived: true });
  });

  it('ignores runtime events that are not user messages', () => {
    expect(classifyIncomingUserMessages([{ type: 'instance.execution.result' }, { type: 'agent.wake' }], false))
      .toEqual({ userMessageReceived: false, agentMessageReceived: false });
  });

  it('counts a user message flagged by the wake poll but not read this tick as the owner\'s', () => {
    expect(classifyIncomingUserMessages([], true)).toEqual({ userMessageReceived: true, agentMessageReceived: false });
    expect(classifyIncomingUserMessages([{ type: 'agent.user.message', initiatorType: 'agent' }], true))
      .toEqual({ userMessageReceived: false, agentMessageReceived: true });
  });
});

describe('extractDrawdownPct', () => {
  it('extracts percentage values from pnl strings', () => {
    expect(extractDrawdownPct('Net P&L: -2.4% today')).toBe(-2.4);
    expect(extractDrawdownPct('+$12.00')).toBeNull();
  });
});

const LEVELS: ReasoningLevel[] = ['none', 'low', 'medium', 'high'];
const ORDER: Record<ReasoningLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

describe('resolveRunReasoning', () => {
  const run = (importance: RunImportance) => ({ importance, reason: `${importance}_reason` });

  // D20 mapping table: [user level, important, lighter, routine] with adaptive on.
  const adaptiveTable: Array<[ReasoningLevel, ReasoningLevel, ReasoningLevel, ReasoningLevel]> = [
    ['high', 'high', 'medium', 'none'],
    ['medium', 'medium', 'low', 'none'],
    ['low', 'low', 'none', 'none'],
    ['none', 'none', 'none', 'none'],
  ];

  it.each(adaptiveTable)('with adaptive on and user level %s: important %s, lighter %s, routine %s', (userLevel, important, lighter, routine) => {
    expect(resolveRunReasoning(run('important'), userLevel, true).level).toBe(important);
    expect(resolveRunReasoning(run('lighter'), userLevel, true).level).toBe(lighter);
    expect(resolveRunReasoning(run('routine'), userLevel, true).level).toBe(routine);
  });

  it.each(LEVELS)('with adaptive off uses user level %s exactly for every run', (userLevel) => {
    for (const importance of ['important', 'lighter', 'routine'] as const) {
      expect(resolveRunReasoning(run(importance), userLevel, false)).toEqual({
        level: userLevel,
        reason: 'adaptive_off',
        ceiling: userLevel,
        adaptive: false,
      });
    }
  });

  it('never runs above the user level', () => {
    for (const userLevel of LEVELS) {
      for (const importance of ['important', 'lighter', 'routine'] as const) {
        for (const adaptive of [true, false]) {
          expect(ORDER[resolveRunReasoning(run(importance), userLevel, adaptive).level]).toBeLessThanOrEqual(ORDER[userLevel]);
        }
      }
    }
  });

  it('keeps medium at medium for an important run instead of raising it to high', () => {
    expect(resolveRunReasoning({ importance: 'important', reason: 'user_message' }, 'medium', true).level).toBe('medium');
  });

  it('reports the run reason and the user ceiling with adaptive on', () => {
    expect(resolveRunReasoning({ importance: 'lighter', reason: 'open_positions' }, 'high', true)).toEqual({
      level: 'medium',
      reason: 'open_positions',
      ceiling: 'high',
      adaptive: true,
    });
  });

  it('runs a routine tick with reasoning off', () => {
    expect(resolveRunReasoning(classifyTickRun(flat), 'high', true)).toMatchObject({ level: 'none', reason: 'routine_tick' });
  });

  it('runs a reminder wake at the user level', () => {
    expect(resolveRunReasoning(classifyTickRun({ ...flat, workWakeReceived: true }), 'medium', true))
      .toMatchObject({ level: 'medium', reason: 'work_wake' });
  });
});

describe('toReasoningEventFields', () => {
  it('names the fields of the agent.llm.completed event', () => {
    expect(toReasoningEventFields({ level: 'low', reason: 'open_positions', ceiling: 'medium', adaptive: true })).toEqual({
      reasoningLevel: 'low',
      reasoningReason: 'open_positions',
      reasoningCeiling: 'medium',
      adaptiveReasoning: true,
    });
  });

  it('adds the reasoning the provider was sent when known', () => {
    expect(toReasoningEventFields({ level: 'none', reason: 'routine_tick', ceiling: 'medium', adaptive: true }, 'omitted'))
      .toMatchObject({ reasoningLevel: 'none', reasoningSent: 'omitted' });
  });
});

describe('hasMarketWake', () => {
  const scannerWake = (scannerKind: string) => ({ source: 'scanner', reason: 'review', context: { scannerKind } });

  it('counts a scanner review wake, which review routing consumes before the context build', () => {
    for (const kind of ['preset_review', 'assessment_review']) {
      const marketWakeReceived = hasMarketWake({ currentMarketWake: scannerWake(kind) });
      expect(marketWakeReceived, kind).toBe(true);
      expect(classifyTickRun({ ...flat, marketWakeReceived })).toEqual({ importance: 'important', reason: 'market_wake' });
    }
  });

  it('is false without a wake', () => {
    expect(hasMarketWake({ currentMarketWake: null })).toBe(false);
  });
});

describe('buildTickRunInput', () => {
  const quiet: Parameters<typeof buildTickRunInput>[0] = {
    hasOpenPositions: false,
    previousRegimePass: null,
    regimePass: null,
    incomingMessages: [],
    hasPendingUserMessage: false,
    reminderScheduledBy: null,
    marketWakeReceived: false,
    firstModelRun: false,
    isResumedFullEvaluation: false,
    hasTriggeredWatch: false,
    hasUncoveredPosition: false,
    hasUnprotectedPosition: false,
    drawdownPct: null,
    drawdownThresholdPct: -2,
  };
  const classify = (overrides: Partial<typeof quiet>) => classifyTickRun(buildTickRunInput({ ...quiet, ...overrides }));

  it('classifies a quiet later tick as routine', () => {
    expect(classify({})).toEqual({ importance: 'routine', reason: 'routine_tick' });
  });

  it('classifies a reminder wake as work, so a continued job search runs at the user level', () => {
    expect(classify({ reminderScheduledBy: 'judge' })).toEqual({ importance: 'important', reason: 'work_wake' });
    expect(resolveRunReasoning(classify({ reminderScheduledBy: 'scout' }), 'medium', true).level).toBe('medium');
  });

  it('classifies the first run and a resumed full evaluation as first_run', () => {
    expect(classify({ firstModelRun: true })).toEqual({ importance: 'important', reason: 'first_run' });
    expect(classify({ isResumedFullEvaluation: true })).toEqual({ importance: 'important', reason: 'first_run' });
  });

  it('classifies a market wake as important', () => {
    expect(classify({ marketWakeReceived: true })).toEqual({ importance: 'important', reason: 'market_wake' });
  });

  it('classifies each protection gap as important, even with open positions', () => {
    for (const gap of ['hasTriggeredWatch', 'hasUncoveredPosition', 'hasUnprotectedPosition'] as const) {
      expect(classify({ hasOpenPositions: true, [gap]: true }), gap).toEqual({ importance: 'important', reason: 'protection_gap' });
    }
  });

  it('keeps a fill or open position alone at lighter', () => {
    expect(classify({ hasOpenPositions: true })).toEqual({ importance: 'lighter', reason: 'open_positions' });
  });

  it('tells the owner\'s message from a peer\'s', () => {
    expect(classify({ incomingMessages: [{ type: 'agent.user.message', initiatorType: 'agent' }] }).reason).toBe('agent_message');
    expect(classify({ incomingMessages: [{ type: 'user.message', initiatorType: 'user' }] }).reason).toBe('user_message');
  });
});

describe('resolveJudgeRunClassification', () => {
  const routine = { importance: 'routine' as const, reason: 'routine_tick' as const };

  it('makes every run important for a premium judge, still capped at the user level', () => {
    const judge = resolveJudgeRunClassification(routine, true);
    expect(judge).toEqual({ importance: 'important', reason: 'cost_profile_premium' });
    expect(resolveRunReasoning(judge, 'low', true)).toEqual({ level: 'low', reason: 'cost_profile_premium', ceiling: 'low', adaptive: true });
  });

  it('uses the shared classification otherwise', () => {
    expect(resolveJudgeRunClassification(routine, false)).toBe(routine);
  });
});
