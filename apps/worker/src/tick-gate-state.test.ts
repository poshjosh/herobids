import { describe, expect, it } from 'vitest';
import { buildTickGateState } from './tick-gate-state.js';
import { computeDecisionContextHash } from './tick-gates.js';

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
        { type: 'agent.wake' },
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
      incomingMessages: [{ type: 'instance.journal.event', payload: { journalType: 'noop' } }],
      hasOpenPositions: true,
      lastKnownPositionSide: 'short',
    });

    expect(state.hasWakeSignal).toBe(false);
    expect(state.positionSide).toBe('short');
    expect(state.latestPrice).toBeNull();
    expect(state.portfolioPnlUsd).toBeNull();
  });

  it('sets hasWakeSignal true when a user.message is present so the tick is not skipped', () => {
    const state = buildTickGateState({
      tickNumber: 7,
      incomingMessages: [{ type: 'user.message', payload: { message: 'what is my pnl?' } }],
      hasOpenPositions: false,
      lastKnownPositionSide: null,
    });

    expect(state.hasWakeSignal).toBe(true);
  });

  it('sets hasWakeSignal true when an agent.user.message is present so the tick is not skipped', () => {
    const state = buildTickGateState({
      tickNumber: 7,
      incomingMessages: [{ type: 'agent.user.message', payload: { text: 'status?' } }],
      hasOpenPositions: true,
      lastKnownPositionSide: 'short',
    });

    expect(state.hasWakeSignal).toBe(true);
    // Position fallback still works alongside the wake flag.
    expect(state.positionSide).toBe('short');
  });

  it('aggregates multiple context snapshots from a reconnect batch', () => {
    const state = buildTickGateState({
      tickNumber: 3,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: {
            symbol: 'BTC/USD:USD',
            price: '50000',
            pnl: '100',
            position: { side: 'long', size: '0.5', entryPrice: '48000' },
          },
        },
        {
          type: 'instance.context.snapshot',
          payload: {
            symbol: 'ETH/USD:USD',
            price: '3200',
            pnl: '-20',
            position: { side: 'short', size: '5', entryPrice: '3300' },
          },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: null,
    });

    // Latest price comes from the last snapshot
    expect(state.latestPrice).toBe(3200);
    // PnL is summed across all snapshots
    expect(state.portfolioPnlUsd).toBe(80);
    // Position side is the latest non-flat side seen
    expect(state.positionSide).toBe('short');
    expect(state.hasOpenPositions).toBe(true);
  });

  it('handles reconnect batch where one instrument is flat and another has a position', () => {
    const state = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: {
            symbol: 'BTC/USD:USD',
            price: '50000',
            position: null,
          },
        },
        {
          type: 'instance.context.snapshot',
          payload: {
            symbol: 'ETH/USD:USD',
            price: '3200',
            position: { side: 'long', size: '10', entryPrice: '3100' },
          },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: 'long',
    });

    // The second snapshot has a position, so positionSide should be 'long'
    expect(state.positionSide).toBe('long');
    expect(state.latestPrice).toBe(3200);
  });

  it('does not use position.realizedPnl as portfolio PnL — only top-level pnl counts', () => {
    const state = buildTickGateState({
      tickNumber: 4,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: {
            symbol: 'BTC/USD:USD',
            price: '50000',
            position: { side: 'long', size: '0.5', entryPrice: '48000', realizedPnl: '100' },
          },
        },
        {
          type: 'instance.context.snapshot',
          payload: {
            symbol: 'ETH/USD:USD',
            price: '3200',
            position: { side: 'short', size: '5', entryPrice: '3300', realizedPnl: '-20' },
          },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: null,
    });

    // position.realizedPnl must NOT flow into portfolioPnlUsd
    expect(state.portfolioPnlUsd).toBeNull();
    expect(state.positionSide).toBe('short');
    expect(state.latestPrice).toBe(3200);
  });

  it('produces instrument snapshots that are order-independent for hashing', () => {
    const btcFirst = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'BTC/USD:USD', price: '50000', pnl: '100', position: { side: 'long' } },
        },
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'ETH/USD:USD', price: '3200', pnl: '-20', position: { side: 'short' } },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: null,
    });

    const ethFirst = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'ETH/USD:USD', price: '3200', pnl: '-20', position: { side: 'short' } },
        },
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'BTC/USD:USD', price: '50000', pnl: '100', position: { side: 'long' } },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: null,
    });

    // Both states should produce the same context hash regardless of message order
    const hashA = computeDecisionContextHash({
      positionSide: btcFirst.positionSide,
      latestPrice: btcFirst.latestPrice,
      portfolioPnlUsd: btcFirst.portfolioPnlUsd,
      regimePass: null,
      instrumentSnapshots: btcFirst.instrumentSnapshots,
    });
    const hashB = computeDecisionContextHash({
      positionSide: ethFirst.positionSide,
      latestPrice: ethFirst.latestPrice,
      portfolioPnlUsd: ethFirst.portfolioPnlUsd,
      regimePass: null,
      instrumentSnapshots: ethFirst.instrumentSnapshots,
    });

    expect(hashA).toBe(hashB);
  });

  it('detects price change in non-final instrument of multi-instrument batch', () => {
    const original = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'BTC/USD:USD', price: '50000', pnl: '100', position: { side: 'long' } },
        },
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'ETH/USD:USD', price: '3200', pnl: '-20', position: { side: 'short' } },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: null,
    });

    // BTC price changes significantly but ETH (final snapshot) stays the same
    const btcMoved = buildTickGateState({
      tickNumber: 2,
      incomingMessages: [
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'BTC/USD:USD', price: '55000', pnl: '500', position: { side: 'long' } },
        },
        {
          type: 'instance.context.snapshot',
          payload: { symbol: 'ETH/USD:USD', price: '3200', pnl: '-20', position: { side: 'short' } },
        },
      ],
      hasOpenPositions: true,
      lastKnownPositionSide: null,
    });

    const hashOriginal = computeDecisionContextHash({
      positionSide: original.positionSide,
      latestPrice: original.latestPrice,
      portfolioPnlUsd: original.portfolioPnlUsd,
      regimePass: null,
      instrumentSnapshots: original.instrumentSnapshots,
    });
    const hashMoved = computeDecisionContextHash({
      positionSide: btcMoved.positionSide,
      latestPrice: btcMoved.latestPrice,
      portfolioPnlUsd: btcMoved.portfolioPnlUsd,
      regimePass: null,
      instrumentSnapshots: btcMoved.instrumentSnapshots,
    });

    // Hash must differ because BTC price moved even though ETH (the final snapshot) didn't
    expect(hashOriginal).not.toBe(hashMoved);
  });

  it('passes watchSummaryDigest through to the returned TickGateState', () => {
    const digest = 'abc123def456';
    const state = buildTickGateState({
      tickNumber: 5,
      incomingMessages: [],
      hasOpenPositions: false,
      watchSummaryDigest: digest,
    });

    expect(state.watchSummaryDigest).toBe(digest);
  });

  it('leaves watchSummaryDigest undefined when not provided (backward compat)', () => {
    const state = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [],
      hasOpenPositions: false,
    });

    expect(state.watchSummaryDigest).toBeUndefined();
  });

  it('passes wakeSignalDigest through to the returned TickGateState', () => {
    const digest = 'def456abc789';
    const state = buildTickGateState({
      tickNumber: 5,
      incomingMessages: [],
      hasOpenPositions: false,
      wakeSignalDigest: digest,
    });

    expect(state.wakeSignalDigest).toBe(digest);
  });

  it('leaves wakeSignalDigest undefined when not provided (backward compat)', () => {
    const state = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [],
      hasOpenPositions: false,
    });

    expect(state.wakeSignalDigest).toBeUndefined();
  });

  it('passes both watchSummaryDigest and wakeSignalDigest simultaneously', () => {
    const state = buildTickGateState({
      tickNumber: 3,
      incomingMessages: [],
      hasOpenPositions: false,
      watchSummaryDigest: 'watch-hash',
      wakeSignalDigest: 'wake-hash',
    });

    expect(state.watchSummaryDigest).toBe('watch-hash');
    expect(state.wakeSignalDigest).toBe('wake-hash');
  });

  it('passes riskPlaybookDigest through to the returned TickGateState', () => {
    const digest = 'risk-digest-abc123';
    const state = buildTickGateState({
      tickNumber: 5,
      incomingMessages: [],
      hasOpenPositions: false,
      riskPlaybookDigest: digest,
    });

    expect(state.riskPlaybookDigest).toBe(digest);
  });

  it('leaves riskPlaybookDigest undefined when not provided (backward compat)', () => {
    const state = buildTickGateState({
      tickNumber: 1,
      incomingMessages: [],
      hasOpenPositions: false,
    });

    expect(state.riskPlaybookDigest).toBeUndefined();
  });

  it('passes all three digests simultaneously', () => {
    const state = buildTickGateState({
      tickNumber: 3,
      incomingMessages: [],
      hasOpenPositions: false,
      watchSummaryDigest: 'watch-hash',
      wakeSignalDigest: 'wake-hash',
      riskPlaybookDigest: 'risk-hash',
    });

    expect(state.watchSummaryDigest).toBe('watch-hash');
    expect(state.wakeSignalDigest).toBe('wake-hash');
    expect(state.riskPlaybookDigest).toBe('risk-hash');
  });

  it('sets hasWakeSignal true when hasBufferedWake is true even with no agent.wake in incomingMessages', () => {
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
      ],
      hasOpenPositions: false,
      lastKnownPositionSide: 'long',
      hasBufferedWake: true,
    });

    // The wake group consumed the agent.wake, so incomingMessages has none,
    // but a wake was drained from the buffer → hasWakeSignal must be true.
    expect(state.hasWakeSignal).toBe(true);
  });

  it('keeps hasWakeSignal false when hasBufferedWake is false and no agent.wake is present', () => {
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
      ],
      hasOpenPositions: false,
      lastKnownPositionSide: 'long',
      hasBufferedWake: false,
    });

    expect(state.hasWakeSignal).toBe(false);
  });

  it('keeps hasWakeSignal true when hasBufferedWake is false but an agent.wake is present', () => {
    const state = buildTickGateState({
      tickNumber: 2,
      incomingMessages: [{ type: 'agent.wake' }],
      hasOpenPositions: false,
      hasBufferedWake: false,
    });

    expect(state.hasWakeSignal).toBe(true);
  });
});
