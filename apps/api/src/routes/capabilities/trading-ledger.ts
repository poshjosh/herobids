/**
 * Shared, pure ledger helpers for the trading capability routes.
 *
 * These derive the display strings + semantic emphasis the presentation
 * contract carries (ADR 014): the web renders values verbatim and only acts on
 * `emphasis`. All number work goes through `Decimal` (no `parseFloat`, no
 * floating point) so rounding/sign are exact.
 *
 * The module owns NO trading logic beyond formatting and the closing-fill
 * reconstruction the legacy `/positions` route already performed in-app.
 *
 * Fail-soft is deliberate: the formatters receive values that were already
 * validated at the traderton read boundary, so a malformed numeric here means a
 * broken upstream contract, not user input. Rather than fail the whole
 * presentation read we render the em-dash placeholder with neutral emphasis —
 * the ADR 014 "unavailable, not guessed" posture. Callers never see a throw.
 */

import { Decimal } from '@herobids/domain';
import type { FillRow, PositionRow } from '../exports-traderton.js';
import type { CapabilityCell, CapabilityPresentationEmphasis } from './presentation.js';

/** The em-dash placeholder shown when a value is absent. */
const EMDASH = '—';

/**
 * Server-derived emphasis from a signed P&L value — the web must NOT compute
 * signs. Uses the value rounded to 2dp so a sub-cent negative that displays as
 * `0.00` reads as neutral (not a red `-0.00`).
 */
export function pnlEmphasis(value: string | null | undefined): CapabilityPresentationEmphasis {
  if (value === null || value === undefined) return 'neutral';
  let rounded: Decimal;
  try {
    rounded = new Decimal(value).toDecimalPlaces(2);
  } catch {
    return 'neutral';
  }
  if (rounded.isZero()) return 'neutral';
  return rounded.isPositive() ? 'positive' : 'negative';
}

/**
 * Format a signed P&L: round to 2dp, then sign (`+12.34`, `-20.00`). A rounded
 * zero is `0.00` with neutral emphasis (no `-0.00`). No currency symbol — the
 * sign stays in the text so colour is not the only cue (WCAG 1.4.1). `null` →
 * the em-dash placeholder with neutral emphasis.
 */
export function formatSignedPnl(value: string | null): { value: string; emphasis: CapabilityPresentationEmphasis } {
  if (value === null) return { value: EMDASH, emphasis: 'neutral' };
  let rounded: Decimal;
  try {
    rounded = new Decimal(value).toDecimalPlaces(2);
  } catch {
    return { value: EMDASH, emphasis: 'neutral' };
  }
  const fixed = rounded.toFixed(2);
  if (rounded.isZero()) return { value: `0.00`, emphasis: 'neutral' };
  const text = rounded.isPositive() ? `+${fixed}` : fixed;
  return { value: text, emphasis: rounded.isPositive() ? 'positive' : 'negative' };
}

/**
 * Format a price/size at full precision: no exponent, trailing zeros trimmed
 * (`new Decimal(v).toFixed()`). `null` → the em-dash placeholder.
 */
export function formatDecimal(value: string | null): string {
  if (value === null) return EMDASH;
  try {
    return new Decimal(value).toFixed();
  } catch {
    return EMDASH;
  }
}

/** The composite key correlating a position to its fills. */
function positionKey(parts: {
  actorType: string;
  actorId: string | null;
  venueAccountId: string;
  venue: string;
  symbol: string;
}): string {
  return [parts.actorType, parts.actorId ?? '', parts.venueAccountId, parts.venue, parts.symbol].join('|');
}

/**
 * Index fills by their position key (`actorType|actorId|venueAccountId|venue|symbol`),
 * avoiding the O(P×F) scan the legacy route did per position.
 */
export function indexFillsByPositionKey(fills: FillRow[]): Map<string, FillRow[]> {
  const index = new Map<string, FillRow[]>();
  for (const fill of fills) {
    const key = positionKey(fill);
    const bucket = index.get(key);
    if (bucket) bucket.push(fill);
    else index.set(key, [fill]);
  }
  return index;
}

/**
 * The closing fill for a position: the latest fill (by `filledAt`) matching the
 * position's actor/venueAccount/venue/symbol with `filledAt <= closedAt`. Only
 * closed positions have one. This is the exact predicate the legacy route's
 * `exitPriceFor` used.
 */
