import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';

// --- search_tokens ---

const SearchTokensParamsSchema = z.object({
  query: z.string().min(1).describe('Token name or symbol to search for (e.g. "BONK", "jupiter")'),
  network: z.string().optional().describe('Filter by blockchain network (e.g. "solana", "ethereum")'),
  // coerce: LLMs may send numbers as strings
  minLiquidityUsd: z.coerce.number().positive().optional().describe('Minimum liquidity in USD to include a token'),
  minVolume24hUsd: z.coerce.number().positive().optional().describe('Minimum 24h volume in USD'),
  minTokenAgeHours: z.coerce.number().positive().optional().describe('Minimum token age in hours. Tokens with unknown age pass through.'),
  includeBlocked: z.boolean().optional().describe('Include tokens flagged by safety policies. Default false.'),
  // coerce: LLMs may send numbers as strings
  limit: z.coerce.number().int().positive().max(50).optional().describe('Maximum number of results to return (1-50)'),
});

const searchTokensTool: AgentTool<TradingToolContext> = {
  name: 'search_tokens',
  description: 'Search for tokens by name or symbol on DEX aggregators. Returns token details including liquidity, price, safety metadata, and network. Age filtering (minTokenAgeHours) only blocks tokens with known creation time below the threshold; tokens with unavailable age data pass through with safety metadata noting the gap.',
  parametersSchema: SearchTokensParamsSchema,
  parameters: convertZodToJsonSchema(SearchTokensParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { query, network, minLiquidityUsd, minVolume24hUsd, minTokenAgeHours, includeBlocked, limit } = params as z.infer<typeof SearchTokensParamsSchema>;

    // L3: route the read over the Traderton boundary. When the boundary is
    // absent the tool degrades (fail-closed) — there is no in-process path.
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'market_data_not_configured', retryable: false };
    }

    return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
      toolName: 'search_tokens',
      payload: { query, network, minLiquidityUsd, minVolume24hUsd, minTokenAgeHours, includeBlocked, limit },
    }));
  },
};

// --- discover_tokens ---

const DiscoverTokensParamsSchema = z.object({
  network: z.string().optional().describe('Filter discovery to a specific network (e.g. "solana")'),
  // coerce: LLMs may send numbers as strings
  limit: z.coerce.number().int().positive().max(100).optional().describe('Maximum number of tokens to return (1-100)'),
  minLiquidityUsd: z.coerce.number().positive().optional().describe('Minimum liquidity in USD'),
});

const discoverTokensTool: AgentTool<TradingToolContext> = {
  name: 'discover_tokens',
  description: 'Discover trending or popular tokens from aggregated market data sources. Returns curated token lists with liquidity and momentum metrics.',
  parametersSchema: DiscoverTokensParamsSchema,
  parameters: convertZodToJsonSchema(DiscoverTokensParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { network, limit, minLiquidityUsd } = params as z.infer<typeof DiscoverTokensParamsSchema>;

    // L3: route the read over the Traderton boundary. When the boundary is
    // absent the tool degrades (fail-closed) — there is no in-process path.
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'market_data_not_configured', retryable: false };
    }

    return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
      toolName: 'discover_tokens',
      payload: { network, limit, minLiquidityUsd },
    }));
  },
};

// --- check_regime ---

// Inlined verbatim from CANDLE_PROVIDERS.binance.symbolFormatHint to keep trading
// market-data code out of the agent bundle (isolation; source string copied verbatim).
const REGIME_SYMBOL_FORMAT_HINT = "Base ticker (e.g. 'BTC', 'SOL')";

