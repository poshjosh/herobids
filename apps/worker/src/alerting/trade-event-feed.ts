// The narrow trade-event feed port the AlertDispatcher depends on (c4.9j).
//
// The dispatcher used to hold a concrete `PgJournal` and call exactly three of
// its methods. Trading has moved to Traderton behind the REST boundary, so the
// dispatcher now depends on this port instead — a boundary-backed adapter
// (boundary-trade-event-feed.ts) fulfils it over the wire. The three methods
// mirror the `PgJournal` reads the dispatcher already called, with the same
// shapes (`JournalEventRow` from alert-policy.ts). This is a port only — no
// logic lives here.

import type { JournalEventRow } from './alert-policy.js';

export interface TradeEventFeed {
  /** Cursor-based global scan, ordered ascending (oldest first). */
  scanAfter(opts: {
    cursor?: { createdAt: Date; seenIds: string[] };
    typePrefixes?: string[];
    limit: number;
  }): Promise<JournalEventRow[]>;
  /** Fetch events by their IDs. */
  getByIds(ids: string[]): Promise<JournalEventRow[]>;
  /** Fetch a single event by ID, or null when absent. */
  getById(id: string): Promise<JournalEventRow | null>;
}
