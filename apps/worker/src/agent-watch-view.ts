/**
 * Pure helpers for the agent tick's active-watch view.
 *
 * Extracted from agent.ts so they can be unit-tested WITHOUT the full agent
 * harness (no live boundary, no Redis). They contain no I/O — the caller feeds
 * them the boundary `result.data` (or a raw watch list) and gets back parsed
 * runtime watches / a tick-gate summary.
 */

import { WatchEntrySchema, type WatchEntry } from '@poshjosh/contracts';
import { createLogger } from './logger.js';
import {
  summarizeActiveWatches,
  type RuntimeActiveWatch,
  type RuntimeActiveWatchSummary,
} from './runtime-composition.js';

const logger = createLogger('agent-watch-view');

/**
 * Parse a raw JSON string into a WatchEntry.
 *
 * Only structured watches (schemaVersion >= 2) are supported.
 * Records that fail Zod validation are discarded.
 * Returns null for any malformed or missing data.
 */
export function parseWatch(raw: string): WatchEntry | null {
  try {
    const parsed = WatchEntrySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Try to extract watchId for better diagnostics
      let watchId: string | undefined;
      try {
        const rawObj = JSON.parse(raw) as Record<string, unknown>;
        watchId = typeof rawObj.watchId === 'string' ? rawObj.watchId : undefined;
      } catch { /* swallow */ }
      logger.warn({ watchId, raw: raw.length > 200 ? raw.slice(0, 200) + '...' : raw, errors: parsed.error.issues }, 'Malformed watch record — discarding');
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Convert a WatchEntry into the RuntimeActiveWatch shape used in prompt composition.
 */
export function toRuntimeActiveWatch(watch: WatchEntry): RuntimeActiveWatch {
  return {
    watchId: watch.watchId,
    symbol: watch.symbol,
    chain: watch.chain,
    ...(watch.address ? { address: watch.address } : {}),
    ...(watch.resolvedSymbol ? { resolvedSymbol: watch.resolvedSymbol } : {}),
    ...(watch.resolvedChain ? { resolvedChain: watch.resolvedChain } : {}),
    ...(watch.resolvedAddress ? { resolvedAddress: watch.resolvedAddress } : {}),
    condition: watch.condition,
    thresholdPrice: watch.thresholdPrice,
    note: watch.note,
    lastConditionMet: watch.lastConditionMet,
    lastCheckedAt: watch.lastCheckedAt,
    ...(watch.schemaVersion !== undefined ? { schemaVersion: watch.schemaVersion } : {}),
    ...(watch.instrument ? { instrument: watch.instrument } : {}),
    ...(watch.purpose ? { purpose: watch.purpose } : {}),
    ...(watch.coverage ? { coverage: watch.coverage } : {}),
  };
}

/** Parse a single serialized WatchEntry into a runtime active watch (or null). */
export function parseRuntimeActiveWatch(raw: string): RuntimeActiveWatch | null {
  const watch = parseWatch(raw);
  if (!watch) return null;
  return toRuntimeActiveWatch(watch);
}

/**
 * Parse the `data` payload of a `list_watches` boundary result into runtime
 * active watches. Pure — no I/O. The boundary returns the identical WatchEntry
 * shape, so each entry is re-serialized and run through the same parse/convert
 * helpers. Malformed entries (parse → null) are dropped. Non-object payloads or
 * an absent `watches` array yield an empty list.
 */
export function parseBoundaryWatchList(data: unknown): RuntimeActiveWatch[] {
  const watches = (data && typeof data === 'object')
    ? (data as { watches?: unknown }).watches
    : undefined;
  if (!Array.isArray(watches)) {
    return [];
  }
  return watches
    .map((watch) => parseRuntimeActiveWatch(JSON.stringify(watch)))
    .filter((watch): watch is RuntimeActiveWatch => watch !== null);
}

/**
 * Derive the tick-gate watch summary from a raw watch list. Pure — no I/O.
 *
 * Empty input yields an EMPTY summary (never null) so the tick gate produces a
 * stable digest — a null summary makes computeWatchSummaryDigest emit
 * "__unknown__", forcing an LLM evaluation on every tick.
 */
export function deriveActiveWatchSummaryFrom(watches: RuntimeActiveWatch[]): RuntimeActiveWatchSummary {
  if (watches.length === 0) {
    return { totalCount: 0, uniqueCount: 0, lines: [], overflowCount: 0 };
  }
  return summarizeActiveWatches(watches);
}
