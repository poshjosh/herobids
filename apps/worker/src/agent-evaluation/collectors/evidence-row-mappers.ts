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

import type { fills, journalEvents, positions } from '@herobids/db';

export type FillRow = typeof fills.$inferSelect;
export type JournalRow = typeof journalEvents.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;

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
