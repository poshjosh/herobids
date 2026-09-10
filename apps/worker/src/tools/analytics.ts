import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';

// --- get_analytics ---

const GetAnalyticsParamsSchema = z.object({
  // coerce: LLMs may send numbers as strings
  days: z.coerce.number().int().positive().max(90).default(7).describe('Lookback period in days (1-90). Defaults to 7.'),
});

const getAnalyticsTool: AgentTool<TradingToolContext> = {
  name: 'get_analytics',
  description: 'Get trading analytics for this agent, including both direct agent trades and all bot-created trades. Returns total trades, win rate, P&L, fees, per-bot breakdown, and an agent-direct summary over the specified lookback period.',
  parametersSchema: GetAnalyticsParamsSchema,
  parameters: convertZodToJsonSchema(GetAnalyticsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { days } = params as z.infer<typeof GetAnalyticsParamsSchema>;

    // L3b: route through the Traderton boundary when configured; the boundary
    // returns the same analytics `data` shape this tool used to build.
    if (ctx.tradertonBoundary) {
      const result = await ctx.tradertonBoundary.invoke({ toolName: 'get_analytics', payload: { days } });
      return mapReadResultToToolResult(result);
    }

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
        realizedPnlUsd: analytics.realizedPnlUsd,
        totalFeesUsd: analytics.totalFeesUsd,
        openPositions: analytics.openPositions,
        botCount: analytics.botCount,
        avgHoldTimeHours: analytics.avgHoldTimeHours,
        byBot: analytics.byBot,
        agentDirect: analytics.agentDirect,
        days,
      },
    };
  },
};

// --- list_positions ---

const ListPositionsParamsSchema = z.object({});

const listPositionsTool: AgentTool<TradingToolContext> = {
  name: 'list_positions',
  description: 'List open positions owned by this agent, including bot-created and direct agent positions. Returns ownership, instrument, side, size, entry price, and open timestamp.',
  parametersSchema: ListPositionsParamsSchema,
  parameters: convertZodToJsonSchema(ListPositionsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    // L3b: route through the Traderton boundary when configured.
    if (ctx.tradertonBoundary) {
      const result = await ctx.tradertonBoundary.invoke({ toolName: 'list_positions', payload: {} });
      return mapReadResultToToolResult(result);
    }

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
          actorType: position.actorType,
          actorId: position.actorId,
          botId: position.actorType === 'bot' ? position.actorId : null,
          symbol: position.symbol,
          instrumentId: position.instrumentId ?? null,
          venue: position.venue,
          side: position.side,
          size: position.size,
          entryPrice: position.entryPrice,
          stopLoss: position.stopLoss ?? null,
          takeProfit: position.takeProfit ?? null,
          openedAt: position.openedAt.toISOString(),
        })),
      },
    };
  },
};

export const analyticsTools: AgentTool<TradingToolContext>[] = [
  getAnalyticsTool,
  listPositionsTool,
];
