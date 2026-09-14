import { describe, it, expect } from 'vitest';
import { toFillRow, toJournalRow, toPositionRow } from './evidence-row-mappers.js';

describe('evidence-row-mappers — date rehydration', () => {
  it('rehydrates fill date columns (filledAt, createdAt) from ISO strings', () => {
    const row = toFillRow({
      id: 'f1',
      orderId: 'o1',
      side: 'buy',
      quantity: '1.5',
      price: '100.25',
      fee: '0.1',
      filledAt: '2026-07-19T12:00:00.000Z',
      createdAt: '2026-07-19T12:00:01.000Z',
    });

    expect(row.filledAt).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.filledAt.toISOString()).toBe('2026-07-19T12:00:00.000Z');
    // Numeric/decimal columns stay strings
    expect(row.quantity).toBe('1.5');
    expect(row.price).toBe('100.25');
  });

  it('rehydrates journal createdAt from an ISO string', () => {
    const row = toJournalRow({
      id: 'j1',
      type: 'order.filled',
      payload: { foo: 'bar' },
      createdAt: '2026-07-19T12:00:00.000Z',
    });

    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.createdAt.toISOString()).toBe('2026-07-19T12:00:00.000Z');
    expect(row.payload).toEqual({ foo: 'bar' });
  });

  it('rehydrates position openedAt/updatedAt and non-null closedAt', () => {
    const row = toPositionRow({
      id: 'p1',
      symbol: 'BTC',
      side: 'long',
      size: '2',
      entryPrice: '50000',
      realizedPnl: '100',
      openedAt: '2026-07-19T10:00:00.000Z',
      closedAt: '2026-07-19T11:00:00.000Z',
      updatedAt: '2026-07-19T11:00:00.000Z',
    });

    expect(row.openedAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.closedAt).toBeInstanceOf(Date);
    expect(row.closedAt!.toISOString()).toBe('2026-07-19T11:00:00.000Z');
  });

  it('keeps a null closedAt as null (open position)', () => {
    const row = toPositionRow({
      id: 'p2',
      symbol: 'ETH',
      side: 'short',
      size: '1',
      entryPrice: '3000',
      realizedPnl: '0',
      openedAt: '2026-07-19T10:00:00.000Z',
      closedAt: null,
      updatedAt: '2026-07-19T10:00:00.000Z',
    });

    expect(row.closedAt).toBeNull();
    expect(row.openedAt).toBeInstanceOf(Date);
  });

  it('passes additive Traderton columns through harmlessly', () => {
    const row = toFillRow({
      id: 'f2',
      orderId: 'o2',
      side: 'sell',
      quantity: '1',
      price: '100',
      realizedPnlDelta: '5.5',
      filledAt: '2026-07-19T12:00:00.000Z',
      createdAt: '2026-07-19T12:00:00.000Z',
      // additive column that the row type does not name
      someTradertonExtra: 'kept',
    } as unknown as Record<string, unknown>);

    expect(row.realizedPnlDelta).toBe('5.5');
    expect((row as unknown as Record<string, unknown>)['someTradertonExtra']).toBe('kept');
  });

  it('throws on a missing required date field', () => {
    expect(() =>
      toFillRow({ id: 'f3', filledAt: '2026-07-19T12:00:00.000Z' }),
    ).toThrow(/createdAt/);
  });

  it('throws on a non-object row', () => {
    expect(() => toFillRow(null)).toThrow(/object row/);
  });

  // Parity contract (D1-c1): the artifact bytes must be byte-equivalent to the
  // pre-boundary path (DB Date → JSON.stringify → ISO). Since the boundary
  // already gives ISO strings, rehydrate→stringify must round-trip to the SAME
  // ISO strings. Assert the round-trip, not just toISOString() equality.
  it('round-trips to byte-equivalent JSON for each row type', () => {
    const fillIso = {
      id: 'f1', orderId: 'o1', side: 'buy', quantity: '1.5', price: '100.25',
      fee: '0.1', realizedPnlDelta: '5.5',
      filledAt: '2026-07-19T12:00:00.000Z', createdAt: '2026-07-19T12:00:01.000Z',
    };
    expect(JSON.parse(JSON.stringify(toFillRow(fillIso)))).toEqual(fillIso);

    const journalIso = {
      id: 'j1', type: 'order.filled', payload: { foo: 'bar' },
      createdAt: '2026-07-19T12:00:00.000Z',
    };
    expect(JSON.parse(JSON.stringify(toJournalRow(journalIso)))).toEqual(journalIso);

    const positionIso = {
      id: 'p1', symbol: 'BTC', side: 'long', size: '2', entryPrice: '50000',
      realizedPnl: '100', openedAt: '2026-07-19T10:00:00.000Z',
      closedAt: '2026-07-19T11:00:00.000Z', updatedAt: '2026-07-19T11:00:00.000Z',
    };
    expect(JSON.parse(JSON.stringify(toPositionRow(positionIso)))).toEqual(positionIso);
  });
});
