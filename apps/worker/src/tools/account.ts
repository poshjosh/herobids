import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';

// --- get_account_summary ---

const GetAccountSummaryParamsSchema = z.object({});

const getAccountSummaryTool: AgentTool<TradingToolContext> = {
  name: 'get_account_summary',
  description: 'Get a summary of the agent\'s trading account including usable capital, equity, open positions, P&L, and risk limits. Use this to compute appropriate position sizes (targetSize) before calling submit_decision, or to determine sizing for position sizing configuration.',
  parametersSchema: GetAccountSummaryParamsSchema,
  parameters: convertZodToJsonSchema(GetAccountSummaryParamsSchema),
  category: 'read-database',
  promptGuidance: 'Call get_account_summary before submit_decision to see available capital and open positions. targetSize is in base units — the amount of the asset being bought or sold. If capital is unavailable, omit targetSize to let the engine use a safe default.',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    // c4.9i: the Traderton boundary is the sole source; it returns the same
    // `data` shape this tool used to build locally. Fail-closed when the
    // boundary is absent (the dead in-process botRepo read was removed).
    if (!ctx.tradertonBoundary) {
      return {
        success: false,
        fault: false,
        error: 'trading boundary not configured',
        errorCode: 'precondition.not_ready',
      };
    }

    const result = await ctx.tradertonBoundary.invoke({ toolName: 'get_account_summary', payload: {} });
    return mapReadResultToToolResult(result);
  },
};

export const accountTools: AgentTool<TradingToolContext>[] = [getAccountSummaryTool];
