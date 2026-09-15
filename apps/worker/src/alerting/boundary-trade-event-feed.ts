// Boundary-backed TradeEventFeed adapter (c4.9j).
//
// Fulfils the narrow `TradeEventFeed` port by invoking Traderton's cross-owner
// trade-event read tools (`scan_trade_events` / `get_events_by_ids` /
// `get_event_by_id`) over the REST boundary. Mirrors the
// `createTradertonReadBoundary` / `TradertonReadBoundary.invoke` pattern: it
// takes a bound read boundary (subject + deadline already baked in) and maps
// each method to a named tool invocation.
//
// The boundary returns JSON — `createdAt` arrives as an ISO string, not a Date.
// We rehydrate it back to a Date (mirroring evidence-row-mappers `toJournalRow`,
// the same ISO→Date concern already solved for the evaluation read path) so the
// dispatcher's cursor arithmetic (`createdAt.getTime()`) stays correct.
//
// On any non-success outcome (failure / in_progress / transport_error) this
// THROWS. That is deliberate and safe under the dispatcher's at-least-once
// design: the tick's top-level catch reschedules, and the cursor advances only
// AFTER delivery rows are inserted — so a thrown scan leaves the cursor in place
// and the next tick re-scans (delivery insert is ON CONFLICT DO NOTHING).
// Returning `[]` instead would falsely advance the cursor and silently drop
// events between ticks.

import type { JournalEventRow } from './alert-policy.js';
import type { TradeEventFeed } from './trade-event-feed.js';
import type { TradertonReadBoundary } from '../traderton/read-adapter.js';
import type { TradertonReadResult } from '@herobids/domain';

/** Rehydrate an ISO string (or Date) into a Date. Throws on missing/invalid values. */
function toDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`Invalid date for field "${field}": ${String(value)}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected an object row from the Traderton trade-event feed');
  }
  return value as Record<string, unknown>;
}

/** Narrow a boundary record into a JournalEventRow, rehydrating `createdAt`. */
function toRow(record: unknown): JournalEventRow {
  const r = asRecord(record);
  return {
    id: r['id'] as string,
    botId: (r['botId'] as string | null | undefined) ?? null,
    actorId: (r['actorId'] as string | null | undefined) ?? null,
    type: r['type'] as string,
    payload: (r['payload'] as Record<string, unknown> | null | undefined) ?? {},
    createdAt: toDate(r['createdAt'], 'createdAt'),
  };
}

/**
 * Surface a read result's rows, or throw on any non-success outcome so the
 * dispatcher tick's catch reschedules without advancing the cursor.
 */
function requireSuccess(result: TradertonReadResult, toolName: string): unknown {
  switch (result.kind) {
    case 'success':
      return result.data;
    case 'failure':
      throw new Error(`Traderton trade-event feed ${toolName} failed: ${result.code} ${result.message}`);
    case 'in_progress':
      throw new Error(`Traderton trade-event feed ${toolName} returned in_progress unexpectedly`);
    case 'transport_error':
      throw new Error(`Traderton trade-event feed ${toolName} transport error: ${result.message}`);
  }
}

export function createBoundaryTradeEventFeed(boundary: TradertonReadBoundary): TradeEventFeed {
  return {
    async scanAfter(opts): Promise<JournalEventRow[]> {
      const result = await boundary.invoke({
        toolName: 'scan_trade_events',
        payload: {
          cursor: opts.cursor
            ? { createdAt: opts.cursor.createdAt.toISOString(), seenIds: opts.cursor.seenIds }
            : undefined,
          typePrefixes: opts.typePrefixes,
          limit: opts.limit,
        },
      });
      const data = asRecord(requireSuccess(result, 'scan_trade_events'));
      const events = (data['events'] as unknown[]) ?? [];
      return events.map(toRow);
    },

    async getByIds(ids): Promise<JournalEventRow[]> {
      const result = await boundary.invoke({
        toolName: 'get_events_by_ids',
        payload: { ids },
      });
      const data = asRecord(requireSuccess(result, 'get_events_by_ids'));
      const events = (data['events'] as unknown[]) ?? [];
      return events.map(toRow);
    },

    async getById(id): Promise<JournalEventRow | null> {
      const result = await boundary.invoke({
        toolName: 'get_event_by_id',
        payload: { id },
      });
      const data = asRecord(requireSuccess(result, 'get_event_by_id'));
      const event = data['event'];
      return event === null || event === undefined ? null : toRow(event);
    },
  };
}
