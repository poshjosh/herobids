import { describe, expect, it } from 'vitest';
import type { ActivityEvent, AgentActivityEntry } from '../../lib/api-client.js';
import { mergeActivityFeedItems } from './activity-feed-items.js';

const baseAgentEntry: AgentActivityEntry = {
  id: 'agent-entry-1',
  agentId: 'agent-1',
  timestamp: '2026-06-11T12:00:00.000Z',
  category: 'runtime',
  severity: 'info',
  eventType: 'runtime.started',
  title: 'Session started',
  summary: 'Agent runtime launched.',
  detail: {},
  sessionId: null,
  direction: null,
  processingStatus: null,
  correlationId: null,
  traceId: null,
};

const baseBotEvent: ActivityEvent = {
  id: 'bot-event-1',
  botId: 'bot-1',
  instanceLabel: 'hyperliquid / main',
  type: 'order.filled',
  category: 'execution',
  severity: 'info',
  messageKey: 'activity.order.filled',
  timestamp: '2026-06-11T12:01:00.000Z',
  detail: {},
};

describe('mergeActivityFeedItems', () => {
  it('sorts agent and bot activity into one chronological list', () => {
    const items = mergeActivityFeedItems(
      [baseAgentEntry],
      [baseBotEvent],
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('bot');
    expect(items[1]?.kind).toBe('agent');
  });

  it('uses id as a stable tiebreaker when timestamps match', () => {
    const items = mergeActivityFeedItems(
      [{ ...baseAgentEntry, id: 'a-1', timestamp: '2026-06-11T12:00:00.000Z' }],
      [{ ...baseBotEvent, id: 'b-1', timestamp: '2026-06-11T12:00:00.000Z' }],
    );

    expect(items.map((item) => item.id)).toEqual(['b-1', 'a-1']);
  });
});