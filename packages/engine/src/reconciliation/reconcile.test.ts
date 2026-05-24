import { describe, it, expect } from 'vitest';
import { Decimal } from '@herobids/domain';
import { reconcile, reconcileWithThresholds } from './reconcile.js';
import type { LocalState, VenueState } from './reconcile.js';
import type { Position, BalanceSnapshot, VenueFill, VenueOrder } from '@herobids/domain';

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

describe('reconcile', () => {
  it('returns match when both states are empty', () => {
    const result = reconcile(makeLocalState(), makeVenueState());
    expect(result.status).toBe('match');
    expect(result.diffs).toHaveLength(0);
  });

  it('returns match when positions are equal', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1.5'), entryPrice: new Decimal('50000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1.5'), entryPrice: new Decimal('50000') }] as Position[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('match');
    expect(result.diffs).toHaveLength(0);
  });

  it('detects position side mismatch', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1'), entryPrice: new Decimal('50000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'short', size: new Decimal('1'), entryPrice: new Decimal('50000') }] as Position[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.type).toBe('position_mismatch');
    expect(result.diffs[0]!.description).toContain('side mismatch');
  });

  it('detects position size mismatch', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'long', size: new Decimal('10'), entryPrice: new Decimal('3000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'ETH/USD:USD', side: 'long', size: new Decimal('8'), entryPrice: new Decimal('3000') }] as Position[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.type).toBe('position_mismatch');
    expect(result.diffs[0]!.description).toContain('size mismatch');
  });

  it('detects local position not on venue', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1'), entryPrice: new Decimal('50000') }],
    });
    const venue = makeVenueState({ positions: [] });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]!.type).toBe('position_mismatch');
    expect(result.diffs[0]!.description).toContain('venue has no position');
  });

  it('detects venue position not in local', () => {
    const local = makeLocalState({ positions: [] });
    const venue = makeVenueState({
      positions: [{ symbol: 'SOL/USD:USD', side: 'short', size: new Decimal('100'), entryPrice: new Decimal('150') }] as Position[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0]!.type).toBe('position_mismatch');
    expect(result.diffs[0]!.description).toContain('local has no position');
  });

  it('detects balance mismatch', () => {
    const local = makeLocalState({
      balances: [{ asset: 'USDC', total: new Decimal('10000') }],
    });
    const venue = makeVenueState({
      balances: {
        balances: [{ asset: 'USDC', free: new Decimal('8000'), locked: new Decimal('1000'), total: new Decimal('9000') }],
        timestamp: new Date().toISOString(),
      } as BalanceSnapshot,
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.type).toBe('balance_mismatch');
  });

  it('returns match when balances are equal', () => {
    const local = makeLocalState({
      balances: [{ asset: 'USDC', total: new Decimal('5000') }],
    });
    const venue = makeVenueState({
      balances: {
        balances: [{ asset: 'USDC', free: new Decimal('3000'), locked: new Decimal('2000'), total: new Decimal('5000') }],
        timestamp: new Date().toISOString(),
      } as BalanceSnapshot,
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('match');
  });

  it('detects unknown fills (venue fill not in local)', () => {
    const local = makeLocalState({ recentFills: [] });
    const venue = makeVenueState({
      recentFills: [{
        venueRefId: 'fill-xyz-123',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: new Decimal('0.5'),
        price: new Decimal('51000'),
        fee: new Decimal('0.1'),
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      }] as VenueFill[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.type).toBe('unknown_fill');
  });

  it('does not flag fills that exist in local', () => {
    const local = makeLocalState({
      recentFills: [{
        venueRefId: 'fill-abc-456',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: new Decimal('1'),
        price: new Decimal('50000'),
        filledAt: new Date().toISOString(),
      }],
    });
    const venue = makeVenueState({
      recentFills: [{
        venueRefId: 'fill-abc-456',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: new Decimal('1'),
        price: new Decimal('50000'),
        fee: new Decimal('0.1'),
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      }] as VenueFill[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('match');
  });

  it('detects orphaned orders (venue order not tracked locally)', () => {
    const local = makeLocalState({ openOrders: [] });
    const venue = makeVenueState({
      openOrders: [{
        venueRefId: 'order-orphan-1',
        symbol: 'ETH/USD:USD',
        side: 'buy',
        type: 'limit',
        status: 'open',
        quantity: new Decimal('5'),
        filledQuantity: new Decimal('0'),
        price: new Decimal('2900'),
        createdAt: new Date().toISOString(),
      }] as VenueOrder[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.type).toBe('orphaned_order');
  });

  it('does not flag orders that exist in local', () => {
    const local = makeLocalState({
      openOrders: [{
        venueRefId: 'order-tracked-1',
        symbol: 'ETH/USD:USD',
        side: 'buy',
        type: 'limit',
        status: 'open',
        quantity: new Decimal('5'),
        price: new Decimal('2900'),
      }],
    });
    const venue = makeVenueState({
      openOrders: [{
        venueRefId: 'order-tracked-1',
        symbol: 'ETH/USD:USD',
        side: 'buy',
        type: 'limit',
        status: 'open',
        quantity: new Decimal('5'),
        filledQuantity: new Decimal('0'),
        price: new Decimal('2900'),
        createdAt: new Date().toISOString(),
      }] as VenueOrder[],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('match');
  });

  it('detects multiple drift types simultaneously', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('2'), entryPrice: new Decimal('50000') }],
      balances: [{ asset: 'USDC', total: new Decimal('10000') }],
      recentFills: [],
      openOrders: [],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('3'), entryPrice: new Decimal('50000') }] as Position[],
      balances: {
        balances: [{ asset: 'USDC', free: new Decimal('7000'), locked: new Decimal('0'), total: new Decimal('7000') }],
        timestamp: new Date().toISOString(),
      } as BalanceSnapshot,
      recentFills: [{
        venueRefId: 'mystery-fill',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: new Decimal('1'),
        price: new Decimal('51000'),
        fee: new Decimal('0.05'),
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      }] as VenueFill[],
      openOrders: [],
    });
    const result = reconcile(local, venue);
    expect(result.status).toBe('drift_detected');
    // position_mismatch + balance_mismatch + unknown_fill
    expect(result.diffs.length).toBeGreaterThanOrEqual(3);
    const types = result.diffs.map((d) => d.type);
    expect(types).toContain('position_mismatch');
    expect(types).toContain('balance_mismatch');
    expect(types).toContain('unknown_fill');
  });
});

describe('reconcileWithThresholds', () => {

  it('classifies position drift within threshold as acceptable', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1.0'), entryPrice: new Decimal('50000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1.001'), entryPrice: new Decimal('50000') }] as Position[],
    });
    const result = reconcileWithThresholds(local, venue, {
      positionSize: new Decimal('0.01'),
    });
    expect(result.status).toBe('drift_within_threshold');
    expect(result.diffs[0].severity).toBe('acceptable');
  });

  it('classifies position drift exceeding threshold as critical', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1.0'), entryPrice: new Decimal('50000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('2.0'), entryPrice: new Decimal('50000') }] as Position[],
    });
    const result = reconcileWithThresholds(local, venue, {
      positionSize: new Decimal('0.01'),
    });
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0].severity).toBe('critical');
  });

  it('classifies balance drift within threshold as acceptable', () => {
    const local = makeLocalState({
      balances: [{ asset: 'USD', total: new Decimal('10000') }],
    });
    const venue = makeVenueState({
      balances: { balances: [{ asset: 'USD', free: new Decimal('9999'), locked: new Decimal('0'), total: new Decimal('9999') }], timestamp: new Date().toISOString() } as BalanceSnapshot,
    });
    const result = reconcileWithThresholds(local, venue, {
      balance: new Decimal('5'),
    });
    expect(result.status).toBe('drift_within_threshold');
    expect(result.diffs[0].severity).toBe('acceptable');
  });

  it('returns match when no diffs exist (threshold irrelevant)', () => {
    const result = reconcileWithThresholds(makeLocalState(), makeVenueState(), {
      positionSize: new Decimal('1'),
    });
    expect(result.status).toBe('match');
  });

  it('classifies side mismatch as critical regardless of threshold', () => {
    const local = makeLocalState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'long', size: new Decimal('1.0'), entryPrice: new Decimal('50000') }],
    });
    const venue = makeVenueState({
      positions: [{ symbol: 'BTC/USD:USD', side: 'short', size: new Decimal('1.0'), entryPrice: new Decimal('50000') }] as Position[],
    });
    const result = reconcileWithThresholds(local, venue, {
      positionSize: new Decimal('100'),
    });
    expect(result.status).toBe('drift_detected');
    expect(result.diffs[0].severity).toBe('critical');
  });
});