const CheckRegimeParamsSchema = z.object({
  benchmarkSymbol: z.string().optional().transform(v => v === '' ? undefined : v).describe(`Benchmark symbol for regime evaluation. ${REGIME_SYMBOL_FORMAT_HINT}. Defaults to "BTC".`),
  // coerce: LLMs may send numbers as strings
  emaFast: z.coerce.number().int().positive().optional().describe('Fast EMA period (default 20)'),
  emaSlow: z.coerce.number().int().positive().optional().describe('Slow EMA period (default 50)'),
  emaTrend: z.coerce.number().int().positive().optional().describe('Trend EMA period (default 200)'),
  adxMin: z.coerce.number().positive().optional().describe('Minimum ADX threshold to confirm trend (default 20)'),
  emaAlignment: z.enum(['bullish', 'bearish', 'any']).optional().describe('Required EMA alignment direction'),
  marketStructure: z.enum(['higherHighs', 'lowerHighs', 'any']).optional().describe('Required market structure pattern'),
  priceAboveVwap: z.boolean().optional().describe('Require price above VWAP'),
  disableWhenChoppy: z.boolean().optional().describe('Disable trading signal when ADX indicates chop'),
});

const checkRegimeTool: AgentTool<TradingToolContext> = {
  name: 'check_regime',
  description: 'Evaluate market regime for a benchmark symbol using EMA alignment, ADX, VWAP, and structure filters. Useful for context-aware strategy selection.',
  parametersSchema: CheckRegimeParamsSchema,
  parameters: convertZodToJsonSchema(CheckRegimeParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const {
      benchmarkSymbol, emaFast, emaSlow, emaTrend, adxMin, emaAlignment, marketStructure, priceAboveVwap, disableWhenChoppy,
    } = params as z.infer<typeof CheckRegimeParamsSchema>;

    // L3: route the read over the Traderton boundary. When the boundary is
    // absent the tool degrades (fail-closed) — there is no in-process path.
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'market_data_not_configured', retryable: false };
    }

    return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
      toolName: 'check_regime',
      payload: { benchmarkSymbol, emaFast, emaSlow, emaTrend, adxMin, emaAlignment, marketStructure, priceAboveVwap, disableWhenChoppy },
    }));
  },
};

// --- get_funding_rates ---

const GetFundingRatesParamsSchema = z.object({
  symbols: z.array(z.string().min(1)).optional().describe('List of base tickers to fetch funding for (e.g. ["BTC", "ETH"]). Omit for all.'),
  venue: z.string().optional().describe('Venue to query (e.g. "hyperliquid"). Defaults to primary venue.'),
});

const getFundingRatesTool: AgentTool<TradingToolContext> = {
  name: 'get_funding_rates',
  description: 'Get current funding rates for perpetual contracts. Useful for identifying funding arbitrage opportunities or market sentiment.',
  parametersSchema: GetFundingRatesParamsSchema,
  parameters: convertZodToJsonSchema(GetFundingRatesParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { symbols, venue } = params as z.infer<typeof GetFundingRatesParamsSchema>;

    // L3: route the read over the Traderton boundary. When the boundary is
    // absent the tool degrades (fail-closed) — there is no in-process path.
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'market_data_not_configured', retryable: false };
    }

    return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
      toolName: 'get_funding_rates',
      payload: { symbols, venue },
    }));
  },
};

// --- get_market_overview ---

const GetMarketOverviewParamsSchema = z.object({
  venue: z.string().optional().describe('Venue to query (e.g. "hyperliquid"). Defaults to primary venue.'),
  symbols: z.array(z.string().min(1)).optional().describe('Specific symbols to include in overview. Omit for broad market.'),
});

const getMarketOverviewTool: AgentTool<TradingToolContext> = {
  name: 'get_market_overview',
  description: 'Get aggregated market overview including top movers, volume leaders, and market breadth metrics. Useful for broad market context.',
  parametersSchema: GetMarketOverviewParamsSchema,
  parameters: convertZodToJsonSchema(GetMarketOverviewParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { venue, symbols } = params as z.infer<typeof GetMarketOverviewParamsSchema>;

    // L3: route the read over the Traderton boundary. When the boundary is
    // absent the tool degrades (fail-closed) — there is no in-process path.
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'market_data_not_configured', retryable: false };
    }

    return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
      toolName: 'get_market_overview',
      payload: { venue, symbols },
    }));
  },
};

export const marketDataTools: AgentTool<TradingToolContext>[] = [
  searchTokensTool,
  discoverTokensTool,
  checkRegimeTool,
  getFundingRatesTool,
  getMarketOverviewTool,
];
