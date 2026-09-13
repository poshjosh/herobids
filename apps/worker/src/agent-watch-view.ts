/**
 * Pure helpers for the agent tick's active-watch view.
 *
 * Extracted from agent.ts so they can be unit-tested WITHOUT the full agent
 * harness (no live boundary, no Redis). They contain no I/O — the caller feeds
 * them the boundary `result.data` (or a raw watch list) and gets back parsed
 * runtime watches / a tick-gate summary.
 */

import {
  summarizeActiveWatches,
  type RuntimeActiveWatch,
  type RuntimeActiveWatchSummary,
} from './runtime-composition.js';
import { parseWatch, toRuntimeActiveWatch } from './watch-types.js';

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
