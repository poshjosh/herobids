/**
 * Watch/monitor tools — register token price watches and evaluate thresholds.
 *
 * Watch state lives Traderton-side. The WRITE tools (watch_token, remove_watch,
 * check_watches) route over the Traderton side-effecting boundary and FAIL
 * CLOSED when it is absent. The list_watches READ is boundary-first too and
 * FAILS CLOSED when the read boundary is absent — no local fallback (A6: the
 * legacy local Redis hash no longer receives writes, so it could only ever
 * serve stale pre-migration data).
 */

import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { WatchPurposeEnum } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult, mapWriteResultToToolResult } from './traderton-read.js';
import { EXPLICIT_SUPPORTED_CHAINS } from './price.js';

/** Deadline for single-record watch boundary writes (invoke + poll), in ms. */
const WATCH_WRITE_DEADLINE_MS = 30_000;
// check_watches fans out to N price fetches behind the boundary (one per pinned
// watch identity), so it needs more headroom than the single-record writes.
const CHECK_WATCHES_DEADLINE_MS = 60_000;

/** Returned by the tools when the Traderton boundary is absent. A6: the read
 * and write paths share the same typed fail-closed posture. */
const BOUNDARY_NOT_READY: ToolResult = {
  success: false,
  error: 'trading boundary not configured',
  errorCode: 'precondition.not_ready',
  fault: false,
};

// ---------------------------------------------------------------------------
// watch_token
// ---------------------------------------------------------------------------

const WatchTokenParamsSchema = z.object({
  symbol: z.string().min(1).describe('Token symbol or ticker (e.g. BTC, SOL, WIF)'),
  chain: z.enum(EXPLICIT_SUPPORTED_CHAINS).or(z.literal('any')).describe(
    'Chain context: an explicit chain (e.g. "hyperliquid", "solana", "ethereum") or "any" for cross-chain discovery. ' +
    'When "any" is used, the best-matching token is resolved once and the watch is pinned to that concrete chain — it will not drift between chains later.',
  ),
  // coerce: LLMs may send numbers as strings
  thresholdPrice: z.coerce.number().positive().describe('Price level in USD that triggers the watch'),
  condition: z.enum(['above', 'below']).describe(
    '"above" triggers when price rises above threshold; "below" triggers when price falls below threshold',
  ),
  note: z.string().optional().describe('Optional label or reason for this watch'),
  purpose: WatchPurposeEnum.optional().describe(
    'Semantic purpose of this watch — tells the runtime what the watch is for. ' +
    'New watches SHOULD include this. Values: entry, exit, stop_loss, take_profit, monitor, alert.',
  ),
  coverage: z.object({
    actorType: z.enum(['agent', 'bot', 'user', 'system']).optional(),
    actorId: z.string().optional(),
    intentGroup: z.string().optional(),
    /** Identify the target position so the worker can derive a canonical positionKey. */
    targetPosition: z.object({
      venue: z.string().min(1).describe('Venue where the position is held (e.g. "hyperliquid", "jupiter")'),
      symbol: z.string().min(1).describe('Symbol of the position'),
      side: z.enum(['long', 'short']).describe('Direction of the position'),
      instrumentId: z.string().optional().describe(
        'Canonical instrument ID of the position. Provide when available to disambiguate same-symbol positions.',
      ),
    }).optional().describe(
      'Identify the open position this watch protects. The worker derives the canonical positionKey — do NOT supply a raw positionKey.',
    ),
  }).optional().describe(
    'Optional linkage metadata — attach this watch to a specific actor, open position, or intent group for coverage tracking.',
  ),
});

