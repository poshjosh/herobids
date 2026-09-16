// Row-shape narrowing + date rehydration for evidence sourced over the
// Traderton read boundary.
//
// The boundary returns JSON: `timestamp` columns arrive as ISO strings, not
// Date objects. The evidence assembler writes these rows back out as JSON
// artifacts (fills.json / journal.json / positions.json), and downstream
// analyzers re-parse that JSON. To keep the artifacts byte-for-byte equivalent
// to the pre-boundary path — where the DB loaders returned real `Date` objects
// that `JSON.stringify` rendered as ISO strings — we rehydrate the date-typed
// columns into `Date` here. Numeric/decimal columns are already strings (drizzle
// `numeric` maps to `string`) and pass through unchanged. Additive Traderton
// columns (e.g. an extra field on a fill) pass through harmlessly.
//
// Only the fields the row types declare are mapped; unknown extras are copied
// through so the JSON artifact stays faithful.

// c4.9f: the local trading-table schema (fills/journalEvents/positions) was
// dropped — these rows now arrive from the Traderton read boundary. Traderton's
// schema is byte-identical to the dropped herobids tables, so these interfaces
// faithfully reproduce each column with the type `$inferSelect` would have
// produced: drizzle `text` → string (nullable → string | null), `numeric` →
// string, `timestamp` → Date, `jsonb` → its `$type`. The mappers spread the
// boundary record and rehydrate the date columns (which arrive as ISO strings)
// back into Date objects.

/** A fill record (mirrors the dropped `fills` table). */
export interface FillRow {
  id: string;
  orderId: string;
  venueAccountId: string;
  actorType: string;
  actorId: string | null;
  venueRefId: string | null;
  venue: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee: string | null;
  feeCurrency: string | null;
  realizedPnlDelta: string | null;
  filledAt: Date;
  createdAt: Date;
}

/** A journal-event record (mirrors the dropped `journal_events` table). */
export interface JournalRow {
  id: string;
  actorType: string | null;
  actorId: string | null;
  backtestRunId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** A position record (mirrors the dropped `positions` table). */
export interface PositionRow {
  id: string;
  venueAccountId: string;
  actorType: string;
  actorId: string | null;
  venue: string;
  symbol: string;
  instrumentId: string | null;
  side: string;
  size: string;
  entryPrice: string;
  realizedPnl: string;
  markSource: string | null;
  exitReason: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  openedAt: Date;
  closedAt: Date | null;
  updatedAt: Date;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected an object row from the Traderton read boundary');
  }
  return value as Record<string, unknown>;
}

/** Rehydrate an ISO string (or Date) into a Date. Throws on missing/invalid values. */
function toDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`Invalid date for field "${field}": ${String(value)}`);
}

/** Null-safe date rehydration for nullable timestamp columns. */
function toNullableDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value, field);
}

/**
 * Narrow a boundary record into a fill row, rehydrating `filledAt` / `createdAt`.
 * All non-date fields (including additive columns) pass through unchanged.
 */
export function toFillRow(record: unknown): FillRow {
  const r = asRecord(record);
  return {
    ...r,
    filledAt: toDate(r['filledAt'], 'filledAt'),
    createdAt: toDate(r['createdAt'], 'createdAt'),
  } as FillRow;
}

/**
 * Narrow a boundary record into a journal-event row, rehydrating `createdAt`.
 */
export function toJournalRow(record: unknown): JournalRow {
  const r = asRecord(record);
  return {
    ...r,
    createdAt: toDate(r['createdAt'], 'createdAt'),
  } as JournalRow;
}

/**
 * Narrow a boundary record into a position row, rehydrating `openedAt`,
 * `updatedAt`, and the nullable `closedAt`.
 */
export function toPositionRow(record: unknown): PositionRow {
  const r = asRecord(record);
  return {
    ...r,
    openedAt: toDate(r['openedAt'], 'openedAt'),
    closedAt: toNullableDate(r['closedAt'], 'closedAt'),
    updatedAt: toDate(r['updatedAt'], 'updatedAt'),
  } as PositionRow;
}
