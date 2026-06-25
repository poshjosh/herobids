/**
 * Watch/monitor tools — register token price watches and evaluate thresholds.
 *
 * Watches are stored as fields in a Redis hash:
 *   key:   agent:watches:{agentId}
 *   field: {watchId}
 *   value: JSON-encoded WatchEntry
 *
 * The agent calls check_watches to evaluate all registered watches against
 * current prices. Triggered watches are returned so the agent can decide
 * whether to act (e.g. send an alert, adjust a position, or clear the watch).
 */

import { z } from 'zod';
import crypto from 'node:crypto';
import pino from 'pino';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { EXPLICIT_SUPPORTED_CHAINS, validateSymbolForChain, isOnChainAddress } from './price.js';
import { summarizeActiveWatches, type RuntimeActiveWatch } from '../runtime-composition.js';

const logger = pino({ name: 'watch-tools' });

const EXPLICIT_SUPPORTED_CHAIN_SET = new Set<string>(EXPLICIT_SUPPORTED_CHAINS);

interface WatchEntry {
  watchId: string;
  symbol: string;
  chain: string;
  thresholdPrice: number;
  condition: 'above' | 'below';
  note?: string;
  createdAt: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
}

function watchesKey(agentId: string): string {
  return `agent:watches:${agentId}`;
}

function watchSummaryKey(agentId: string): string {
  return `agent:watches:summary:${agentId}`;
}

function parseWatch(raw: string): WatchEntry | null {
  try {
    return JSON.parse(raw) as WatchEntry;
  } catch {
    return null;
  }
}

function toRuntimeActiveWatch(watch: WatchEntry): RuntimeActiveWatch {
  return {
    watchId: watch.watchId,
    symbol: watch.symbol,
    chain: watch.chain,
    condition: watch.condition,
    thresholdPrice: watch.thresholdPrice,
    note: watch.note,
    lastConditionMet: watch.lastConditionMet,
    lastCheckedAt: watch.lastCheckedAt,
  };
}

async function refreshWatchSummaryCache(ctx: ToolContext): Promise<void> {
  try {
    const raw = await ctx.redis.hgetall(watchesKey(ctx.agentId));
    const watches = Object.values(raw ?? {})
      .map(parseWatch)
      .filter((watch): watch is WatchEntry => watch !== null)
      .map(toRuntimeActiveWatch);

    const summary = summarizeActiveWatches(watches);
    if (summary.totalCount === 0) {
      await ctx.redis.hdel(watchSummaryKey(ctx.agentId), 'summary');
      return;
    }

    await ctx.redis.hset(watchSummaryKey(ctx.agentId), 'summary', JSON.stringify(summary));
  } catch (err) {
    logger.warn({ err, agentId: ctx.agentId }, 'Failed to refresh active watch summary cache');
  }
}

function isThresholdMet(watch: Pick<WatchEntry, 'condition' | 'thresholdPrice'>, priceUsd: number): boolean {
  return watch.condition === 'above'
    ? priceUsd >= watch.thresholdPrice
    : priceUsd <= watch.thresholdPrice;
}

function watchLookupKey(watch: Pick<WatchEntry, 'chain' | 'symbol'>): string {
  return JSON.stringify([watch.chain, watch.symbol]);
}

