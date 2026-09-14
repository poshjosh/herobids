import { z } from 'zod';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import {
  evaluateRegime,
  applyTokenSearchPolicy,
  CANDLE_PROVIDERS,
  type TokenInfo,
  type RegimeParams,
  type ProviderRegistry,
  type MarketDataConfig,
} from '@herobids/market-data';
import {
  executeDiscoverTokensTool,
  executeFundingRatesTool,
  executeMarketOverviewTool,
} from '../intelligence-tools.js';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';

const logger = createLogger('tools:market-data');

async function enrichDiscoveryTokenPrices(
  tokens: Array<Record<string, unknown>>,
  priceService: TradingToolContext['priceService'],
): Promise<Array<Record<string, unknown>>> {
  if (!priceService || tokens.length === 0) {
    return tokens;
  }

  const symbolNetworkCounts = new Map<string, number>();
  for (const token of tokens) {
    const symbol = typeof token['symbol'] === 'string' ? token['symbol'] : null;
    const chain = typeof token['network'] === 'string' ? token['network'] : null;
    if (!symbol || !chain) {
      continue;
    }

    const key = `${chain.toLowerCase()}:${symbol.toUpperCase()}`;
    symbolNetworkCounts.set(key, (symbolNetworkCounts.get(key) ?? 0) + 1);
  }

  const uniqueLookupKeys = new Set<string>();
  const priceResults = new Map<string, Awaited<ReturnType<NonNullable<TradingToolContext['priceService']>['getPrice']>>>();

  for (const token of tokens) {
    const symbol = typeof token['symbol'] === 'string' ? token['symbol'] : null;
    const chain = typeof token['network'] === 'string' ? token['network'] : null;
    if (!symbol || !chain) {
      continue;
    }

    const key = `${chain.toLowerCase()}:${symbol.toUpperCase()}`;
    if ((symbolNetworkCounts.get(key) ?? 0) !== 1 || uniqueLookupKeys.has(key)) {
      continue;
    }

    uniqueLookupKeys.add(key);
    const address = typeof token['address'] === 'string' ? token['address'] : undefined;
    priceResults.set(key, await priceService.getPrice(symbol, chain, address));
  }

  return Promise.all(tokens.map(async (token) => {
    const symbol = typeof token['symbol'] === 'string' ? token['symbol'] : null;
    const chain = typeof token['network'] === 'string' ? token['network'] : null;
    if (!symbol || !chain) {
      return token;
    }

    const key = `${chain.toLowerCase()}:${symbol.toUpperCase()}`;
    if ((symbolNetworkCounts.get(key) ?? 0) !== 1) {
      return token;
    }

    const result = priceResults.get(key);
    if (!result || !result.ok || !result.data) {
      return token;
    }

    return {
      ...token,
      priceUsd: result.data.priceUsd,
      priceSource: result.data.source,
      priceFetchedAt: result.data.fetchedAt,
      priceStale: result.data.stale,
    };
  }));
}

