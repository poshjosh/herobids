import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './external-backend-result.js';
import { resolveSelectedVenueAccountId, selectedAccountUnavailable } from './risk-limits.js';

// --- get_account_summary ---

const GetAccountSummaryParamsSchema = z.object({});

// Shared read path for account-scoped boundary reads: the platform attaches the
// selected venue account post-LLM; no ready account → typed precondition.
async function invokeSelectedAccountRead(ctx: TradingToolContext, toolName: string): Promise<ToolResult> {
  if (!ctx.externalBackend) {
    return {
      success: false,
      fault: false,
      error: 'trading boundary not configured',
      errorCode: 'precondition.not_ready',
    };
  }

  const resolution = await resolveSelectedVenueAccountId(ctx);
  if (resolution.status !== 'ready') return selectedAccountUnavailable(resolution);

  const result = await ctx.externalBackend.invoke({ toolName, payload: { venueAccountId: resolution.venueAccountId } });
  return mapReadResultToToolResult(result);
}

const getAccountSummaryTool: AgentTool<TradingToolContext> = {
  name: 'get_account_summary',
  description: 'Get a summary of the agent\'s trading account including usable capital, equity, open positions, P&L, and risk limits. Use this to compute appropriate position sizes (targetSize) before calling submit_decision, or to determine sizing for position sizing configuration.',
  parametersSchema: GetAccountSummaryParamsSchema,
  parameters: convertZodToJsonSchema(GetAccountSummaryParamsSchema),
  category: 'read-database',
  promptGuidance: 'Call get_account_summary before submit_decision to see available capital and open positions. targetSize is in base units — the amount of the asset being bought or sold. If capital is unavailable, omit targetSize to let the engine use a safe default.',
  // c4.9i: the Traderton boundary is the sole source; it returns the same
  // `data` shape this tool used to build locally.
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    return invokeSelectedAccountRead(ctx, 'get_account_summary');
  },
};

const GetFundingInfoParamsSchema = z.object({});

const getFundingInfoTool: AgentTool<TradingToolContext> = {
  name: 'get_funding_info',
  description: 'Get the trading wallet\'s funding address, network, and latest observed balance. Call it after the trading setup is created and before a go-live request, so you can tell the user whether the wallet is funded and where to send funds.',
  parametersSchema: GetFundingInfoParamsSchema,
  parameters: convertZodToJsonSchema(GetFundingInfoParamsSchema),
  category: 'read-database',
  promptGuidance: 'When fundingStatus is unfunded, give the user the fundingAddress and network. When it is unknown, say no balance has been observed yet; the balance appears once the agent trades.',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    return invokeSelectedAccountRead(ctx, 'get_funding_info');
  },
};

export const accountTools: AgentTool<TradingToolContext>[] = [getAccountSummaryTool, getFundingInfoTool];
