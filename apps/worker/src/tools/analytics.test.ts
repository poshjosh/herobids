import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { analyticsTools } from './analytics.js';

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('analyticsTools', () => {
  it('returns list_positions output with bot ids from the tool repository contract', async () => {
    const listPositionsTool = analyticsTools.find((tool) => tool.name === 'list_positions');
    expect(listPositionsTool).toBeDefined();

    const result = await listPositionsTool!.execute({}, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getAnalyticsByCreator: vi.fn(),
        getOpenPositionsByCreator: vi.fn(async () => [
          {
            actorId: 'bot-1',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1',
            entryPrice: '50000',
            openedAt: new Date('2026-06-09T00:00:00.000Z'),
          },
          {
            actorId: 'bot-2',
            symbol: 'ETH/USD:USD',
            side: 'long',
            size: '2',
            entryPrice: '3000',
            openedAt: new Date('2026-06-09T01:00:00.000Z'),
          },
        ]),
      },
    }));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: true,
      note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
      positions: [
        {
          botId: 'bot-1',
          instrumentId: 'BTC/USD:USD',
          side: 'long',
          size: '1',
          entryPrice: '50000',
          openedAt: '2026-06-09T00:00:00.000Z',
        },
        {
          botId: 'bot-2',
          instrumentId: 'ETH/USD:USD',
          side: 'long',
          size: '2',
          entryPrice: '3000',
          openedAt: '2026-06-09T01:00:00.000Z',
        },
      ],
    });
  });
});