function parseWatchLookupKey(key: string): { chain: string; symbol: string } | null {
  try {
    const parsed = JSON.parse(key) as [unknown, unknown];
    const [chain, symbol] = parsed;
    if (typeof chain !== 'string' || typeof symbol !== 'string') {
      return null;
    }
    return { chain, symbol };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// watch_token
// ---------------------------------------------------------------------------

const WatchTokenParamsSchema = z.object({
  symbol: z.string().min(1).describe('Token symbol or ticker (e.g. BTC, SOL, WIF)'),
  chain: z.enum(EXPLICIT_SUPPORTED_CHAINS).describe(
    'Explicit chain context required for watches, e.g. "hyperliquid", "solana", "ethereum". ' +
    'Watches do not support "any" because they must point at one stable asset. If the chain is unknown, call get_price first to discover it, then create the watch with that explicit chain.',
  ),
  thresholdPrice: z.number().positive().describe('Price level in USD that triggers the watch'),
  condition: z.enum(['above', 'below']).describe(
    '"above" triggers when price rises above threshold; "below" triggers when price falls below threshold',
  ),
  note: z.string().optional().describe('Optional label or reason for this watch'),
});

const watchTokenTool: AgentTool = {
  name: 'watch_token',
  description:
    'Register a price watch for a token. The watch fires when the token\'s price crosses the given threshold in the specified direction. ' +
    'Use check_watches to evaluate all registered watches. Use list_watches to see active watches. Use remove_watch to cancel one.',
  parametersSchema: WatchTokenParamsSchema,
  parameters: convertZodToJsonSchema(WatchTokenParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { symbol, chain, thresholdPrice, condition, note } =
      params as z.infer<typeof WatchTokenParamsSchema>;
    const trimmedSymbol = symbol.trim();
    const normalizedChain = chain.trim().toLowerCase();

    if (normalizedChain === 'any') {
      return {
        success: false,
        error:
          'watch_token requires an explicit chain. "any" is only supported by get_price for one-shot discovery. Call get_price first, then create the watch with the resolved chain.',
        retryable: false,
        fault: false,
      };
    }

    if (!EXPLICIT_SUPPORTED_CHAIN_SET.has(normalizedChain)) {
      return {
        success: false,
        error: `unsupported chain: ${chain}. Valid watch chains are: ${EXPLICIT_SUPPORTED_CHAINS.join(', ')}. If the chain is unknown, call get_price first and then create the watch with the resolved explicit chain.`,
        retryable: false,
        fault: false,
      };
    }

    const validationError = validateSymbolForChain(trimmedSymbol, normalizedChain);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        retryable: false,
        fault: false,
      };
    }

    const watch: WatchEntry = {
      watchId: crypto.randomUUID(),
      symbol: trimmedSymbol,
      chain: normalizedChain,
      thresholdPrice,
      condition,
      ...(note ? { note } : {}),
      createdAt: new Date().toISOString(),
      lastConditionMet: null,
    };

    if (ctx.priceService) {
      const address = isOnChainAddress(watch.symbol, watch.chain) ? watch.symbol : undefined;
      const initialPrice = await ctx.priceService.getPrice(watch.symbol, watch.chain, address);
      if (initialPrice.ok && initialPrice.data) {
        watch.lastConditionMet = isThresholdMet(watch, initialPrice.data.priceUsd);
        watch.lastCheckedAt = initialPrice.data.fetchedAt;
      }
    }

    await ctx.redis.hset(watchesKey(ctx.agentId), watch.watchId, JSON.stringify(watch));
    await refreshWatchSummaryCache(ctx);

    return {
      success: true,
      data: {
        ok: true,
        watchId: watch.watchId,
        symbol: trimmedSymbol,
        chain: normalizedChain,
        thresholdPrice,
        condition,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// list_watches
// ---------------------------------------------------------------------------

const ListWatchesParamsSchema = z.object({});

const listWatchesTool: AgentTool = {
  name: 'list_watches',
  description: 'List all active price watches registered by this agent.',
  parametersSchema: ListWatchesParamsSchema,
  parameters: convertZodToJsonSchema(ListWatchesParamsSchema),
  category: 'read-memory',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = await ctx.redis.hgetall(watchesKey(ctx.agentId));
    if (!raw) {
      return { success: true, data: { ok: true, watches: [] } };
    }

    const watches = Object.values(raw)
      .map(parseWatch)
      .filter((w): w is WatchEntry => w !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return { success: true, data: { ok: true, watches } };
  },
};

// ---------------------------------------------------------------------------
// remove_watch
// ---------------------------------------------------------------------------

const RemoveWatchParamsSchema = z.object({
  watchId: z.string().uuid().describe('ID of the watch to remove'),
});

const removeWatchTool: AgentTool = {
  name: 'remove_watch',
  description: 'Remove a price watch by its ID. Use list_watches to find IDs.',
  parametersSchema: RemoveWatchParamsSchema,
  parameters: convertZodToJsonSchema(RemoveWatchParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { watchId } = params as z.infer<typeof RemoveWatchParamsSchema>;

    const deleted = await ctx.redis.hdel(watchesKey(ctx.agentId), watchId);

    if (deleted === 0) {
      return { success: false, error: `watch ${watchId} not found`, retryable: false, fault: false };
    }

    await refreshWatchSummaryCache(ctx);

    return { success: true, data: { ok: true, watchId, removed: true } };
  },
};

// ---------------------------------------------------------------------------
// check_watches
// ---------------------------------------------------------------------------

const CheckWatchesParamsSchema = z.object({
  removeTriggered: z
    .boolean()
    .optional()
    .default(false)
    .describe('When true, automatically remove watches that have triggered. Default: false.'),
});

const checkWatchesTool: AgentTool = {
  name: 'check_watches',
  description:
    'Evaluate all active price watches against current market prices. Returns a list of watches that have triggered (threshold crossed). ' +
    'Set removeTriggered=true to automatically clear triggered watches after evaluation.',
  parametersSchema: CheckWatchesParamsSchema,
  parameters: convertZodToJsonSchema(CheckWatchesParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { removeTriggered } = params as z.infer<typeof CheckWatchesParamsSchema>;

    if (!ctx.priceService) {
      return {
        success: false,
        error: 'price_service_not_configured',
        retryable: false,
      };
    }

    const raw = await ctx.redis.hgetall(watchesKey(ctx.agentId));
    if (!raw) {
      return { success: true, data: { ok: true, triggered: [], unchecked: [] } };
    }

    const watches = Object.values(raw)
      .map(parseWatch)
      .filter((w): w is WatchEntry => w !== null);

    if (watches.length === 0) {
      return { success: true, data: { ok: true, triggered: [], unchecked: [] } };
    }

    // Deduplicate price lookups by symbol+chain
    const priceMap = new Map<string, { priceUsd: number; source: string; stale: boolean; fetchedAt: string } | null>();

    for (const watch of watches) {
      const key = watchLookupKey(watch);
      if (!priceMap.has(key)) {
        priceMap.set(key, null); // mark as pending
      }
    }

    for (const key of priceMap.keys()) {
      const parsedKey = parseWatchLookupKey(key);
      if (!parsedKey) {
        continue;
      }
      const { chain, symbol } = parsedKey;
      const address = isOnChainAddress(symbol, chain) ? symbol : undefined;
      const result = await ctx.priceService.getPrice(symbol, chain, address);
      priceMap.set(key, result.ok && result.data ? result.data : null);
    }

    const updatedWatches = new Map<string, WatchEntry>();
    const triggered: Array<WatchEntry & { currentPrice: number; priceSource: string; stale: boolean }> = [];
    const unchecked: Array<{ watchId: string; symbol: string; chain: string; reason: string }> = [];

    for (const watch of watches) {
      const priceData = priceMap.get(watchLookupKey(watch));
      if (!priceData) {
        unchecked.push({
          watchId: watch.watchId,
          symbol: watch.symbol,
          chain: watch.chain,
          reason: 'price unavailable',
        });
        continue;
      }

      const conditionMet = isThresholdMet(watch, priceData.priceUsd);
      const isTriggered = watch.lastConditionMet === false && conditionMet;
      const updatedWatch: WatchEntry = {
        ...watch,
        lastConditionMet: conditionMet,
        lastCheckedAt: priceData.fetchedAt,
      };
      updatedWatches.set(watch.watchId, updatedWatch);

      if (isTriggered) {
        triggered.push({
          ...updatedWatch,
          currentPrice: priceData.priceUsd,
          priceSource: priceData.source,
          stale: priceData.stale,
        });
      }
    }

    for (const [watchId, watch] of updatedWatches) {
      if (removeTriggered && triggered.some((entry) => entry.watchId === watchId)) {
        continue;
      }
      await ctx.redis.hset(watchesKey(ctx.agentId), watchId, JSON.stringify(watch));
    }

    if (removeTriggered && triggered.length > 0) {
      const ids = triggered.map((w) => w.watchId);
      await ctx.redis.hdel(watchesKey(ctx.agentId), ...ids);
    }

    await refreshWatchSummaryCache(ctx);

    return {
      success: true,
      data: { ok: true, triggered, unchecked, totalWatches: watches.length },
    };
  },
};

export const watchTools: AgentTool[] = [
  watchTokenTool,
  listWatchesTool,
  removeWatchTool,
  checkWatchesTool,
];
