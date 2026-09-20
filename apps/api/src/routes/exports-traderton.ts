// API-local seam for the export endpoints that source trading evidence over the
// Traderton read boundary. Introduced for the agent-export endpoints (D1-c1
// Sub-step 5); also backs the bot-level + account-level export endpoints (c4.2)
// via the owner-scoped read tools + `loadBoundaryObject`.
//
// This mirrors the worker's read-adapter + evidence-row-mappers (a copy, never
// a cross-app import — apps/worker is not a dependency of apps/api). The seam is
// transport + row-shape narrowing ONLY — no trading logic:
//
//   - `createTradertonReadBoundary` binds the per-request subject VALUES + the
//     deadline onto a concrete `TradertonClient`, and maps the client result
//     into the domain-clean `TradertonReadResult`. The agent endpoints build one
//     boundary per request bound to the REQUESTING USER's subject.
//   - `toFillRow` / `toJournalRow` / `toPositionRow` rehydrate the date-typed
//     columns (which arrive as ISO strings over JSON) back into `Date` objects
//     so the existing CSV/JSON/markdown mappers — which call `.toISOString()`
//     and re-serialize the rows — produce byte-identical output to the previous
//     in-process DB-loader path. Numeric/decimal columns are already strings and
//     pass through unchanged; additive Traderton columns pass through harmlessly.
//   - `narrowReadArray` narrows a success payload's `{ fills | events | positions }`
//     array; any non-success outcome is surfaced to the caller as a typed error
//     so the endpoint can return the right HTTP status (never silently empty).

import type { TradertonReadResult } from '@herobids/domain';
import type { TradertonClient, TradertonClientResult, TradertonSubject } from '@herobids/domain/traderton';

// c4.9f: local trading-table schema dropped — these rows arrive from the
// Traderton read boundary, whose schema is byte-identical to the dropped
// herobids tables. These interfaces faithfully reproduce each column with the
// type `$inferSelect` would have produced: drizzle `text` → string (nullable →
// string | null), `numeric` → string, `timestamp` → Date, `jsonb` → its
// `$type`. The toFillRow/toJournalRow/toPositionRow mappers rehydrate the date
// columns (which arrive as ISO strings over JSON) back into Date objects.

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

/** The narrow read boundary the agent-export endpoints consume. */
export interface TradertonReadBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

/** Map a concrete L3a client result into the domain-clean read result. */
function mapClientResultToReadResult(result: TradertonClientResult): TradertonReadResult {
  switch (result.kind) {
    case 'success':
      return { kind: 'success', data: result.payload };
    case 'failure': {
      // The boundary dispatcher maps a tool's fault:false errorCode (e.g.
      // `not_found.resource`, raised by the owner-scoped bot tools for an
      // unowned/absent bot) onto the closed wire code `validation.invalid_payload`
      // and carries the ORIGINAL under `details.errorCode`. TradertonReadResult
      // has no `details` field, so unwrap it HERE: when the wire code is the
      // generic validation code and a tool errorCode is present, surface the
      // tool errorCode as `code` so the bot-export handlers' not_found.resource
      // → 404 mapping can fire. (Mirrors bots.ts `readBoundary`.)
      const toolCode = result.details?.['errorCode'];
      const code = result.code === 'validation.invalid_payload' && typeof toolCode === 'string'
        ? toolCode
        : result.code;
      return { kind: 'failure', code, message: result.message, retryable: result.retryable };
    }
    case 'in_progress':
      return { kind: 'in_progress' };
    case 'transport_error':
      return { kind: 'transport_error', message: result.message, retryable: true };
  }
}

/**
 * Build the read boundary adapter. The subject VALUES + per-request deadline are
 * bound here, so the caller only supplies a tool name + payload. A read is a
 * single synchronous invoke within `deadlineMs` — it does NOT poll.
 */