export function findClosingFill(position: PositionRow, fillIndex: Map<string, FillRow[]>): FillRow | null {
  if (position.closedAt === null) return null;
  const closedAtMs = position.closedAt.getTime();
  const candidates = fillIndex.get(positionKey(position));
  if (!candidates) return null;
  let latest: FillRow | null = null;
  for (const fill of candidates) {
    if (fill.filledAt.getTime() <= closedAtMs) {
      if (latest === null || fill.filledAt.getTime() > latest.filledAt.getTime()) {
        latest = fill;
      }
    }
  }
  return latest;
}

/**
 * Exit price + direction for a closed trade (Decision 7). On full close the
 * position row has `side:'flat'`/`size:'0'`, so direction is inferred from the
 * closing fill: a `sell` closing fill → the trade was `long`; a `buy` → `short`.
 * No matching fill → both null.
 */
export function closedTradeDetails(
  position: PositionRow,
  fillIndex: Map<string, FillRow[]>,
): { exitPrice: string | null; direction: 'long' | 'short' | null } {
  const closingFill = findClosingFill(position, fillIndex);
  if (closingFill === null) return { exitPrice: null, direction: null };
  const side = closingFill.side.toLowerCase();
  const direction = side === 'sell' ? 'long' : side === 'buy' ? 'short' : null;
  return { exitPrice: closingFill.price, direction };
}

/**
 * Hold time in milliseconds. Closed trades: `closedAt − openedAt`. Open trades:
 * `now − openedAt` (refreshed each request).
 */
export function holdMsOf(position: PositionRow, now: Date): number {
  const end = position.closedAt ?? now;
  return end.getTime() - position.openedAt.getTime();
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Format a duration into a `CapabilityCell` with a stable `valueKey`, params,
 * and an English fallback in `value`. The i18n catalog keys are added in a
 * later item; the fallback keeps the contract renderable without them.
 */
export function formatDuration(ms: number): CapabilityCell {
  if (ms < MS_PER_MINUTE) {
    return { value: '<1m', valueKey: 'capability.trading.duration.lessThanMinute' };
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    return {
      value: `${minutes}m`,
      valueKey: 'capability.trading.duration.minutes',
      valueParams: { minutes: String(minutes) },
    };
  }
  if (ms < MS_PER_DAY) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
    return {
      value: `${hours}h ${minutes}m`,
      valueKey: 'capability.trading.duration.hoursMinutes',
      valueParams: { hours: String(hours), minutes: String(minutes) },
    };
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  return {
    value: `${days}d ${hours}h`,
    valueKey: 'capability.trading.duration.daysHours',
    valueParams: { days: String(days), hours: String(hours) },
  };
}

/**
 * A position row carrying the opt-in mark fields `get_agent_positions`
 * returns under `includeMarks`. Closed rows carry nulls.
 */
export type MarkablePositionRow = PositionRow & {
  unrealizedPnl?: string | null;
};

export type TradesSummary = {
  realized: Decimal;
  unrealized: Decimal | null;
  wins: number;
  closed: number;
  openCount: number;
};

/**
 * Summarize a set of positions into realized/unrealized totals + win/closed
 * counts. `unrealized` is null if ANY open row lacks `unrealizedPnl` (never
 * present a partial sum as the total). Wins = closed rows whose realized P&L,
 * rounded to 2dp, is positive.
 */
export function summarizeTrades(rows: MarkablePositionRow[]): TradesSummary {
  let realized = new Decimal(0);
  let unrealized: Decimal | null = new Decimal(0);
  let wins = 0;
  let closed = 0;
  let openCount = 0;

  for (const row of rows) {
    const isClosed = row.closedAt !== null;
    if (isClosed) {
      closed += 1;
      const realizedDec = new Decimal(row.realizedPnl);
      realized = realized.plus(realizedDec);
      if (realizedDec.toDecimalPlaces(2).isPositive() && !realizedDec.toDecimalPlaces(2).isZero()) {
        wins += 1;
      }
    } else {
      openCount += 1;
      const mark = row.unrealizedPnl;
      if (mark === null || mark === undefined) {
        unrealized = null;
      } else if (unrealized !== null) {
        unrealized = unrealized.plus(new Decimal(mark));
      }
    }
  }

  return { realized, unrealized, wins, closed, openCount };
}
