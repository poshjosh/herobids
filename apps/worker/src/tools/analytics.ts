import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- get_analytics ---

const GetAnalyticsParamsSchema = z.object({
  botId: z.string().min(1).optional(),
  days: z.number().int().positive().max(90).default(7),
});

const getAnalyticsTool: AgentTool = {
  name: 'get_analytics',
  description: 'Get trading analytics for bots created by this agent. Returns total trades, win rate, P&L, fees, and per-bot breakdown. Optionally filter by bot ID and lookback period (max 90 days).',
  parametersSchema: GetAnalyticsParamsSchema,
  parameters: convertZodToJsonSchema(GetAnalyticsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId, days } = params as z.infer<typeof GetAnalyticsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const analyticsSince = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const analytics = await ctx.botRepo.getAnalyticsByCreator('agent', ctx.agentId, analyticsSince, botId);

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

const ListPositionsParamsSchema = z.object({
  botId: z.string().min(1).optional(),
});

const listPositionsTool: AgentTool = {
  name: 'list_positions',
  description: 'List open positions for bots created by this agent. Returns instrument, side, size, entry price, and open timestamp. Optionally filter by bot ID. Note: unrealized P&L is not available in the agent process.',
  parametersSchema: ListPositionsParamsSchema,
  parameters: convertZodToJsonSchema(ListPositionsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof ListPositionsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const openPositions = await ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId, botId);

    return {
      success: true,
      data: {
        ok: true,
        note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
        positions: openPositions.map((p) => ({
          botId: p.actorId,
          instrumentId: p.symbol,
          side: p.side,
          size: p.size,
          entryPrice: p.entryPrice,
          openedAt: p.openedAt.toISOString(),
        })),
      },
    };
  },
};

export const analyticsTools: AgentTool[] = [
  getAnalyticsTool,
  listPositionsTool,
];
