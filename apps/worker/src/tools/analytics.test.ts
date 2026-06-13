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
  it('returns list_positions output with explicit ownership for bot-backed positions', async () => {
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
            actorType: 'bot',
            actorId: 'bot-1',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1',
            entryPrice: '50000',
            openedAt: new Date('2026-06-09T00:00:00.000Z'),
          },
          {
            actorType: 'bot',
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
          actorType: 'bot',
          actorId: 'bot-1',
          botId: 'bot-1',
          instrumentId: 'BTC/USD:USD',
          side: 'long',
          size: '1',
          entryPrice: '50000',
          openedAt: '2026-06-09T00:00:00.000Z',
        },
        {
          actorType: 'bot',
          actorId: 'bot-2',
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

  it('returns list_positions output for direct agent-owned positions without mislabelling them as bots', async () => {
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
            actorType: 'agent',
            actorId: 'agent-1',
            symbol: 'SOL',
            side: 'long',
            size: '50',
            entryPrice: '67.917',
            openedAt: new Date('2026-06-13T12:55:00.000Z'),
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
          actorType: 'agent',
          actorId: 'agent-1',
          botId: null,
          instrumentId: 'SOL',
          side: 'long',
          size: '50',
          entryPrice: '67.917',
          openedAt: '2026-06-13T12:55:00.000Z',
        },
      ],
    });
  });

  it('get_analytics includes agentDirect bucket alongside byBot', async () => {
    const getAnalyticsTool = analyticsTools.find((tool) => tool.name === 'get_analytics');
    expect(getAnalyticsTool).toBeDefined();

    const result = await getAnalyticsTool!.execute({ days: 7 }, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getOpenPositionsByCreator: vi.fn(),
        getAnalyticsByCreator: vi.fn(async () => ({
          botCount: 1,
          openPositions: 2,
          closedPositions: 3,
          winningPositions: 2,
          realizedPnlUsd: '45.00',
          totalFeesUsd: '2.10',
          recentFills: 8,
          avgHoldTimeHours: 4.5,
          byBot: [{ botId: 'bot-1', status: 'running', recentFills: 5, realizedPnlUsd: '30.00' }],
          agentDirect: { recentFills: 3, realizedPnlUsd: '15.00' },
        })),
      },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['totalTrades']).toBe(8);
    expect(data['realizedPnlUsd']).toBe('45.00');
    expect(data['botCount']).toBe(1);
    expect(data['byBot']).toEqual([{ botId: 'bot-1', status: 'running', recentFills: 5, realizedPnlUsd: '30.00' }]);
    expect(data['agentDirect']).toEqual({ recentFills: 3, realizedPnlUsd: '15.00' });
  });

  it('get_analytics returns a zeroed agentDirect bucket when no agent-direct trades exist', async () => {
    const getAnalyticsTool = analyticsTools.find((tool) => tool.name === 'get_analytics');
    expect(getAnalyticsTool).toBeDefined();

    const result = await getAnalyticsTool!.execute({ days: 7 }, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getOpenPositionsByCreator: vi.fn(),
        getAnalyticsByCreator: vi.fn(async () => ({
          botCount: 0,
          openPositions: 0,
          closedPositions: 0,
          winningPositions: 0,
          realizedPnlUsd: '0',
          totalFeesUsd: '0',
          recentFills: 0,
          avgHoldTimeHours: null,
          byBot: [],
          agentDirect: { recentFills: 0, realizedPnlUsd: '0.00' },
        })),
      },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['agentDirect']).toEqual({ recentFills: 0, realizedPnlUsd: '0.00' });
    expect(data['botCount']).toBe(0);
  });
});