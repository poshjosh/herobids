import { z } from 'zod';
import pino from 'pino';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { evaluateRegime, type TokenInfo, type RegimeParams, type ProviderRegistry, type PriceCandle } from '@herobids/market-data';
import {
  executeDiscoverTokensTool,
  executeFundingRatesTool,
  executeMarketOverviewTool,
} from '../intelligence-tools.js';
import { convertZodToJsonSchema } from './registry.js';

const logger = pino({ name: 'tools:market-data' });

async function enrichDiscoveryTokenPrices(
  tokens: Array<Record<string, unknown>>,
  priceService: ToolContext['priceService'],
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
  const priceResults = new Map<string, Awaited<ReturnType<NonNullable<ToolContext['priceService']>['getPrice']>>>();

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
    if (!result.ok || !result.data) {
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
  query: z.string().min(1),
  network: z.string().optional(),
  minLiquidityUsd: z.number().positive().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const searchTokensTool: AgentTool = {
  name: 'search_tokens',
  description: 'Search for tokens by name or symbol on DEX aggregators. Returns token details including liquidity, price, and network. Useful for token discovery and screening.',
  parametersSchema: SearchTokensParamsSchema,
  parameters: convertZodToJsonSchema(SearchTokensParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { query, network, minLiquidityUsd, limit } = params as z.infer<typeof SearchTokensParamsSchema>;

    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    try {
      ctx.recordMarketDataAttempt?.('dexscreener');
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
      return { success: false, error: message, retryable: false };
    }
  },
};

// --- discover_tokens ---

const DiscoverTokensParamsSchema = z.object({
  network: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  minLiquidityUsd: z.number().positive().optional(),
});

const discoverTokensTool: AgentTool = {
  name: 'discover_tokens',
  description: 'Discover trending or popular tokens from aggregated market data sources. Returns curated token lists with liquidity and momentum metrics.',
  parametersSchema: DiscoverTokensParamsSchema,
  parameters: convertZodToJsonSchema(DiscoverTokensParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
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
      return { success: false, error: message, retryable: false };
    }
  },
};

// --- check_regime ---

const CheckRegimeParamsSchema = z.object({
  benchmarkSymbol: z.string().min(1).optional(),
  emaFast: z.number().int().positive().optional(),
  emaSlow: z.number().int().positive().optional(),
  emaTrend: z.number().int().positive().optional(),
  adxMin: z.number().positive().optional(),
  emaAlignment: z.enum(['bullish', 'bearish', 'any']).optional(),
  marketStructure: z.enum(['higherHighs', 'lowerHighs', 'any']).optional(),
  priceAboveVwap: z.boolean().optional(),
  disableWhenChoppy: z.boolean().optional(),
});

const checkRegimeTool: AgentTool = {
  name: 'check_regime',
  description: 'Evaluate market regime for a benchmark symbol using EMA alignment, ADX, VWAP, and structure filters. Useful for context-aware strategy selection.',
  parametersSchema: CheckRegimeParamsSchema,
  parameters: convertZodToJsonSchema(CheckRegimeParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.marketDataRegistry) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    const regimeParams = params as RegimeParams;

    try {
      const result = await evaluateRegime(regimeParams, (symbol) => {
        ctx.recordMarketDataAttempt?.('binance');
        return ctx.marketDataRegistry!.binance.candles(symbol, { interval: '1h', limit: 200 })
          .then((response) => response.data as PriceCandle[]);
      });
      return { success: true, data: { ok: true, ...result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('Rate limit exceeded')) {
        ctx.recordMarketDataRejection?.('binance', { priority: 'execution' });
        return {
          success: false,
          error: 'rate_limit',
          retryable: true,
        };
      }
      logger.warn({ err, tool: 'check_regime' }, 'check_regime failed');
      return { success: false, error: message, retryable: false };
    }
  },
};

// --- get_funding_rates ---

const GetFundingRatesParamsSchema = z.object({
  symbols: z.array(z.string().min(1)).optional(),
  venue: z.string().optional(),
});

const getFundingRatesTool: AgentTool = {
  name: 'get_funding_rates',
  description: 'Get current funding rates for perpetual contracts. Useful for identifying funding arbitrage opportunities or market sentiment.',
  parametersSchema: GetFundingRatesParamsSchema,
  parameters: convertZodToJsonSchema(GetFundingRatesParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
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
      return { success: false, error: message, retryable: false };
    }
  },
};

// --- get_market_overview ---

const GetMarketOverviewParamsSchema = z.object({
  venue: z.string().optional(),
  symbols: z.array(z.string().min(1)).optional(),
});

const getMarketOverviewTool: AgentTool = {
  name: 'get_market_overview',
  description: 'Get aggregated market overview including top movers, volume leaders, and market breadth metrics. Useful for broad market context.',
  parametersSchema: GetMarketOverviewParamsSchema,
  parameters: convertZodToJsonSchema(GetMarketOverviewParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
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
      return { success: false, error: message, retryable: false };
    }
  },
};

export const marketDataTools: AgentTool[] = [
  searchTokensTool,
  discoverTokensTool,
  checkRegimeTool,
  getFundingRatesTool,
  getMarketOverviewTool,
];
