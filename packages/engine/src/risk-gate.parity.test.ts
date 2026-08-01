import { describe, it, expect } from 'vitest';
import { checkRisk } from './risk-gate.js';
import type { RiskLimits, RiskSnapshot } from './risk-gate.js';
import type { ExecutionPlan, PlannedOrder } from './planner.js';
import { quantity, price, Decimal } from '@herobids/domain';

// ---------------------------------------------------------------------------
// Test helpers — construct minimal valid fixtures
// ---------------------------------------------------------------------------

const BASE_LIMITS: RiskLimits = {
  maxPositionSize: quantity('1000000'),
  maxOpenPositions: 10,
  maxDrawdown: price('1000000000'),
};

const BASE_SNAPSHOT: RiskSnapshot = {
  currentPosition: null,
  openPositionCount: 0,
  currentDrawdown: price('0'),
};

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: 'plan-1',
    decisionId: 'dec-1',
    venueAccountId: 'va-1',
    actorType: 'agent',
    actorId: 'agent-1',
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    action: 'open_long',
    orders: [order()],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function order(overrides: Partial<PlannedOrder> = {}): PlannedOrder {
  return {
    side: 'buy',
    type: 'market',
    quantity: quantity('1'),
    price: price('50000'),
    ...overrides,
  };
}

function limits(overrides: Partial<RiskLimits> = {}): RiskLimits {
  return { ...BASE_LIMITS, ...overrides };
}

function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

// ---------------------------------------------------------------------------
// checkRisk — parity harness
// ---------------------------------------------------------------------------

