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
import { summarizeActiveWatches } from '../runtime-composition.js';
import { type WatchEntry, type WatchInstrumentIdentity, parseWatch, toRuntimeActiveWatch } from '../watch-types.js';

const logger = pino({ name: 'watch-tools' });

const EXPLICIT_SUPPORTED_CHAIN_SET = new Set<string>(EXPLICIT_SUPPORTED_CHAINS);

function watchesKey(agentId: string): string {
  return `agent:watches:${agentId}`;
}

function watchSummaryKey(agentId: string): string {
  return `agent:watches:summary:${agentId}`;
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

/**
 * Determine the effective lookup target for a watch entry.
 *
 * D4 lookup rules:
 * 1. If resolvedAddress exists, use resolvedSymbol, resolvedChain, resolvedAddress
 * 2. Else if resolvedChain exists, use resolvedSymbol, resolvedChain
 * 3. Else fall back to the caller-requested symbol and chain
 */
function getPinnedLookupTarget(watch: WatchEntry): { symbol: string; chain: string; address?: string } {
  if (watch.resolvedAddress && watch.resolvedSymbol && watch.resolvedChain) {
    return { symbol: watch.resolvedSymbol, chain: watch.resolvedChain, address: watch.resolvedAddress };
  }
  if (watch.resolvedChain && watch.resolvedSymbol) {
    return { symbol: watch.resolvedSymbol, chain: watch.resolvedChain, address: watch.address };
  }
  return { symbol: watch.symbol, chain: watch.chain, address: watch.address };
}

function watchLookupKey(target: { chain: string; symbol: string; address?: string }): string {
  return JSON.stringify([target.chain, target.symbol, target.address ?? null]);
}

function deserializeLookupKey(key: string): { chain: string; symbol: string; address: string | null } | null {
  try {
    const parsed = JSON.parse(key) as [unknown, unknown, unknown];
    const [chain, symbol, address] = parsed;
    if (typeof chain !== 'string' || typeof symbol !== 'string') {
      return null;
    }
    return { chain, symbol, address: typeof address === 'string' ? address : null };
  } catch {
    return null;
  }
}

/**
 * Lazy-repair a watch entry that lacks pinned identity fields (legacy watches
 * created before the token-discovery-and-pin feature).
 *
 * - Already-pinned watches (resolvedChain present) are returned unchanged.
 * - Legacy watches with an explicit chain are resolved against that chain.
 * - Legacy watches with chain "any" are resolved once to discover the best match.
 *
 * Returns { ok: false } when resolution fails — the caller should place the
 * watch in the unchecked list.
 */
async function ensurePinnedWatchIdentity(
  watch: WatchEntry,
  priceService: NonNullable<ToolContext['priceService']>,
): Promise<
  | { ok: true; watch: WatchEntry }
  | { ok: false; reason: string }
> {
  // Already pinned — nothing to do.
  if (watch.resolvedChain && watch.resolvedSymbol) {
    return { ok: true, watch };
  }

  // Legacy watch — resolve and pin.
  const addressArg = isOnChainAddress(watch.symbol, watch.chain) ? watch.symbol : undefined;

  const resolution = await priceService.resolvePriceTarget(
    watch.symbol,
    watch.chain,
    addressArg,
  );

  if (!resolution.ok || !resolution.data) {
    return { ok: false, reason: 'watch identity unresolved' };
  }

  const { symbol: resolvedSymbol, chain: resolvedChain, address: resolvedAddress } = resolution.data;

  // Validate the resolved chain is supported for watch tracking.
  if (resolvedChain && !EXPLICIT_SUPPORTED_CHAIN_SET.has(resolvedChain)) {
    return {
      ok: false,
      reason: `resolved chain "${resolvedChain}" is not a supported watch chain`,
    };
  }

  // Validate symbol format for the resolved chain.
  const validationError = validateSymbolForChain(resolvedSymbol, resolvedChain);
  if (validationError) {
    return { ok: false, reason: validationError };
  }

  const updatedWatch: WatchEntry = {
    ...watch,
    resolvedSymbol,
    resolvedChain,
    ...(resolvedAddress ? { resolvedAddress, address: resolvedAddress } : {}),
  };

  return { ok: true, watch: updatedWatch };
}

// ---------------------------------------------------------------------------
// watch_token
// ---------------------------------------------------------------------------

const WatchTokenParamsSchema = z.object({
  symbol: z.string().min(1).describe('Token symbol or ticker (e.g. BTC, SOL, WIF)'),
  chain: z.enum(EXPLICIT_SUPPORTED_CHAINS).or(z.literal('any')).describe(
    'Chain context: an explicit chain (e.g. "hyperliquid", "solana", "ethereum") or "any" for cross-chain discovery. ' +
    'When "any" is used, the best-matching token is resolved once and the watch is pinned to that concrete chain — it will not drift between chains later.',
  ),
  thresholdPrice: z.number().positive().describe('Price level in USD that triggers the watch'),
  condition: z.enum(['above', 'below']).describe(
    '"above" triggers when price rises above threshold; "below" triggers when price falls below threshold',
  ),
  note: z.string().optional().describe('Optional label or reason for this watch'),
  purpose: z.enum(['entry', 'exit', 'stop_loss', 'take_profit', 'monitor', 'alert']).optional().describe(
    'Semantic purpose of this watch — tells the runtime what the watch is for. ' +
    'New watches SHOULD include this. Values: entry, exit, stop_loss, take_profit, monitor, alert.',
  ),
  coverage: z.object({
    actorType: z.enum(['agent', 'bot', 'user', 'system']).optional(),
    actorId: z.string().optional(),
    positionKey: z.string().optional(),
    intentGroup: z.string().optional(),
  }).optional().describe(
    'Optional linkage metadata — attach this watch to a specific actor, open position, or intent group for coverage tracking.',
  ),
});

const watchTokenTool: AgentTool = {
  name: 'watch_token',
  description:
    'Register a price watch for a token. When chain is "any", the tool discovers the best-matching token and pins the watch to that concrete asset — future checks will always use the pinned identity. ' +
    'The watch fires when the token\'s price crosses the given threshold in the specified direction. ' +
    'Use check_watches to evaluate all registered watches. Use list_watches to see active watches. Use remove_watch to cancel one.',
  parametersSchema: WatchTokenParamsSchema,
  parameters: convertZodToJsonSchema(WatchTokenParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { symbol, chain, thresholdPrice, condition, note, purpose, coverage } =
      params as z.infer<typeof WatchTokenParamsSchema>;
    const trimmedSymbol = symbol.trim();
    const normalizedChain = chain.trim().toLowerCase();

    if (!EXPLICIT_SUPPORTED_CHAIN_SET.has(normalizedChain) && normalizedChain !== 'any') {
      return {
        success: false,
        error: `unsupported chain: ${chain}. Valid watch chains are: ${EXPLICIT_SUPPORTED_CHAINS.join(', ')}, any.`,
        retryable: false,
        fault: false,
      };
    }

    // --- Identity resolution ---
    // Resolve the asset identity so the watch is pinned to a concrete token.
    // For explicit chains, resolution is best-effort — the watch is still created
    // on failure (graceful degradation). For 'any', resolution is required.
    let resolvedSymbol: string | undefined;
    let resolvedChain: string | undefined;
    let resolvedAddress: string | undefined;

    if (ctx.priceService) {
      const addressArg = isOnChainAddress(trimmedSymbol, normalizedChain === 'any' ? 'any' : normalizedChain)
        ? trimmedSymbol
        : undefined;

      const resolution = await ctx.priceService.resolvePriceTarget(
        trimmedSymbol,
        normalizedChain,
        addressArg,
      );

      if (resolution.ok && resolution.data) {
        resolvedSymbol = resolution.data.symbol;
        resolvedChain = resolution.data.chain;
        resolvedAddress = resolution.data.address;
      } else {
        // Resolution is required for any chain when a price service is
        // available — a watch without a stable identity is the exact bug
        // this feature fixes (plan D6).
        return {
          success: false,
          error: resolution.error?.message ?? `Could not resolve "${trimmedSymbol}" to a concrete token. Try an explicit chain instead.`,
          retryable: resolution.error?.code === 'price.source_failed',
          fault: false,
        };
      }
    } else if (normalizedChain === 'any') {
      return {
        success: false,
        error: 'Cannot resolve "any" chain without a price service. Provide an explicit chain instead.',
        retryable: false,
        fault: false,
      };
    }

    // Validate resolved chain is in the supported watch chain set.
    // Prevents creating a watch pinned to an unsupported chain (e.g. 'fantom' from DexScreener).
    if (resolvedChain && !EXPLICIT_SUPPORTED_CHAIN_SET.has(resolvedChain)) {
      return {
        success: false,
        error: `resolved chain "${resolvedChain}" is not a supported watch chain`,
        retryable: false,
        fault: false,
      };
    }

    // Validate symbol format for the effective (resolved) chain.
    const effectiveSymbol = resolvedSymbol ?? trimmedSymbol;
    const effectiveChain = resolvedChain ?? normalizedChain;
    const validationError = validateSymbolForChain(effectiveSymbol, effectiveChain);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        retryable: false,
        fault: false,
      };
    }

    // --- Instrument identity resolution ---
    // Resolve the canonical venue + instrumentId from the trading system's instrument
    // repository. This is best-effort — watch creation does NOT fail if instrumentRepo
    // is unavailable or returns no matches.
    let instrument: WatchInstrumentIdentity | undefined;

    if (ctx.instrumentRepo) {
      try {
        const searchQuery = resolvedSymbol ?? effectiveSymbol;
        const results = await ctx.instrumentRepo.search({ query: searchQuery, limit: 5 });
        // Match on exact symbol for now; future iterations can use chain/address disambiguation.
        const match = results.find(
          (r) => r.symbol.toUpperCase() === searchQuery.toUpperCase(),
        );
        if (match) {
          instrument = {
            venue: match.venue,
            instrumentId: match.id,
            symbol: match.symbol,
          };
          // If we also have chain/address info, attach it for richer identity.
          if (effectiveChain && effectiveChain !== 'any') {
            instrument.chain = effectiveChain;
          }
          if (resolvedAddress) {
            instrument.address = resolvedAddress;
          }
        }
      } catch (err) {
        // Best-effort — log and continue without instrument identity.
        logger.warn({ err, symbol: effectiveSymbol }, 'Instrument repo search failed — watch created without instrument identity');
      }
    }

    const watch: WatchEntry = {
      watchId: crypto.randomUUID(),
      symbol: trimmedSymbol,              // what the caller asked for
      chain: normalizedChain,             // what the caller asked for (may be "any")
      ...(resolvedAddress ? { address: resolvedAddress } : {}),
      ...(resolvedSymbol ? { resolvedSymbol } : {}),
      ...(resolvedChain ? { resolvedChain } : {}),
      ...(resolvedAddress ? { resolvedAddress } : {}),
      thresholdPrice,
      condition,
      ...(note ? { note } : {}),
      createdAt: new Date().toISOString(),
      lastConditionMet: null,
      schemaVersion: 2,
      ...(instrument ? { instrument } : {}),
      ...(purpose ? { purpose } : {}),
      ...(coverage ? { coverage } : {}),
    };

    // Get initial price using the pinned lookup target.
    if (ctx.priceService) {
      const lookupTarget = getPinnedLookupTarget(watch);
      const priceAddress = lookupTarget.address ?? (isOnChainAddress(lookupTarget.symbol, lookupTarget.chain) ? lookupTarget.symbol : undefined);
      const initialPrice = await ctx.priceService.getPrice(lookupTarget.symbol, lookupTarget.chain, priceAddress);
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
        symbol: watch.symbol,
        chain: watch.chain,
        resolvedSymbol: watch.resolvedSymbol,
        resolvedChain: watch.resolvedChain,
        resolvedAddress: watch.resolvedAddress,
        thresholdPrice,
        condition,
        ...(instrument ? { instrument } : {}),
        ...(purpose ? { purpose } : {}),
        ...(coverage ? { coverage } : {}),
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

    // Remove from the notified set so a future watch with the same ID (re-created)
    // isn't incorrectly treated as already-notified.
    const notifiedKey = `agent:watches:notified:${ctx.agentId}`;
    ctx.redis.srem(notifiedKey, watchId).catch((err: unknown) => {
      logger.warn({ err, watchId }, 'Failed to clear notified watch on removal');
    });

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
    'Set removeTriggered=true to automatically clear triggered watches after evaluation. ' +
    'Legacy watches without a pinned identity are lazily repaired on first evaluation — any that fail resolution appear in the unchecked list.',
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

    // Step 6: Lazy repair for legacy watches that lack pinned identity fields.
    const pinnedWatches: WatchEntry[] = [];
    const unchecked: Array<{ watchId: string; symbol: string; chain: string; reason: string }> = [];

    for (const watch of watches) {
      const repair = await ensurePinnedWatchIdentity(watch, ctx.priceService);
      if (!repair.ok) {
        unchecked.push({
          watchId: watch.watchId,
          symbol: watch.symbol,
          chain: watch.chain,
          reason: repair.reason,
        });
        continue;
      }
      // Persist the repaired watch back to Redis so the pin survives restarts.
      if (!watch.resolvedChain && repair.watch.resolvedChain) {
        await ctx.redis.hset(watchesKey(ctx.agentId), watch.watchId, JSON.stringify(repair.watch));
      }
      pinnedWatches.push(repair.watch);
    }

    // Step 7: Deduplicate price lookups by pinned identity.
    // Two same-symbol watches on different chains or with different addresses
    // produce distinct lookup keys and separate price fetches.
    const priceMap = new Map<string, { priceUsd: number; source: string; stale: boolean; fetchedAt: string } | null>();

    for (const watch of pinnedWatches) {
      const target = getPinnedLookupTarget(watch);
      const key = watchLookupKey(target);
      if (!priceMap.has(key)) {
        priceMap.set(key, null); // mark as pending
      }
    }

    for (const key of priceMap.keys()) {
      const parsedKey = deserializeLookupKey(key);
      if (!parsedKey) {
        continue;
      }
      const { chain, symbol, address } = parsedKey;
      const priceAddress = address ?? (isOnChainAddress(symbol, chain) ? symbol : undefined);
      const result = await ctx.priceService.getPrice(symbol, chain, priceAddress);
      priceMap.set(key, result.ok && result.data ? result.data : null);
    }

    const updatedWatches = new Map<string, WatchEntry>();
    const triggered: Array<WatchEntry & { currentPrice: number; priceSource: string; stale: boolean }> = [];

    for (const watch of pinnedWatches) {
      const lookupTarget = getPinnedLookupTarget(watch);
      const priceData = priceMap.get(watchLookupKey(lookupTarget));
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

      // When the condition clears (true → false), remove the watch from the
      // notified set so the next crossing can trigger a fresh escalation.
      if (watch.lastConditionMet === true && !conditionMet) {
        const notifiedKey = `agent:watches:notified:${ctx.agentId}`;
        ctx.redis.srem(notifiedKey, watch.watchId).catch((err: unknown) => {
          logger.warn({ err, watchId: watch.watchId }, 'Failed to clear notified watch on condition reset');
        });
      }

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
