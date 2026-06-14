import { describe, it, expect } from 'vitest';
import { reconcileWithThresholds } from './reconcile.js';
import type { LocalState, VenueState } from './reconcile.js';
import { Decimal } from '@herobids/domain';

function makeLocalState(overrides?: Partial<LocalState>): LocalState {
  return {
    positions: [],
    balances: [],
    recentFills: [],
    openOrders: [],
    ...overrides,
  };
}

function makeVenueState(overrides?: Partial<VenueState>): VenueState {
  return {
    positions: [],
    balances: { balances: [], timestamp: new Date().toISOString() },
    recentFills: [],
    openOrders: [],
    ...overrides,
  };
}

describe('drift category classification', () => {
  it('classifies position size mismatch as position_size_drift', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'long', size: new Decimal('0.5'), entryPrice: new Decimal('3000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'long', size: new Decimal('0.6'), entryPrice: new Decimal('3000') }],
    });

    const result = reconcileWithThresholds(local, venue, { positionSize: new Decimal('0.01') });
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBe('position_size_drift');
  });

  it('does NOT classify position side flip as position_size_drift', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'long', size: new Decimal('0.5'), entryPrice: new Decimal('3000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'short', size: new Decimal('0.5'), entryPrice: new Decimal('3000') }],
    });

    const result = reconcileWithThresholds(local, venue, {});
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBeUndefined();
  });

  it('does NOT classify missing position as position_size_drift', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'long', size: new Decimal('0.5'), entryPrice: new Decimal('3000') }],
    });
    const venue = makeVenueState({ positions: [] });

    const result = reconcileWithThresholds(local, venue, {});
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBeUndefined();
  });

  it('classifies balance mismatch as observed_balance_variance', () => {
    const local = makeLocalState({
      balances: [{ asset: 'USDC', total: new Decimal('1000') }],
    });
    const venue = makeVenueState({
      balances: {
        balances: [{ asset: 'USDC', free: new Decimal('995'), locked: new Decimal('0'), total: new Decimal('995') }],
        timestamp: new Date().toISOString(),
      },
    });

    const result = reconcileWithThresholds(local, venue, { balance: new Decimal('1') });
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBe('observed_balance_variance');
  });

  it('classifies large balance difference as observed_balance_variance', () => {
    const local = makeLocalState({
      balances: [{ asset: 'USDC', total: new Decimal('1000') }],
    });
    const venue = makeVenueState({
      balances: {
        balances: [{ asset: 'USDC', free: new Decimal('800'), locked: new Decimal('0'), total: new Decimal('800') }],
        timestamp: new Date().toISOString(),
      },
    });

    const result = reconcileWithThresholds(local, venue, { balance: new Decimal('1') });
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBe('observed_balance_variance');
  });

  it('classifies orphaned order as open_order_drift', () => {
    const local = makeLocalState();
    const venue = makeVenueState({
      openOrders: [{
        venueRefId: 'venue-123',
        symbol: 'ETH/USD:USD',
        side: 'buy' as const,
        type: 'limit',
        status: 'open',
        quantity: new Decimal('1'),
        price: new Decimal('2900'),
      }],
    });

    const result = reconcileWithThresholds(local, venue, {});
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBe('open_order_drift');
  });

  it('match status produces no categories', () => {
    const result = reconcileWithThresholds(makeLocalState(), makeVenueState(), {});
    expect(result.status).toBe('match');
    expect(result.diffs).toHaveLength(0);
  });

  it('does NOT classify balance mismatch as observed_balance_variance in authoritative mode', () => {
    const local = makeLocalState({
      balances: [{ asset: 'USDC', total: new Decimal('1000') }],
    });
    const venue = makeVenueState({
      balances: {
        balances: [{ asset: 'USDC', free: new Decimal('995'), locked: new Decimal('0'), total: new Decimal('995') }],
        timestamp: new Date().toISOString(),
      },
    });

    const result = reconcileWithThresholds(local, venue, { balance: new Decimal('1'), venueAccountingMode: 'authoritative' });
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]?.category).toBeUndefined();
  });
});
