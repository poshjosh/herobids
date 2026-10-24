import { describe, expect, it } from 'vitest';
import { AGENT_RUNTIME_ACTIVITY_TYPES } from '@herobids/domain';
import { CONVERSATION_TURN_STALE_MS, deriveSubjectTurnState, type TurnEventRow } from './agent-conversation-turn.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const at = (msBeforeNow: number) => new Date(NOW.getTime() - msBeforeNow);

function started(tickId: string, userMessageIds: string[], msBeforeNow = 1_000): TurnEventRow {
  return {
    type: AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED,
    payload: { tickId, userMessageIds, connectionRequestIds: [] },
    createdAt: at(msBeforeNow),
  };
}

function completed(tickId: string, outcome: string): TurnEventRow {
  return { type: AGENT_RUNTIME_ACTIVITY_TYPES.TICK_COMPLETED, payload: { tickId, outcome }, createdAt: at(500) };
}

function llmDispatched(tickId: string): TurnEventRow {
  return { type: AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH, payload: { tickId, phase: 'judge' }, createdAt: at(800) };
}

function skipped(tickId: string): TurnEventRow {
  return { type: AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED, payload: { tickId, reason: 'billing' }, createdAt: at(500) };
}

const derive = (subjectId: string | null, events: TurnEventRow[]) => deriveSubjectTurnState({
  subjectId,
  handledKey: 'userMessageIds',
  events,
  now: NOW,
});

describe('deriveSubjectTurnState', () => {
  it('reports no state when there is no subject', () => {
    expect(derive(null, [])).toBeNull();
  });

  it('reports queued while no tick has picked up the message', () => {
    expect(derive('msg-1', [started('tick-0', ['msg-0'])])).toBe('queued');
  });

  it('reports working from the tick start until the tick completes', () => {
    expect(derive('msg-1', [started('tick-1', ['msg-1'])])).toBe('working');
  });

  it('reports replied when the handling tick completed with a reply', () => {
    expect(derive('msg-1', [completed('tick-1', 'replied'), started('tick-1', ['msg-1'])])).toBe('replied');
  });

  it('reports no reply when the handling tick completed without messaging the user', () => {
    expect(derive('msg-1', [completed('tick-1', 'no_reply'), started('tick-1', ['msg-1'])])).toBe('no_reply');
  });

  it('reports failed when the handling tick errored', () => {
    expect(derive('msg-1', [completed('tick-1', 'failed'), started('tick-1', ['msg-1'])])).toBe('failed');
  });

  it('reports skipped when the handling tick was skipped without running the LLM', () => {
    expect(derive('msg-1', [completed('tick-1', 'no_reply'), skipped('tick-1'), started('tick-1', ['msg-1'])])).toBe('skipped');
  });

  it('reports the real outcome when a billing warning skip was followed by an LLM run', () => {
    const events = [completed('tick-1', 'no_reply'), llmDispatched('tick-1'), skipped('tick-1'), started('tick-1', ['msg-1'])];
    expect(derive('msg-1', events)).toBe('no_reply');
  });

  it('keeps reporting working while a skipped tick has not yet completed', () => {
    expect(derive('msg-1', [skipped('tick-1'), started('tick-1', ['msg-1'])])).toBe('working');
  });

  it('ignores completion and skip events from other ticks', () => {
    expect(derive('msg-1', [completed('tick-2', 'replied'), skipped('tick-3'), started('tick-1', ['msg-1'])])).toBe('working');
  });

  it('reports stale when a working tick has no completion for longer than the limit', () => {
    const old = started('tick-1', ['msg-1'], CONVERSATION_TURN_STALE_MS + 1_000);
    expect(derive('msg-1', [old])).toBe('stale');
  });

  it('matches connection requests against the connection id list instead of user messages', () => {
    const tick: TurnEventRow = {
      type: AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED,
      payload: { tickId: 'tick-9', userMessageIds: [], connectionRequestIds: ['req-1'] },
      createdAt: at(1_000),
    };
    expect(deriveSubjectTurnState({ subjectId: 'req-1', handledKey: 'connectionRequestIds', events: [tick], now: NOW })).toBe('working');
    expect(deriveSubjectTurnState({ subjectId: 'req-1', handledKey: 'userMessageIds', events: [tick], now: NOW })).toBe('queued');
  });
});