/** @deprecated Use searchTokensWithPolicy through the provider registry facade instead. Kept as fallback. */
function filterSearchResults(
  rawResults: TokenInfo[],
  options?: { network?: string; minLiquidityUsd?: number; limit?: number },
) {
  const minLiquidityUsd = options?.minLiquidityUsd ?? 10_000;
  const limit = options?.limit ?? 10;
  const network = options?.network?.toLowerCase();
  const filtered = rawResults
    .filter((token: TokenInfo) => token.liquidityUsd >= minLiquidityUsd)
    .filter((token: TokenInfo) => !network || token.network.toLowerCase() === network)
    .sort((left: TokenInfo, right: TokenInfo) => right.liquidityUsd - left.liquidityUsd);

  const deduped: typeof filtered = [];
  const seen = new Set<string>();
  for (const token of filtered) {
    const key = `${token.network}:${token.address}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(token);
  }

  return deduped.slice(0, limit);
}

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

    // L3: route the read over the Traderton boundary when present; in-process fetch below is the transitional fallback.
    if (ctx.tradertonBoundary) {
      return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
        toolName: 'search_tokens',
        payload: { query, network, minLiquidityUsd, minVolume24hUsd, minTokenAgeHours, includeBlocked, limit },
      }));
    }

    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    try {
      ctx.recordMarketDataAttempt?.('dexscreener');

      // Use shared token policy when marketDataConfig is available
      if (ctx.marketDataConfig) {
        const searchResult = await ctx.marketDataRegistry.dexscreener.search(query);
        const candidates = applyTokenSearchPolicy(
          searchResult.data as TokenInfo[],
          ctx.marketDataConfig as unknown as MarketDataConfig,
          { network, minLiquidityUsd, minVolume24hUsd, minTokenAgeHours, includeBlocked, limit },
        );
        return {
          success: true,
          data: { ok: true, tokens: candidates, freshness: searchResult.meta.freshness },
        };
      }

      // Fallback to legacy filtering when no config available
      const searchResult = await ctx.marketDataRegistry.dexscreener.search(query);
      const results = filterSearchResults(searchResult.data as TokenInfo[], {
        network,
        minLiquidityUsd,
        limit,
      });

      return {
        success: true,
        data: { ok: true, tokens: results, freshness: searchResult.meta.freshness },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('Rate limit exceeded')) {
        ctx.recordMarketDataRejection?.('dexscreener', { priority: 'discovery' });
        return {
          success: false,
          error: 'rate_limit',
          retryable: true,
        };
      }
      logger.warn({ err, tool: 'search_tokens' }, 'search_tokens failed');
      return { success: false, error: message, retryable: false, fault: false };
    }
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

    // L3: route the read over the Traderton boundary when present; in-process fetch below is the transitional fallback.
    if (ctx.tradertonBoundary) {
      return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
        toolName: 'discover_tokens',
        payload: { network, limit, minLiquidityUsd },
      }));
    }

    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    try {
      const result = await executeDiscoverTokensTool(
        ctx.marketDataRegistry as unknown as ProviderRegistry,
        params as z.infer<typeof DiscoverTokensParamsSchema>,
        { onAttempt: ctx.recordMarketDataAttempt ?? (() => {}) },
      );
      const tokens = Array.isArray(result['tokens'])
        ? await enrichDiscoveryTokenPrices(result['tokens'] as Array<Record<string, unknown>>, ctx.priceService)
        : result['tokens'];

      return { success: true, data: { ...result, tokens } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('Rate limit exceeded')) {
        ctx.recordMarketDataRejection?.('aggregated-discovery', { priority: 'discovery' });
        return {
          success: false,
          error: 'rate_limit',
          retryable: true,
        };
      }
      logger.warn({ err, tool: 'discover_tokens' }, 'discover_tokens failed');
      return { success: false, error: message, retryable: false, fault: false };
    }
  },
};

// --- check_regime ---

const regimeCandleProvider = CANDLE_PROVIDERS.binance;

const CheckRegimeParamsSchema = z.object({
  benchmarkSymbol: z.string().optional().transform(v => v === '' ? undefined : v).describe(`Benchmark symbol for regime evaluation. ${regimeCandleProvider.symbolFormatHint}. Defaults to "BTC".`),
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

    // L3: route the read over the Traderton boundary when present; in-process fetch below is the transitional fallback.
    if (ctx.tradertonBoundary) {
      return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
        toolName: 'check_regime',
        payload: { benchmarkSymbol, emaFast, emaSlow, emaTrend, adxMin, emaAlignment, marketStructure, priceAboveVwap, disableWhenChoppy },
      }));
    }

    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    const regimeParams = params as RegimeParams;

    try {
      const result = await evaluateRegime(regimeParams, async (symbol) => {
        ctx.recordMarketDataAttempt?.(regimeCandleProvider.id);
        try {
          return await regimeCandleProvider.fetchCandles(ctx.marketDataRegistry!, symbol, {
            interval: '1h',
            limit: 200,
          });
        } catch (fetchErr: unknown) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (msg.includes('400') || msg.includes('status 400') || msg.includes('Bad Request')) {
            throw new Error(
              `Symbol not available on ${regimeCandleProvider.id}: "${symbol}". ` +
              `Use a major benchmark like BTC, ETH, or SOL for regime evaluation.`,
            );
          }
          throw fetchErr;
        }
      });
      return { success: true, data: { ok: true, ...result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('Rate limit exceeded')) {
        ctx.recordMarketDataRejection?.(regimeCandleProvider.id, { priority: 'execution' });
        return {
          success: false,
          error: 'rate_limit',
          retryable: true,
        };
      }
      logger.warn({ err, tool: 'check_regime' }, 'check_regime failed');
      return { success: false, error: message, retryable: false, fault: false };
    }
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

    // L3: route the read over the Traderton boundary when present; in-process fetch below is the transitional fallback.
    if (ctx.tradertonBoundary) {
      return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
        toolName: 'get_funding_rates',
        payload: { symbols, venue },
      }));
    }

    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    try {
      const result = await executeFundingRatesTool(
        ctx.marketDataRegistry as unknown as ProviderRegistry,
        params as z.infer<typeof GetFundingRatesParamsSchema>,
        { onAttempt: ctx.recordMarketDataAttempt ?? (() => {}) },
      );
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn({ err, tool: 'get_funding_rates' }, 'get_funding_rates failed');
      return { success: false, error: message, retryable: false, fault: false };
    }
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

    // L3: route the read over the Traderton boundary when present; in-process fetch below is the transitional fallback.
    if (ctx.tradertonBoundary) {
      return mapReadResultToToolResult(await ctx.tradertonBoundary.invoke({
        toolName: 'get_market_overview',
        payload: { venue, symbols },
      }));
    }

    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    try {
      const result = await executeMarketOverviewTool(
        ctx.marketDataRegistry as unknown as ProviderRegistry,
        params as z.infer<typeof GetMarketOverviewParamsSchema>,
        { onAttempt: ctx.recordMarketDataAttempt ?? (() => {}) },
      );
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn({ err, tool: 'get_market_overview' }, 'get_market_overview failed');
      return { success: false, error: message, retryable: false, fault: false };
    }
  },
};

export const marketDataTools: AgentTool<TradingToolContext>[] = [
  searchTokensTool,
  discoverTokensTool,
  checkRegimeTool,
  getFundingRatesTool,
  getMarketOverviewTool,
];
