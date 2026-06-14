import { describe, expect, it } from 'vitest';
import { computeLiveTimeoutActions } from './live-timeout-manager.js';

describe('computeLiveTimeoutActions', () => {
  const nowMs = Date.parse('2026-06-14T22:00:00.000Z');

  it('returns cancel action for stale acknowledged limit order', () => {
    const actions = computeLiveTimeoutActions(
      [{
        id: 'ord-1',
        symbol: 'BTC/USD:USD',
        type: 'limit',
        status: 'open',
        venueRefId: 'venue-1',
        acknowledgedAt: '2026-06-14T21:56:00.000Z',
      }],
      { limitOrderTimeoutMs: 120_000, marketOrderTimeoutMs: 30_000 },
      nowMs,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'cancel_limit',
      orderId: 'ord-1',
      venueRefId: 'venue-1',
      reason: 'limit_order_timeout',
    });
  });

  it('returns recovery-required action for stale limit without venueRefId', () => {
    const actions = computeLiveTimeoutActions(
      [{
        id: 'ord-2',
        symbol: 'ETH/USD:USD',
        type: 'limit',
        status: 'pending',
        submitAttemptedAt: '2026-06-14T21:55:00.000Z',
      }],
      { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
      nowMs,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'mark_recovery_required',
      orderId: 'ord-2',
      reason: 'limit_order_timeout_no_venue_ref',
    });
  });

  it('returns recovery-required action for stale market order', () => {
    const actions = computeLiveTimeoutActions(
      [{
        id: 'ord-3',
        symbol: 'SOL/USD',
        type: 'market',
        status: 'open',
        venueRefId: 'venue-3',
        submitAttemptedAt: '2026-06-14T21:58:00.000Z',
      }],
      { limitOrderTimeoutMs: 120_000, marketOrderTimeoutMs: 30_000 },
      nowMs,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'mark_recovery_required',
      orderId: 'ord-3',
      reason: 'market_order_timeout',
    });
  });

  it('ignores terminal and non-stale orders', () => {
    const actions = computeLiveTimeoutActions(
      [
        {
          id: 'ord-4',
          symbol: 'BTC/USD:USD',
          type: 'limit',
          status: 'filled',
          venueRefId: 'venue-4',
          acknowledgedAt: '2026-06-14T21:00:00.000Z',
        },
        {
          id: 'ord-5',
          symbol: 'BTC/USD:USD',
          type: 'limit',
          status: 'open',
          venueRefId: 'venue-5',
          acknowledgedAt: '2026-06-14T21:59:30.000Z',
        },
      ],
      { limitOrderTimeoutMs: 120_000, marketOrderTimeoutMs: 30_000 },
      nowMs,
    );

    expect(actions).toEqual([]);
  });
});
