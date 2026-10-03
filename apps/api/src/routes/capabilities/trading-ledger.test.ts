import { describe, it, expect } from 'vitest';
import { Decimal } from '@herobids/domain';
import type { FillRow, PositionRow } from '../exports-traderton.js';
import {
  formatSignedPnl,
  formatDecimal,
  pnlEmphasis,
  indexFillsByPositionKey,
  findClosingFill,
  closedTradeDetails,
  holdMsOf,
  formatDuration,
  summarizeTrades,
} from './trading-ledger.js';

// ── Row factories ─────────────────────────────────────────────────────────
// Minimal builders producing the real exports-traderton row shapes with Date
// objects for timestamps. Overrides let each test shape only the fields it
// cares about.

function makePosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: 'pos-1',
    venueAccountId: 'va-1',
    actorType: 'agent',
    actorId: 'agent-1',
    venue: 'hyperliquid',
    symbol: 'BTC',
    instrumentId: null,
    side: 'long',
    size: '0.5',
    entryPrice: '100',
    realizedPnl: '0',
    markSource: null,
    exitReason: null,
    stopLoss: null,
    takeProfit: null,
    openedAt: new Date('2026-01-01T00:00:00.000Z'),
    closedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeFill(overrides: Partial<FillRow> = {}): FillRow {
  return {
    id: 'fill-1',
    orderId: 'order-1',
    venueAccountId: 'va-1',
    actorType: 'agent',
    actorId: 'agent-1',
    venueRefId: null,
    venue: 'hyperliquid',
    symbol: 'BTC',
    side: 'sell',
    quantity: '0.5',
    price: '110',
    fee: null,
    feeCurrency: null,
    realizedPnlDelta: null,
    filledAt: new Date('2026-01-01T01:00:00.000Z'),
    createdAt: new Date('2026-01-01T01:00:00.000Z'),
    ...overrides,
  };
}

describe('formatSignedPnl', () => {
  it('formats a positive value rounded to 2dp with a leading plus', () => {
    expect(formatSignedPnl('12.345')).toEqual({ value: '+12.35', emphasis: 'positive' });
  });

  it('formats a negative value to 2dp with the minus kept in the text', () => {
    expect(formatSignedPnl('-20')).toEqual({ value: '-20.00', emphasis: 'negative' });
  });

  it('renders a sub-cent negative as a neutral 0.00 rather than a red -0.00', () => {
    expect(formatSignedPnl('-0.004')).toEqual({ value: '0.00', emphasis: 'neutral' });
  });

  it('renders the em-dash placeholder with neutral emphasis for a null value', () => {
    expect(formatSignedPnl(null)).toEqual({ value: '—', emphasis: 'neutral' });
  });
});

describe('formatDecimal', () => {
  it('keeps full precision without an exponent for very small values', () => {
    expect(formatDecimal('0.00000012')).toBe('0.00000012');
  });

  it('trims trailing zeros', () => {
    expect(formatDecimal('1.5000')).toBe('1.5');
  });

  it('renders the em-dash placeholder for a null value', () => {
    expect(formatDecimal(null)).toBe('—');
  });
});

describe('pnlEmphasis', () => {
  it('reads emphasis from the 2dp-rounded value', () => {
    expect(pnlEmphasis('0.004')).toBe('neutral');
    expect(pnlEmphasis('0.005')).toBe('positive');
    expect(pnlEmphasis('-0.005')).toBe('negative');
    expect(pnlEmphasis(null)).toBe('neutral');
  });
});

describe('indexFillsByPositionKey and findClosingFill', () => {
  it('selects the latest fill with filledAt at or before closedAt', () => {
    const closedAt = new Date('2026-01-01T05:00:00.000Z');
    const position = makePosition({ closedAt });
    const early = makeFill({ id: 'early', filledAt: new Date('2026-01-01T02:00:00.000Z') });
    const latest = makeFill({ id: 'latest', filledAt: new Date('2026-01-01T04:30:00.000Z') });
    const afterClose = makeFill({ id: 'after', filledAt: new Date('2026-01-01T06:00:00.000Z') });

    const index = indexFillsByPositionKey([early, latest, afterClose]);
    const closing = findClosingFill(position, index);

    expect(closing?.id).toBe('latest');
  });

  it('returns null when no fill matches the position key', () => {
    const position = makePosition({ closedAt: new Date('2026-01-01T05:00:00.000Z'), symbol: 'ETH' });
    const index = indexFillsByPositionKey([makeFill({ symbol: 'BTC' })]);

    expect(findClosingFill(position, index)).toBeNull();
  });

  it('returns null for an open position regardless of fills', () => {
    const position = makePosition({ closedAt: null });
    const index = indexFillsByPositionKey([makeFill()]);

    expect(findClosingFill(position, index)).toBeNull();
  });
});

