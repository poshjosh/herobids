import { describe, it, expect } from 'vitest';
import { MarketDataRecorder } from './market-data-recorder.js';
import { price } from '@herobids/domain';
import type { MarketSnapshot } from '@herobids/domain';

describe('MarketDataRecorder', () => {
  it('starts with zero pending events', () => {
    const recorder = new MarketDataRecorder('hyperliquid');
    expect(recorder.pendingCount).toBe(0);
  });

  it('records a ticker snapshot', () => {
    const recorder = new MarketDataRecorder('hyperliquid');
    const snapshot: MarketSnapshot = {
      symbol: 'BTC/USD:USD',
      price: price('50000'),
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { volume: 1000 },
    };

    recorder.recordSnapshot(snapshot);

    expect(recorder.pendingCount).toBe(1);
    const events = recorder.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      eventType: 'ticker',
      price: '50000',
      eventAt: new Date('2026-01-01T00:00:00.000Z'),
      data: { volume: 1000 },
    });
  });

  it('records a trade print', () => {
    const recorder = new MarketDataRecorder('jupiter');

    recorder.recordTrade('SOL/USDC', '150.25', '2026-01-01T12:00:00Z', { side: 'buy' });

    const events = recorder.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      venue: 'jupiter',
      symbol: 'SOL/USDC',
      eventType: 'trade',
      price: '150.25',
      eventAt: new Date('2026-01-01T12:00:00Z'),
      data: { side: 'buy' },
    });
  });

  it('records a mark price observation', () => {
    const recorder = new MarketDataRecorder('hyperliquid');

    recorder.recordMark('ETH/USD:USD', '3500', 'oracle', '2026-01-01T06:00:00Z');

    const events = recorder.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      venue: 'hyperliquid',
      symbol: 'ETH/USD:USD',
      eventType: 'mark',
      price: '3500',
      eventAt: new Date('2026-01-01T06:00:00Z'),
      data: { source: 'oracle' },
    });
  });

  it('accumulates multiple events in order', () => {
    const recorder = new MarketDataRecorder('hyperliquid');

    recorder.recordTrade('BTC/USD:USD', '50000', '2026-01-01T00:00:00Z');
    recorder.recordTrade('BTC/USD:USD', '50100', '2026-01-01T00:01:00Z');
    recorder.recordMark('BTC/USD:USD', '50050', 'oracle', '2026-01-01T00:01:30Z');

    expect(recorder.pendingCount).toBe(3);
    const events = recorder.flush();
    expect(events).toHaveLength(3);
    expect(events[0]!.price).toBe('50000');
    expect(events[1]!.price).toBe('50100');
    expect(events[2]!.eventType).toBe('mark');
  });

  it('flush resets the buffer', () => {
    const recorder = new MarketDataRecorder('hyperliquid');

    recorder.recordTrade('BTC/USD:USD', '50000', '2026-01-01T00:00:00Z');
    const first = recorder.flush();
    expect(first).toHaveLength(1);
    expect(recorder.pendingCount).toBe(0);

    const second = recorder.flush();
    expect(second).toHaveLength(0);
  });

  it('handles snapshot without optional data field', () => {
    const recorder = new MarketDataRecorder('hyperliquid');
    const snapshot: MarketSnapshot = {
      symbol: 'ETH/USD:USD',
      price: price('3000'),
      timestamp: '2026-01-01T00:00:00Z',
    };

    recorder.recordSnapshot(snapshot);
    const events = recorder.flush();
    expect(events[0]!.data).toBeUndefined();
  });

  it('handles trade without optional data field', () => {
    const recorder = new MarketDataRecorder('hyperliquid');

    recorder.recordTrade('BTC/USD:USD', '50000', '2026-01-01T00:00:00Z');

    const events = recorder.flush();
    expect(events[0]!.data).toBeUndefined();
  });

  it('preserves venue across all event types', () => {
    const recorder = new MarketDataRecorder('custom-venue');
    const snapshot: MarketSnapshot = {
      symbol: 'SOL/USD',
      price: price('150'),
      timestamp: '2026-01-01T00:00:00Z',
    };

    recorder.recordSnapshot(snapshot);
    recorder.recordTrade('SOL/USD', '150.5', '2026-01-01T00:01:00Z');
    recorder.recordMark('SOL/USD', '150.3', 'last_fill', '2026-01-01T00:02:00Z');

    const events = recorder.flush();
    expect(events.every((e) => e.venue === 'custom-venue')).toBe(true);
  });
});
