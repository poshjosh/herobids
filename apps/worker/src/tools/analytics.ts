import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- get_analytics ---

const GetAnalyticsParamsSchema = z.object({
  days: z.number().int().positive().max(90).default(7).describe('Lookback period in days (1-90). Defaults to 7.'),
});

const getAnalyticsTool: AgentTool = {
  name: 'get_analytics',
  description: 'Get trading analytics for all bots created by this agent. Returns total trades, win rate, P&L, fees, and per-bot breakdown over the specified lookback period.',
  parametersSchema: GetAnalyticsParamsSchema,
  parameters: convertZodToJsonSchema(GetAnalyticsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { days } = params as z.infer<typeof GetAnalyticsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const analyticsSince = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const analytics = await ctx.botRepo.getAnalyticsByCreator('agent', ctx.agentId, analyticsSince);

    const winRate = analytics.closedPositions > 0
      ? (analytics.winningPositions / analytics.closedPositions) * 100
      : 0;

    return {
      success: true,
      data: {
        ok: true,
        totalTrades: analytics.recentFills,
        winRate: Math.round(winRate * 100) / 100,
        totalPnlUsd: analytics.realizedPnlUsd,
        totalFeesUsd: analytics.totalFeesUsd,
        openPositions: analytics.openPositions,
        botCount: analytics.botCount,
        avgHoldTimeHours: analytics.avgHoldTimeHours,
        byBot: analytics.byBot,
        days,
      },
    };
  },
};

// --- list_positions ---

const ListPositionsParamsSchema = z.object({});

const listPositionsTool: AgentTool = {
  name: 'list_positions',
  description: 'List open positions for all bots created by this agent. Returns instrument, side, size, entry price, and open timestamp.',
  parametersSchema: ListPositionsParamsSchema,
  parameters: convertZodToJsonSchema(ListPositionsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const openPositions = await ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId);

    return {
      success: true,
      data: {
        ok: true,
        note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
        positions: openPositions.map((position) => ({
          botId: position.actorId,
          instrumentId: position.symbol,
          side: position.side,
          size: position.size,
          entryPrice: position.entryPrice,
          openedAt: position.openedAt.toISOString(),
        })),
      },
    };
  },
};

export const analyticsTools: AgentTool[] = [
  getAnalyticsTool,
  listPositionsTool,
];