const watchTokenTool: AgentTool<TradingToolContext> = {
  name: 'watch_token',
  description:
    'Register a price watch for a token. When chain is "any", the tool discovers the best-matching token and pins the watch to that concrete asset — future checks will always use the pinned identity. ' +
    'The watch fires when the token\'s price crosses the given threshold in the specified direction. ' +
    'Protective watches (stop_loss, take_profit, exit) require either a matching instrument identity or a resolvable target position — create the position first before creating a protective watch. ' +
    'Use check_watches to evaluate all registered watches. Use list_watches to see active watches. Use remove_watch to cancel one.',
  parametersSchema: WatchTokenParamsSchema,
  parameters: convertZodToJsonSchema(WatchTokenParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { symbol, chain, thresholdPrice, condition, note, purpose, coverage } =
      params as z.infer<typeof WatchTokenParamsSchema>;

    // Watch state lives Traderton-side — the boundary tool owns identity
    // resolution, instrument lookup, coverage derivation and positionKey strip.
    // FAIL CLOSED when the write boundary is absent. Coverage is forwarded
    // VERBATIM — do NOT pre-strip coverage.positionKey (the boundary owns it).
    if (!ctx.tradertonWriteBoundary) {
      return BOUNDARY_NOT_READY;
    }

    const result = await ctx.tradertonWriteBoundary.invokeAndAwait({
      toolName: 'watch_token',
      payload: { symbol, chain, thresholdPrice, condition, note, purpose, coverage },
      deadlineMs: WATCH_WRITE_DEADLINE_MS,
    });

    return mapWriteResultToToolResult(result);
  },
};

// ---------------------------------------------------------------------------
// list_watches
// ---------------------------------------------------------------------------

const ListWatchesParamsSchema = z.object({});

const listWatchesTool: AgentTool<TradingToolContext> = {
  name: 'list_watches',
  description: 'List all active price watches registered by this agent.',
  parametersSchema: ListWatchesParamsSchema,
  parameters: convertZodToJsonSchema(ListWatchesParamsSchema),
  category: 'read-memory',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    // A6: the READ is boundary-first and FAILS CLOSED when the read boundary
    // is absent — the legacy local Redis hash no longer receives writes and
    // could only serve stale pre-migration data. Typed failure codes align
    // with the shared read→tool mapping (precondition.not_ready, non-fault).
    if (!ctx.tradertonBoundary) {
      return BOUNDARY_NOT_READY;
    }

    return mapReadResultToToolResult(
      await ctx.tradertonBoundary.invoke({ toolName: 'list_watches', payload: {} }),
    );
  },
};

// ---------------------------------------------------------------------------
// remove_watch
// ---------------------------------------------------------------------------

const RemoveWatchParamsSchema = z.object({
  watchId: z.string().uuid().describe('ID of the watch to remove'),
});

const removeWatchTool: AgentTool<TradingToolContext> = {
  name: 'remove_watch',
  description: 'Remove a price watch by its ID. Use list_watches to find IDs.',
  parametersSchema: RemoveWatchParamsSchema,
  parameters: convertZodToJsonSchema(RemoveWatchParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { watchId } = params as z.infer<typeof RemoveWatchParamsSchema>;

    // Watch state lives Traderton-side — FAIL CLOSED when the boundary is absent.
    if (!ctx.tradertonWriteBoundary) {
      return BOUNDARY_NOT_READY;
    }

    const result = await ctx.tradertonWriteBoundary.invokeAndAwait({
      toolName: 'remove_watch',
      payload: { watchId },
      deadlineMs: WATCH_WRITE_DEADLINE_MS,
    });

    return mapWriteResultToToolResult(result);
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

const checkWatchesTool: AgentTool<TradingToolContext> = {
  name: 'check_watches',
  description:
    'Evaluate all active price watches against current market prices. Returns a list of watches that have triggered (threshold crossed). ' +
    'Set removeTriggered=true to automatically clear triggered watches after evaluation. ' +
    'Legacy watches without a pinned identity are lazily repaired on first evaluation — any that fail resolution appear in the unchecked list.',
  parametersSchema: CheckWatchesParamsSchema,
  parameters: convertZodToJsonSchema(CheckWatchesParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { removeTriggered } = params as z.infer<typeof CheckWatchesParamsSchema>;

    // Watch state lives Traderton-side — FAIL CLOSED when the boundary is absent.
    if (!ctx.tradertonWriteBoundary) {
      return BOUNDARY_NOT_READY;
    }

    const result = await ctx.tradertonWriteBoundary.invokeAndAwait({
      toolName: 'check_watches',
      payload: { removeTriggered },
      deadlineMs: CHECK_WATCHES_DEADLINE_MS,
    });

    return mapWriteResultToToolResult(result);
  },
};

export const watchTools: AgentTool<TradingToolContext>[] = [
  watchTokenTool,
  listWatchesTool,
  removeWatchTool,
  checkWatchesTool,
];
