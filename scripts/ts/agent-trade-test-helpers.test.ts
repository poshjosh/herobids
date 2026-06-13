import { describe, expect, it } from 'vitest';
import {
  getToolResultPayload,
  selectListPositionsResult,
  type AgentActivityEntry,
} from './agent-trade-test-helpers.js';

function makeToolResultEntry(
  id: string,
  timestamp: string,
  payload: Record<string, unknown>,
): AgentActivityEntry {
  return {
    id,
    timestamp,
    eventType: 'tool.result',
    summary: 'tool result',
    detail: { payload },
  };
}

describe('getToolResultPayload', () => {
  it('extracts structured list_positions metadata from activity feed payloads', () => {
    const payload = getToolResultPayload(makeToolResultEntry('e1', '2026-06-13T12:00:00.000Z', {
      toolName: 'list_positions',
      status: 'ok',
      summary: '{"positions":[{"instrumentId":"BTC"}]}',
      metadata: {
        positionCount: 1,
        hasOpenPositions: true,
      },
    }));

    expect(payload).toEqual({
      toolName: 'list_positions',
      status: 'ok',
      summary: '{"positions":[{"instrumentId":"BTC"}]}',
      positionCount: 1,
      hasOpenPositions: true,
    });
  });
});

describe('selectListPositionsResult', () => {
  it('ignores pre-trade list_positions results and selects the earliest post-trade one from newest-first feed data', () => {
    const entries: AgentActivityEntry[] = [
      makeToolResultEntry('late-post', '2026-06-13T12:03:00.000Z', {
        toolName: 'list_positions',
        status: 'ok',
        metadata: {
          positionCount: 1,
          hasOpenPositions: true,
        },
      }),
      makeToolResultEntry('early-post', '2026-06-13T12:02:00.000Z', {
        toolName: 'list_positions',
        status: 'ok',
        metadata: {
          positionCount: 1,
          hasOpenPositions: true,
        },
      }),
      makeToolResultEntry('pre', '2026-06-13T12:00:00.000Z', {
        toolName: 'list_positions',
        status: 'ok',
        metadata: {
          positionCount: 0,
          hasOpenPositions: false,
        },
      }),
    ];

    const match = selectListPositionsResult(entries, '2026-06-13T12:01:00.000Z');

    expect(match?.id).toBe('early-post');
  });

  it('returns null when no qualifying post-trade list_positions result exists', () => {
    const entries: AgentActivityEntry[] = [
      makeToolResultEntry('pre', '2026-06-13T12:00:00.000Z', {
        toolName: 'list_positions',
        status: 'ok',
        metadata: {
          positionCount: 0,
          hasOpenPositions: false,
        },
      }),
      makeToolResultEntry('other', '2026-06-13T12:02:00.000Z', {
        toolName: 'get_analytics',
        status: 'ok',
      }),
    ];

    const match = selectListPositionsResult(entries, '2026-06-13T12:01:00.000Z');

    expect(match).toBeNull();
  });
});