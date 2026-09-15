import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';

// --- find_instrument ---

const FindInstrumentParamsSchema = z.object({
  query: z.string().min(1).describe('Instrument symbol or name to search for (e.g. "BTC", "SOL/USDC", "ETH-USD")'),
  venue: z.string().optional().describe('Filter by venue (e.g. "hyperliquid", "jupiter"). If omitted, searches all venues.'),
  // coerce: LLMs may send numbers as strings
  limit: z.coerce.number().int().positive().max(20).optional().describe('Maximum results (1-20, default 5)'),
});

const findInstrumentTool: AgentTool<TradingToolContext> = {
  name: 'find_instrument',
  description: 'Find a tradable instrument by symbol or name. Returns instrumentId (venue-submittable — base ticker for perps, pair symbol for swaps), id (internal DB identifier), symbol, base, quote, type, and venue. Use this to resolve the correct instrumentId before calling submit_decision. Also useful before get_price and watch_token (use the symbol or base field) and create_bot (use the symbol field). To narrow by chain, use the venue filter (e.g. venue="jupiter" for Solana, venue="hyperliquid" for Arbitrum perps). Prefer this over guessing instrument IDs.',
  parametersSchema: FindInstrumentParamsSchema,
  parameters: convertZodToJsonSchema(FindInstrumentParamsSchema),
  category: 'read-database',
  promptGuidance: 'Call find_instrument before submit_decision to resolve the correct instrumentId. The returned instrumentId is already venue-correct: use it directly in submit_decision. For perp venues the instrumentId is the base ticker (e.g. "ZEC"); for swap venues it is the pair symbol (e.g. "SOL/USDC"). Tokens must be native to the venue\'s chain. Search by base token symbol, pair, or full symbol. Use venue="jupiter" for Solana tokens or venue="hyperliquid" for perpetuals.',  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { query, venue, limit = 5 } = params as z.infer<typeof FindInstrumentParamsSchema>;

    // Route the read over the Traderton boundary — the local instruments table
    // is owned by Traderton (legal-isolation). The boundary's find_instrument
    // returns the identical success shape ({ ok, query, count, instruments })
    // and its own typed not-found, so the payload flows through unchanged.
    // When the boundary is absent the tool fails closed — there is NO in-process
    // fallback (a local instruments read is forbidden), mirroring the other
    // mandatory-boundary reads.
    if (!ctx.tradertonBoundary) {
      return {
        success: false,
        fault: false,
        error: 'Instrument lookup not available in this context. Use search_tokens or discover_tokens as a fallback, then use the token symbol as the instrumentId.',
        errorCode: 'instrument.repo_unavailable',
      };
    }

    return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
      toolName: 'find_instrument',
      payload: { query, venue, limit },
    }));
  },
};

export const instrumentTools: AgentTool<TradingToolContext>[] = [findInstrumentTool];
