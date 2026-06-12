import { describe, expect, it } from 'vitest';
import { buildTickGateState } from './tick-gate-state.js';

describe('buildTickGateState', () => {
  it('threads wake messages into shouldSkipTick state while preserving the previous hash', () => {
    const state = buildTickGateState({
      tickNumber: 2,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: {
            price: '100.5 USD',
            pnl: '-12.25',
            position: null,
          },
        },
        { type: 'agent.market.wake' },
      ],
      hasOpenPositions: false,
      lastKnownPositionSide: 'long',
      now: new Date('2026-06-12T08:21:01.000Z'),
      previousContextHash: 'previous-hash',
      baseTickIntervalMs: 900_000,
      currentTickIntervalMs: 60_000,
      enabledGates: { contextHash: true },
    });

    expect(state).toMatchObject({
      tickNumber: 2,
      hasOpenPositions: false,
      hasWakeSignal: true,
      positionSide: 'flat',
      latestPrice: 100.5,
      portfolioPnlUsd: -12.25,
      previousContextHash: 'previous-hash',
    });
  });

  it('falls back to the last known position side when no snapshot is present', () => {
    const state = buildTickGateState({
      tickNumber: 7,
      incomingMessages: [{ type: 'agent.user.message', payload: { text: 'status?' } }],
      hasOpenPositions: true,
      lastKnownPositionSide: 'short',
    });

    expect(state.hasWakeSignal).toBe(false);
    expect(state.positionSide).toBe('short');
    expect(state.latestPrice).toBeNull();
    expect(state.portfolioPnlUsd).toBeNull();
  });
});