export function createTradertonReadBoundary(
  client: TradertonClient,
  subject: TradertonSubject,
  deadlineMs: number,
): TradertonReadBoundary {
  return {
    async invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult> {
      const result = await client.invoke({
        toolName: input.toolName,
        payload: input.payload,
        subject,
        deadlineMs,
      });
      return mapClientResultToReadResult(result);
    },
  };
}

// ── Row-shape narrowing + date rehydration ────────────────────────────────────

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

/** Narrow a boundary record into a fill row, rehydrating `filledAt` / `createdAt`. */
export function toFillRow(record: unknown): FillRow {
  const r = asRecord(record);
  return {
    ...r,
    filledAt: toDate(r['filledAt'], 'filledAt'),
    createdAt: toDate(r['createdAt'], 'createdAt'),
  } as FillRow;
}

/** Narrow a boundary record into a journal-event row, rehydrating `createdAt`. */
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

// ── Boundary → HTTP error mapping ─────────────────────────────────────────────

/**
 * A non-success read outcome, normalized into an HTTP status + error payload
 * shape. Mirrors the API's existing boundary-error conventions (setup.ts /
 * accounts.ts): a transport/in-progress precondition is a retryable 503; a
 * terminal boundary failure surfaces its `code` (default 502).
 */
export interface ReadBoundaryError {
  status: number;
  code: string;
  message: string;
}

/**
 * Invoke a read tool and narrow its success payload's array field. Returns the
 * narrowed rows on success, or a typed {@link ReadBoundaryError} for any
 * non-success outcome. Never returns an empty array to mask a failure.
 */
export async function loadAgentEvidence<T>(
  boundary: TradertonReadBoundary,
  toolName: string,
  payload: unknown,
  arrayKey: string,
  mapRow: (record: unknown) => T,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: ReadBoundaryError }> {
  const result = await boundary.invoke({ toolName, payload });
  switch (result.kind) {
    case 'success': {
      const data = result.data;
      if (typeof data !== 'object' || data === null) {
        throw new Error(`Boundary tool ${toolName} returned a non-object payload`);
      }
      const arr = (data as Record<string, unknown>)[arrayKey];
      if (!Array.isArray(arr)) {
        throw new Error(`Boundary tool ${toolName} payload missing "${arrayKey}" array`);
      }
      return { ok: true, rows: arr.map(mapRow) };
    }
    default:
      return { ok: false, error: mapNonSuccessToError(result) };
  }
}

/**
 * Invoke a read tool that returns a single object payload (e.g.
 * `get_owner_bot_status`) and return the whole record on success, or a typed
 * {@link ReadBoundaryError} for any non-success outcome. Used where the caller
 * needs a scalar field (like `config`) rather than an evidence array.
 */
export async function loadBoundaryObject(
  boundary: TradertonReadBoundary,
  toolName: string,
  payload: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: ReadBoundaryError }> {
  const result = await boundary.invoke({ toolName, payload });
  if (result.kind === 'success') {
    const data = result.data;
    if (typeof data !== 'object' || data === null) {
      throw new Error(`Boundary tool ${toolName} returned a non-object payload`);
    }
    return { ok: true, data: data as Record<string, unknown> };
  }
  return { ok: false, error: mapNonSuccessToError(result) };
}

/** Map any non-success read outcome to the HTTP-shaped {@link ReadBoundaryError}. */
export function mapNonSuccessToError(
  result: Exclude<TradertonReadResult, { kind: 'success' }>,
): ReadBoundaryError {
  switch (result.kind) {
    case 'failure':
      return { status: 502, code: result.code, message: result.message };
    case 'transport_error':
      return {
        status: 503,
        code: 'precondition.not_ready',
        message: 'Trading service is unavailable — the export could not be produced.',
      };
    case 'in_progress':
      return {
        status: 503,
        code: 'boundary.in_progress',
        message: 'The trading read did not complete in time. Please retry.',
      };
  }
}