describe('closedTradeDetails', () => {
  it('infers a long trade from a sell closing fill', () => {
    const position = makePosition({ closedAt: new Date('2026-01-01T05:00:00.000Z') });
    const index = indexFillsByPositionKey([makeFill({ side: 'sell', price: '110' })]);

    expect(closedTradeDetails(position, index)).toEqual({ exitPrice: '110', direction: 'long' });
  });

  it('infers a short trade from a buy closing fill', () => {
    const position = makePosition({ closedAt: new Date('2026-01-01T05:00:00.000Z') });
    const index = indexFillsByPositionKey([makeFill({ side: 'buy', price: '90' })]);

    expect(closedTradeDetails(position, index)).toEqual({ exitPrice: '90', direction: 'short' });
  });

  it('returns both null when no closing fill matches', () => {
    const position = makePosition({ closedAt: new Date('2026-01-01T05:00:00.000Z'), symbol: 'ETH' });
    const index = indexFillsByPositionKey([makeFill({ symbol: 'BTC' })]);

    expect(closedTradeDetails(position, index)).toEqual({ exitPrice: null, direction: null });
  });
});

describe('holdMsOf', () => {
  it('uses closedAt minus openedAt for a closed position', () => {
    const position = makePosition({
      openedAt: new Date('2026-01-01T00:00:00.000Z'),
      closedAt: new Date('2026-01-01T01:00:00.000Z'),
    });

    expect(holdMsOf(position, new Date('2026-01-01T09:00:00.000Z'))).toBe(3_600_000);
  });

  it('uses now minus openedAt for an open position', () => {
    const position = makePosition({
      openedAt: new Date('2026-01-01T00:00:00.000Z'),
      closedAt: null,
    });

    expect(holdMsOf(position, new Date('2026-01-01T02:00:00.000Z'))).toBe(7_200_000);
  });
});

describe('formatDuration', () => {
  it('buckets a sub-minute duration into lessThanMinute with an English fallback', () => {
    const cell = formatDuration(30_000);
    expect(cell.valueKey).toBe('capability.trading.duration.lessThanMinute');
    expect(cell.valueParams).toBeUndefined();
    expect(cell.value).toBe('<1m');
  });

  it('buckets a sub-hour duration into minutes with params', () => {
    const cell = formatDuration(5 * 60_000);
    expect(cell.valueKey).toBe('capability.trading.duration.minutes');
    expect(cell.valueParams).toEqual({ minutes: '5' });
    expect(cell.value).toBe('5m');
  });

  it('buckets a sub-day duration into hoursMinutes with params', () => {
    const cell = formatDuration(2 * 3_600_000 + 15 * 60_000);
    expect(cell.valueKey).toBe('capability.trading.duration.hoursMinutes');
    expect(cell.valueParams).toEqual({ hours: '2', minutes: '15' });
    expect(cell.value).toBe('2h 15m');
  });

  it('buckets a multi-day duration into daysHours with params', () => {
    const cell = formatDuration(3 * 86_400_000 + 4 * 3_600_000);
    expect(cell.valueKey).toBe('capability.trading.duration.daysHours');
    expect(cell.valueParams).toEqual({ days: '3', hours: '4' });
    expect(cell.value).toBe('3d 4h');
  });
});

describe('summarizeTrades', () => {
  it('sums realized P&L across closed rows and counts open/closed', () => {
    const rows = [
      makePosition({ id: 'c1', closedAt: new Date('2026-01-02T00:00:00.000Z'), realizedPnl: '12.34' }),
      makePosition({ id: 'c2', closedAt: new Date('2026-01-02T00:00:00.000Z'), realizedPnl: '-20' }),
      makePosition({ id: 'o1', closedAt: null, unrealizedPnl: '5' }),
    ];

    const summary = summarizeTrades(rows);

    expect(summary.realized.toFixed(2)).toBe('-7.66');
    expect(summary.closed).toBe(2);
    expect(summary.openCount).toBe(1);
  });

  it('counts a closed row as a win only when rounded realized is strictly positive', () => {
    const rows = [
      makePosition({ id: 'c1', closedAt: new Date('2026-01-02T00:00:00.000Z'), realizedPnl: '12.34' }),
      makePosition({ id: 'c2', closedAt: new Date('2026-01-02T00:00:00.000Z'), realizedPnl: '0.004' }),
      makePosition({ id: 'c3', closedAt: new Date('2026-01-02T00:00:00.000Z'), realizedPnl: '-5' }),
    ];

    const summary = summarizeTrades(rows);

    expect(summary.wins).toBe(1);
    expect(summary.closed).toBe(3);
  });

  it('sums unrealized P&L across open rows when all have a mark', () => {
    const rows = [
      makePosition({ id: 'o1', closedAt: null, unrealizedPnl: '5' }),
      makePosition({ id: 'o2', closedAt: null, unrealizedPnl: '2.5' }),
    ];

    const summary = summarizeTrades(rows);

    expect(summary.unrealized).not.toBeNull();
    expect((summary.unrealized as Decimal).toFixed(2)).toBe('7.50');
  });

  it('reports unrealized as null when any open row lacks a mark', () => {
    const rows = [
      makePosition({ id: 'o1', closedAt: null, unrealizedPnl: '5' }),
      makePosition({ id: 'o2', closedAt: null, unrealizedPnl: null }),
    ];

    expect(summarizeTrades(rows).unrealized).toBeNull();
  });
});
