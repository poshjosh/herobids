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

    // c4.9i: the Traderton boundary is the sole source; the boundary returns the
    // same analytics `data` shape this tool used to build. Fail-closed when the
    // boundary is absent (the dead in-process botRepo read was removed).
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'trading boundary not configured', errorCode: 'precondition.not_ready', fault: false };
    }

    const result = await ctx.tradertonBoundary.invoke({ toolName: 'get_analytics', payload: { days } });
    return mapReadResultToToolResult(result);
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
    // c4.9i: the Traderton boundary is the sole source. Fail-closed when the
    // boundary is absent (the dead in-process botRepo read was removed).
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'trading boundary not configured', errorCode: 'precondition.not_ready', fault: false };
    }

    const result = await ctx.tradertonBoundary.invoke({ toolName: 'list_positions', payload: {} });
    return mapReadResultToToolResult(result);
  },
};

export const analyticsTools: AgentTool<TradingToolContext>[] = [
  getAnalyticsTool,
  listPositionsTool,
];