describe('checkRisk (parity harness)', () => {
  // --- Normal trade within all limits ---

  it('passes a normal trade within all limits', () => {
    const result = checkRisk(
      plan(),
      limits({ maxOpenPositions: 10, maxPositionSizePct: 100 }),
      snapshot({ equity: price('100000') }),
    );
    expect(result.ok).toBe(true);
  });

  // --- maxPositionSize (absolute) ---

  it('rejects when resulting position exceeds maxPositionSize', () => {
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('2000000') })] }),
      limits({ maxPositionSize: quantity('1000000') }),
      snapshot(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_position_size_exceeded');
    }
  });

  it('passes when resulting position equals maxPositionSize exactly', () => {
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('1000000') })] }),
      limits({ maxPositionSize: quantity('1000000') }),
      snapshot(),
    );
    expect(result.ok).toBe(true);
  });

  // --- maxPositionSizePct ---

  it('rejects when resulting notional exceeds maxPositionSizePct', () => {
    // equity = $10,000, maxPositionSizePct = 10% → max notional = $1,000
    // order: 1 BTC at $50,000 notional = $50,000 > $1,000
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('1'), price: price('50000') })] }),
      limits({ maxPositionSize: quantity('1000000'), maxPositionSizePct: 10 }),
      snapshot({ equity: price('10000'), referenceMark: price('50000') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_position_size_pct_exceeded');
    }
  });

  it('passes when resulting notional is within maxPositionSizePct', () => {
    // equity = $100,000, maxPositionSizePct = 10% → max notional = $10,000
    // order: 0.1 BTC at $50,000 = $5,000 < $10,000
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('0.1'), price: price('50000') })] }),
      limits({ maxPositionSize: quantity('1000000'), maxPositionSizePct: 10 }),
      snapshot({ equity: price('100000'), referenceMark: price('50000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when maxPositionSizePct configured but no reference mark or order price', () => {
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('1'), price: undefined })] }),
      limits({ maxPositionSize: quantity('1000000'), maxPositionSizePct: 10 }),
      snapshot({ equity: price('100000'), referenceMark: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.no_mark_for_notional');
    }
  });

  // --- dailyMaxLossPct ---

  it('rejects when realized daily loss exceeds dailyMaxLossPct', () => {
    // equity = $1,000, dailyMaxLossPct = 5% → limit = $50
    // dailyLoss = $60 > $50
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), dailyMaxLossPct: 5 }),
      snapshot({ equity: price('1000'), dailyLoss: price('60') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.daily_max_loss_exceeded');
    }
  });

  it('passes when realized daily loss is below dailyMaxLossPct', () => {
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), dailyMaxLossPct: 5 }),
      snapshot({ equity: price('1000'), dailyLoss: price('40') }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes when dailyMaxLossPct is not set (limit absent)', () => {
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000') }), // no dailyMaxLossPct
      snapshot({ equity: price('1000'), dailyLoss: price('1000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes when dailyLoss snapshot is absent', () => {
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), dailyMaxLossPct: 5 }),
      snapshot({ equity: price('1000') }), // no dailyLoss
    );
    expect(result.ok).toBe(true);
  });

  // --- maxDrawdown (absolute) ---

  it('rejects when current drawdown exceeds maxDrawdown (absolute)', () => {
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdown: price('1000') }),
      snapshot({ currentDrawdown: price('1500') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_drawdown_exceeded');
    }
  });

  it('passes when current drawdown is within maxDrawdown (absolute)', () => {
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdown: price('1000') }),
      snapshot({ currentDrawdown: price('500') }),
    );
    expect(result.ok).toBe(true);
  });

  // --- maxDrawdownPct ---

  it('rejects when peak-to-current equity drawdown exceeds maxDrawdownPct', () => {
    // peak = $10,000, equity = $9,000 → drawdown = 10%
    // maxDrawdownPct = 5% → should reject
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdownPct: 5 }),
      snapshot({ equity: price('9000'), peakEquity: price('10000') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_drawdown_pct_exceeded');
    }
  });

  it('passes when peak-to-current equity drawdown is within maxDrawdownPct', () => {
    // peak = $10,000, equity = $9,500 → drawdown = 5%
    // maxDrawdownPct = 10% → 5% drawdown is within limit
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdownPct: 10 }),
      snapshot({ equity: price('9500'), peakEquity: price('10000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when drawdown exactly equals maxDrawdownPct limit', () => {
    // peak = $10,000, equity = $9,500 → drawdown = 5%
    // maxDrawdownPct = 5 → drawdownPct.gte(limit) → exactly at limit should reject
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdownPct: 5 }),
      snapshot({ equity: price('9500'), peakEquity: price('10000') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_drawdown_pct_exceeded');
    }
  });

  it('falls back to equity when peakEquity is absent for drawdown check', () => {
    // equity = peak = $10,000 → no drawdown
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdownPct: 5 }),
      snapshot({ equity: price('10000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes maxDrawdownPct when equity not present', () => {
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdownPct: 5 }),
      snapshot(), // no equity
    );
    expect(result.ok).toBe(true);
  });

  // --- maxOpenPositions ---

  it('rejects when open position count equals maxOpenPositions for an opening action', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), maxOpenPositions: 5 }),
      snapshot({ openPositionCount: 5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_open_positions_exceeded');
    }
  });

  it('passes when open position count is below maxOpenPositions for an opening action', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), maxOpenPositions: 5 }),
      snapshot({ openPositionCount: 4 }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes maxOpenPositions for non-opening actions (close)', () => {
    const result = checkRisk(
      plan({ action: 'close' }),
      limits({ maxPositionSize: quantity('1000000'), maxOpenPositions: 5 }),
      snapshot({ openPositionCount: 10 }), // way over limit but closing
    );
    expect(result.ok).toBe(true);
  });

  it('passes maxOpenPositions for non-opening actions (reduce)', () => {
    const result = checkRisk(
      plan({ action: 'reduce' }),
      limits({ maxPositionSize: quantity('1000000'), maxOpenPositions: 5 }),
      snapshot({ openPositionCount: 10 }),
    );
    expect(result.ok).toBe(true);
  });

  // --- stopLossCooldownMs ---

  it('rejects entry when within stop-loss cooldown window', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), stopLossCooldownMs: 300_000 }),
      snapshot({
        lastStopLossExitMs: 1_000_000,
        nowMs: 1_000_100, // only 100ms elapsed, cooldown is 300_000ms
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.stop_loss_cooldown');
    }
  });

  it('passes entry when stop-loss cooldown has expired', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), stopLossCooldownMs: 300_000 }),
      snapshot({
        lastStopLossExitMs: 1_000_000,
        nowMs: 1_500_000, // 500_000ms elapsed > 300_000ms cooldown
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes entry when elapsed exactly equals stop-loss cooldown', () => {
    // cooldown check uses elapsed < cooldownMs, so exactly at boundary should pass
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), stopLossCooldownMs: 300_000 }),
      snapshot({
        lastStopLossExitMs: 1_000_000,
        nowMs: 1_300_000, // 300_000ms elapsed, exactly equals cooldown
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes entry when stop-loss cooldown is disabled (0)', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), stopLossCooldownMs: 0 }),
      snapshot({ lastStopLossExitMs: 1_000_000, nowMs: 1_000_100 }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes entry when stopLossCooldownMs not set', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000') }),
      snapshot({ lastStopLossExitMs: 1_000_000, nowMs: 1_000_100 }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes cooldown check for non-opening actions (close)', () => {
    const result = checkRisk(
      plan({ action: 'close' }),
      limits({ maxPositionSize: quantity('1000000'), stopLossCooldownMs: 300_000 }),
      snapshot({ lastStopLossExitMs: 1_000_000, nowMs: 1_000_100 }),
    );
    expect(result.ok).toBe(true);
  });

  // --- maxOrderNotional ---

  it('rejects when order notional exceeds maxOrderNotional', () => {
    // 1 BTC at $50,000 = $50,000 notional, max = $10,000
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('1'), price: price('50000') })] }),
      limits({ maxPositionSize: quantity('1000000'), maxOrderNotional: price('10000') }),
      snapshot({ referenceMark: price('50000') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_order_notional_exceeded');
    }
  });

  it('passes when order notional is within maxOrderNotional', () => {
    // 0.1 BTC at $50,000 = $5,000 notional, max = $10,000
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('0.1'), price: price('50000') })] }),
      limits({ maxPositionSize: quantity('1000000'), maxOrderNotional: price('10000') }),
      snapshot({ referenceMark: price('50000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when maxOrderNotional configured but no reference mark or order price', () => {
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('1'), price: undefined })] }),
      limits({ maxPositionSize: quantity('1000000'), maxOrderNotional: price('10000') }),
      snapshot({ referenceMark: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.no_mark_for_notional');
    }
  });

  // --- stopLossMaxUnrealizedLossPct ---

  it('passes when stopLossMaxUnrealizedLossPct is configured', () => {
    // stopLossMaxUnrealizedLossPct is stored in limits but checkRisk does not inspect it.
    // The stop-loss monitor polls unrealized P&L separately.
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), stopLossMaxUnrealizedLossPct: 5 }),
      snapshot({ equity: price('10000') }),
    );
    // checkRisk itself ignores this field — it passes
    expect(result.ok).toBe(true);
  });

  // --- Risk-reducing actions bypass checks ---

  it('allows close action even when drawdown limits exceeded', () => {
    const result = checkRisk(
      plan({ action: 'close' }),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdown: price('100'), maxDrawdownPct: 1 }),
      snapshot({ currentDrawdown: price('10000'), equity: price('100'), peakEquity: price('10000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('allows reduce action even when drawdown limits exceeded', () => {
    const result = checkRisk(
      plan({ action: 'reduce' }),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdown: price('100'), maxDrawdownPct: 1 }),
      snapshot({ currentDrawdown: price('10000'), equity: price('100'), peakEquity: price('10000') }),
    );
    expect(result.ok).toBe(true);
  });

  it('allows close action even when daily loss limit exceeded', () => {
    const result = checkRisk(
      plan({ action: 'close' }),
      limits({ maxPositionSize: quantity('1000000'), dailyMaxLossPct: 1 }),
      snapshot({ equity: price('1000'), dailyLoss: price('100') }),
    );
    expect(result.ok).toBe(true);
  });

  // --- Edge: zero equity ---

  it('passes maxDrawdownPct when equity and peak are both zero (no drawdown computed)', () => {
    // peak=0, equity=0 → drawdown calculation: 0-0/0 → should still pass (no drawdown)
    const result = checkRisk(
      plan(),
      limits({ maxPositionSize: quantity('1000000'), maxDrawdownPct: 5 }),
      snapshot({ equity: price('0'), peakEquity: price('0') }),
    );
    // The check: equity.lt(peak) → 0 < 0 → false → skips drawdown check → pass
    expect(result.ok).toBe(true);
  });

  // --- Edge: no open positions ---

  it('passes when no current position and no open positions', () => {
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), maxOpenPositions: 5 }),
      snapshot({ openPositionCount: 0, currentPosition: null }),
    );
    expect(result.ok).toBe(true);
  });

  // --- Edge: exactly at limit for maxOpenPositions ---

  it('rejects when openPositionCount equals maxOpenPositions (exactly at limit)', () => {
    // The code checks: openPositionCount >= maxOpenPositions
    const result = checkRisk(
      plan({ action: 'open_long' }),
      limits({ maxPositionSize: quantity('1000000'), maxOpenPositions: 3 }),
      snapshot({ openPositionCount: 3 }),
    );
    expect(result.ok).toBe(false);
  });

  // --- Edge: order with no price (market order) ---

  it('passes maxOrderNotional when market order has no price but referenceMark present', () => {
    const result = checkRisk(
      plan({ orders: [order({ side: 'buy', quantity: quantity('0.1'), price: undefined })] }),
      limits({ maxPositionSize: quantity('1000000'), maxOrderNotional: price('10000') }),
      snapshot({ referenceMark: price('50000') }),
    );
    // 0.1 BTC × $50,000 = $5,000 < $10,000 → pass
    expect(result.ok).toBe(true);
  });

  // --- Edge: multiple orders in a plan ---

  it('checks each order individually for position size and notional limits', () => {
    const result = checkRisk(
      plan({
        orders: [
          order({ side: 'buy', quantity: quantity('0.1'), price: price('100') }),
          order({ side: 'buy', quantity: quantity('0.5'), price: price('50000') }),
        ],
      }),
      limits({ maxPositionSize: quantity('1000'), maxOrderNotional: price('60000') }),
      snapshot({ referenceMark: price('50000'), equity: price('1000000'), currentPosition: null }),
    );
    // First order: position 0.1 < 1000 → pass
    // First order notional: max(50000, 100)=50000, 0.1*50000=5000 < 60000 → pass
    // Second order: cumulative position 0.6 < 1000 → pass
    // Second order notional: max(50000, 50000)=50000, 0.5*50000=25000 < 60000 → pass
    expect(result.ok).toBe(true);
  });
});
