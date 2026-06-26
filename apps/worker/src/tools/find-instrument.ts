import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- find_instrument ---

const FindInstrumentParamsSchema = z.object({
  query: z.string().min(1).describe('Instrument symbol or name to search for (e.g. "BTC", "SOL/USDC", "ETH-USD")'),
  venue: z.string().optional().describe('Filter by venue (e.g. "hyperliquid", "jupiter"). If omitted, searches all venues.'),
  limit: z.number().int().positive().max(20).optional().describe('Maximum results (1-20, default 5)'),
});

const findInstrumentTool: AgentTool = {
  name: 'find_instrument',
  description: 'Find a tradable instrument by symbol or name. Returns instrumentId, symbol, decimals, and venue. Use this to resolve an instrumentId before calling submit_decision, get_price, watch_token, or create_bot. To narrow by chain, use the venue filter (e.g. venue="jupiter" for Solana, venue="hyperliquid" for Arbitrum perps). Prefer this over guessing instrument IDs.',
  parametersSchema: FindInstrumentParamsSchema,
  parameters: convertZodToJsonSchema(FindInstrumentParamsSchema),
  category: 'read-database',
  promptGuidance: 'Call find_instrument before submit_decision to resolve the correct instrumentId. For swap venues, instrument IDs use pair format (e.g. "WETH/USDC"), not bare symbols. Tokens must be native to the venue\'s chain. Search by base token symbol, pair, or full symbol. Use venue="jupiter" for Solana tokens or venue="hyperliquid" for perpetuals.',  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { query, venue, limit = 5 } = params as z.infer<typeof FindInstrumentParamsSchema>;

    if (!ctx.instrumentRepo) {
      return {
        success: false,
        fault: false,
        error: 'Instrument lookup not available in this context. Use search_tokens or discover_tokens as a fallback, then use the token symbol as the instrumentId.',
        errorCode: 'instrument.repo_unavailable',
      };
    }

    try {
      const results = await ctx.instrumentRepo.search({
        query,
        venue,
        limit,
      });

      if (results.length === 0) {
        return {
          success: false,
          fault: false,
          error: `No instruments found for query "${query}". Try a different symbol, use search_tokens to discover tokens, or check the venue.`,
          errorCode: 'instrument.not_found',
          data: { query, venue, suggestion: 'Use search_tokens or discover_tokens to find available tokens.' },
        };
      }

      return {
        success: true,
        data: {
          ok: true,
          query,
          count: results.length,
          instruments: results.map((r) => ({
            instrumentId: r.id,
            symbol: r.symbol,
            base: r.base,
            quote: r.quote,
            type: r.type,
            venue: r.venue,
            tickSize: r.tickSize,
            lotSize: r.lotSize,
          })),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: false,
        error: `Instrument lookup failed: ${message}`,
        errorCode: 'instrument.lookup_failed',
      };
    }
  },
};

export const instrumentTools: AgentTool[] = [findInstrumentTool];
