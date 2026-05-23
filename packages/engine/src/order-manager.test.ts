import { describe, it, expect, beforeEach } from 'vitest';
import { OrderManager } from './order-manager.js';
import { quantity, price } from '@herobids/domain';
import type { OrderId, FillId, TradingInstanceId } from '@herobids/domain';

function orderId(n: number): OrderId {
  return `order-${n}` as OrderId;
}
function fillId(n: number): FillId {
  return `fill-${n}` as FillId;
}
const instanceId = 'inst-1' as TradingInstanceId;

describe('OrderManager', () => {
  let mgr: OrderManager;

  beforeEach(() => {
    mgr = new OrderManager();
  });

  describe('create', () => {
    it('creates an order in pending state', () => {
      const order = mgr.create({
        id: orderId(1),
        tradingInstanceId: instanceId,
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        type: 'market',
        quantity: quantity('1'),
      });
      expect(order.status).toBe('pending');
      expect(order.filledQuantity.isZero()).toBe(true);
      expect(order.avgFillPrice).toBeUndefined();
    });
  });

  describe('acknowledge', () => {
    it('transitions pending → open', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'limit', quantity: quantity('1'), price: price('100') });
      const result = mgr.acknowledge(orderId(1), { venueRefId: 'venue-ref-1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe('open');
        expect(result.data.venueRefId).toBe('venue-ref-1');
      }
    });

    it('rejects acknowledge on filled order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.acknowledge(orderId(1), { venueRefId: 'ref' });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('100'), filledAt: new Date().toISOString() });
      const result = mgr.acknowledge(orderId(1), { venueRefId: 'ref2' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('engine.invalid_transition');
    });

    it('returns error for unknown order', () => {
      const result = mgr.acknowledge(orderId(99), { venueRefId: 'ref' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('engine.order_not_found');
    });
  });

  describe('applyFill', () => {
    it('fills a market order completely (pending → filled)', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('2') });
      const result = mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('2'), price: price('50000'), filledAt: '2026-01-01T00:00:00Z' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.order.status).toBe('filled');
        expect(result.data.order.filledQuantity.equals(quantity('2'))).toBe(true);
        expect(result.data.order.avgFillPrice?.equals(price('50000'))).toBe(true);
        expect(result.data.fill.orderId).toBe(orderId(1));
        expect(result.data.fill.tradingInstanceId).toBe(instanceId);
      }
    });

    it('partially fills an order (open → partial)', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'limit', quantity: quantity('10'), price: price('100') });
      mgr.acknowledge(orderId(1), { venueRefId: 'ref' });

      const result = mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('3'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.order.status).toBe('partial');
        expect(result.data.order.filledQuantity.equals(quantity('3'))).toBe(true);
      }
    });

    it('fills remaining after partial (partial → filled)', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'sell', type: 'limit', quantity: quantity('4'), price: price('200') });
      mgr.acknowledge(orderId(1), { venueRefId: 'ref' });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('200'), filledAt: '2026-01-01T00:00:00Z' });

      const result = mgr.applyFill(orderId(1), { fillId: fillId(2), quantity: quantity('3'), price: price('201'), filledAt: '2026-01-01T00:00:01Z' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.order.status).toBe('filled');
        expect(result.data.order.filledQuantity.equals(quantity('4'))).toBe(true);
        // Weighted average: (200*1 + 201*3) / 4 = 803/4 = 200.75
        expect(result.data.order.avgFillPrice?.toFixed(2)).toBe('200.75');
      }
    });

    it('rejects overfill', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('5') });
      const result = mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('6'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('engine.overfill');
    });

    it('rejects fill on terminal order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });
      const result = mgr.applyFill(orderId(1), { fillId: fillId(2), quantity: quantity('1'), price: price('100'), filledAt: '2026-01-01T00:00:01Z' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('engine.order_terminal');
    });
  });

  describe('cancel', () => {
    it('cancels an open order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'limit', quantity: quantity('1'), price: price('100') });
      mgr.acknowledge(orderId(1), { venueRefId: 'ref' });
      const result = mgr.cancel(orderId(1));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe('cancelled');
    });

    it('cancels a partially filled order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'limit', quantity: quantity('10'), price: price('100') });
      mgr.acknowledge(orderId(1), { venueRefId: 'ref' });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('3'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });
      const result = mgr.cancel(orderId(1));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe('cancelled');
        expect(result.data.filledQuantity.equals(quantity('3'))).toBe(true);
      }
    });

    it('rejects cancel on filled order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });
      const result = mgr.cancel(orderId(1));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('engine.invalid_transition');
    });
  });

  describe('reject', () => {
    it('rejects a pending order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      const result = mgr.reject(orderId(1), 'insufficient margin');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe('rejected');
    });

    it('cannot reject a filled order', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });
      const result = mgr.reject(orderId(1));
      expect(result.ok).toBe(false);
    });
  });

  describe('queries', () => {
    it('getActive returns non-terminal orders', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.create({ id: orderId(2), tradingInstanceId: instanceId, venue: 'hl', symbol: 'ETH', side: 'sell', type: 'limit', quantity: quantity('5'), price: price('3000') });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });

      const active = mgr.getActive();
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(orderId(2));
    });

    it('getByPlan filters by execution plan', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, executionPlanId: 'plan-a', venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.create({ id: orderId(2), tradingInstanceId: instanceId, executionPlanId: 'plan-b', venue: 'hl', symbol: 'ETH', side: 'buy', type: 'market', quantity: quantity('2') });

      const planA = mgr.getByPlan('plan-a');
      expect(planA).toHaveLength(1);
      expect(planA[0]!.id).toBe(orderId(1));
    });
  });

  describe('prune', () => {
    it('removes terminal orders older than threshold', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      mgr.applyFill(orderId(1), { fillId: fillId(1), quantity: quantity('1'), price: price('100'), filledAt: '2026-01-01T00:00:00Z' });

      // Patch updatedAt to be old
      const order = mgr.get(orderId(1))!;
      order.updatedAt = new Date(Date.now() - 100_000).toISOString();

      const pruned = mgr.prune(50_000); // older than 50s
      expect(pruned).toBe(1);
      expect(mgr.get(orderId(1))).toBeUndefined();
    });

    it('does not prune active orders', () => {
      mgr.create({ id: orderId(1), tradingInstanceId: instanceId, venue: 'hl', symbol: 'BTC', side: 'buy', type: 'market', quantity: quantity('1') });
      const order = mgr.get(orderId(1))!;
      order.updatedAt = new Date(Date.now() - 100_000).toISOString();

      const pruned = mgr.prune(50_000);
      expect(pruned).toBe(0);
      expect(mgr.get(orderId(1))).toBeDefined();
    });
  });
});
