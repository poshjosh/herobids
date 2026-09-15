import { describe, it, expect, vi } from 'vitest';
import { createBoundaryTradeEventFeed } from './boundary-trade-event-feed.js';
import type { TradertonReadBoundary } from '../traderton/read-adapter.js';
import type { TradertonReadResult } from '@herobids/domain';

function makeBoundary(result: TradertonReadResult): TradertonReadBoundary & { invoke: ReturnType<typeof vi.fn> } {
  return { invoke: vi.fn().mockResolvedValue(result) };
}

describe('boundary trade-event feed adapter (c4.9j)', () => {
  it('scanAfter: sends Date cursor as ISO, threads typePrefixes/limit, rehydrates createdAt to Date', async () => {
    const boundary = makeBoundary({
      kind: 'success',
      data: { ok: true, events: [{ id: 'ev-1', botId: 'b1', actorId: 'a1', type: 'risk.breach', payload: { x: 1 }, createdAt: '2026-01-01T00:00:00.000Z' }] },
    });
    const feed = createBoundaryTradeEventFeed(boundary);

    const rows = await feed.scanAfter({
      cursor: { createdAt: new Date('2026-01-01T00:00:00.000Z'), seenIds: ['ev-0'] },
      typePrefixes: ['risk.', 'execution.failure'],
      limit: 50,
    });

    // Outbound payload: cursor createdAt is a Date→ISO string; the rest thread through.
    expect(boundary.invoke).toHaveBeenCalledWith({
      toolName: 'scan_trade_events',
      payload: {
        cursor: { createdAt: '2026-01-01T00:00:00.000Z', seenIds: ['ev-0'] },
        typePrefixes: ['risk.', 'execution.failure'],
        limit: 50,
      },
    });
    // Inbound row: createdAt is rehydrated ISO→Date.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(rows[0]!.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]!.id).toBe('ev-1');
    expect(rows[0]!.type).toBe('risk.breach');
  });

  it('scanAfter: omits cursor when undefined', async () => {
    const boundary = makeBoundary({ kind: 'success', data: { ok: true, events: [] } });
    const feed = createBoundaryTradeEventFeed(boundary);

    await feed.scanAfter({ limit: 10 });

    expect(boundary.invoke).toHaveBeenCalledWith({
      toolName: 'scan_trade_events',
      payload: { cursor: undefined, typePrefixes: undefined, limit: 10 },
    });
  });

  it('getByIds: threads ids, rehydrates createdAt', async () => {
    const boundary = makeBoundary({
      kind: 'success',
      data: { ok: true, events: [{ id: 'ev-1', type: 'risk.breach', payload: {}, actorId: null, createdAt: '2026-02-01T00:00:00.000Z' }] },
    });
    const feed = createBoundaryTradeEventFeed(boundary);

    const rows = await feed.getByIds(['ev-1', 'ev-2']);

    expect(boundary.invoke).toHaveBeenCalledWith({ toolName: 'get_events_by_ids', payload: { ids: ['ev-1', 'ev-2'] } });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('getById: returns a rehydrated row, or null when the event is absent', async () => {
    const present = makeBoundary({
      kind: 'success',
      data: { ok: true, event: { id: 'ev-1', type: 'risk.breach', payload: {}, actorId: null, createdAt: '2026-03-01T00:00:00.000Z' } },
    });
    const feedPresent = createBoundaryTradeEventFeed(present);
    const row = await feedPresent.getById('ev-1');
    expect(present.invoke).toHaveBeenCalledWith({ toolName: 'get_event_by_id', payload: { id: 'ev-1' } });
    expect(row?.createdAt).toBeInstanceOf(Date);

    const absent = makeBoundary({ kind: 'success', data: { ok: true, event: null } });
    const feedAbsent = createBoundaryTradeEventFeed(absent);
    expect(await feedAbsent.getById('missing')).toBeNull();
  });

  it('throws (does NOT return []) on failure so the tick reschedules without advancing the cursor', async () => {
    const feed = createBoundaryTradeEventFeed(
      makeBoundary({ kind: 'failure', code: 'upstream.transient', message: 'nope', retryable: true }),
    );
    await expect(feed.scanAfter({ limit: 10 })).rejects.toThrow(/scan_trade_events failed/);
  });

  it('throws on transport_error', async () => {
    const feed = createBoundaryTradeEventFeed(
      makeBoundary({ kind: 'transport_error', message: 'timeout', retryable: true }),
    );
    await expect(feed.getByIds(['ev-1'])).rejects.toThrow(/transport error/);
  });

  it('throws on in_progress', async () => {
    const feed = createBoundaryTradeEventFeed(makeBoundary({ kind: 'in_progress' }));
    await expect(feed.getById('ev-1')).rejects.toThrow(/in_progress/);
  });
});
