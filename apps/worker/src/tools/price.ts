import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';

// Supported chain identifiers for the price tool.
// 'hyperliquid' routes to the execution (mark) price source.
// All others route to the oracle (DexScreener) source.
export const SUPPORTED_CHAINS = [
  'hyperliquid',
  'solana',
  'ethereum',
  'bsc',
  'base',
  'arbitrum',
  'polygon',
  'avalanche',
  'any',
] as const;

type SupportedChain = typeof SUPPORTED_CHAINS[number];

export const EXPLICIT_SUPPORTED_CHAINS = [
  'hyperliquid',
  'solana',
  'ethereum',
  'bsc',
  'base',
  'arbitrum',
  'polygon',
  'avalanche',
] as const;

const EVM_CHAINS = new Set<SupportedChain>(['ethereum', 'bsc', 'base', 'arbitrum', 'polygon', 'avalanche']);
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const BASE58_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Detect whether a symbol string is actually an on-chain address.
 * When true, the symbol should be forwarded as the `address` argument
 * to the price service so it performs an identity-aware lookup.
 */
export function isOnChainAddress(symbol: string, chain: string): boolean {
  const chainLower = chain.toLowerCase();
  if (chainLower === 'hyperliquid') return false;
  if (EVM_ADDRESS_REGEX.test(symbol)) return true;
  if (chainLower === 'solana' && BASE58_ADDRESS_REGEX.test(symbol)) return true;
  return false;
}

export function validateSymbolForChain(symbol: string, chain: string): string | null {
  const trimmedSymbol = symbol.trim();
  const normalizedChain = chain.trim().toLowerCase() as SupportedChain | string;

  if (!trimmedSymbol) {
    return 'symbol is required';
  }

  if (normalizedChain === 'any') {
    if (EVM_ADDRESS_REGEX.test(trimmedSymbol) || BASE58_ADDRESS_REGEX.test(trimmedSymbol)) {
      return 'when using chain "any", provide a ticker symbol instead of an on-chain address — addresses require an explicit chain to avoid cross-chain ambiguity';
    }
    return null;
  }

  if (normalizedChain === 'hyperliquid') {
    if (EVM_ADDRESS_REGEX.test(trimmedSymbol) || BASE58_ADDRESS_REGEX.test(trimmedSymbol)) {
      return 'hyperliquid lookups require a perp ticker such as BTC or BTC-PERP, not an on-chain address';
    }
    return null;
  }

  if (normalizedChain === 'solana') {
    if (EVM_ADDRESS_REGEX.test(trimmedSymbol)) {
      return 'solana lookups require a Solana ticker or mint, not an EVM address';
    }
    return null;
  }

  if (EVM_CHAINS.has(normalizedChain as SupportedChain) && BASE58_ADDRESS_REGEX.test(trimmedSymbol)) {
    return `${normalizedChain} lookups require a ticker or 0x token address, not a Solana mint`; 
  }

  return null;
}

const GetPriceParamsSchema = z.object({
  symbol: z.string().min(1).describe('Token symbol or ticker (e.g. BTC, SOL, WIF)'),
  chain: z.enum(SUPPORTED_CHAINS).describe(
    'Chain context for the lookup. Use "hyperliquid" for perps mark price. Use "solana", "ethereum", etc. for DEX spot tokens. Use "any" when chain is unknown.',
  ),
});

const getPriceTool: AgentTool<TradingToolContext> = {
  name: 'get_price',
  description:
    'Look up the current price of a token. For Hyperliquid perps, returns the venue mark price. For DEX tokens, returns the best available oracle price from aggregators. ' +
    'Chain is required — "hyperliquid" for perps mark price, the token\'s native chain for DEX spot tokens, or "any" when the chain is unknown. ' +
    'Returns price in USD with source and freshness metadata.',
  parametersSchema: GetPriceParamsSchema,
  parameters: convertZodToJsonSchema(GetPriceParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { symbol, chain } = params as z.infer<typeof GetPriceParamsSchema>;
    const trimmedSymbol = symbol.trim();

    const validationError = validateSymbolForChain(trimmedSymbol, chain);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        retryable: false,
        fault: false,
      };
    }

    // L3: route the read through the Traderton boundary. When the boundary is
    // absent the tool degrades (fail-closed) — there is no in-process path. The
    // Traderton `get_price` tool does its own address auto-detection from the
    // symbol, so only { symbol, chain } is forwarded.
    if (!ctx.tradertonBoundary) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    const result = await ctx.tradertonBoundary.invoke({
      toolName: 'get_price',
      payload: { symbol: trimmedSymbol, chain },
    });
    return mapReadResultToToolResult(result);
  },
};

export const priceTools: AgentTool<TradingToolContext>[] = [getPriceTool];
