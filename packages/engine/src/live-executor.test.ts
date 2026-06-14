import { describe, it, expect, vi } from 'vitest';
import { LiveExecutor } from './live-executor.js';
import { quantity, price } from '@herobids/domain';
import type { OrderId, FillId } from '@herobids/domain';
import type { OrderbookVenuePort, OrderCommand, OrderReceipt, VenueError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import type { ExecutionPlan } from './planner.js';

function makeIdGen() {
  let counter = 0;
  return {
    orderId: () => `order-${++counter}` as OrderId,
    fillId: () => `fill-${++counter}` as FillId,
  };
}

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-1',
    decisionId: 'dec-1',
    botId: 'inst-1' as unknown as string,
    venue: 'hyperliquid',
    symbol: 'ETH/USD:USD',
    action: 'open_long',
    orders: [
      { side: 'buy', type: 'market', quantity: quantity('0.5') },
    ],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeVenuePort(
  submitFn: (cmd: OrderCommand) => Promise<Result<OrderReceipt, VenueError>>,
): OrderbookVenuePort {
  return {
    submitOrder: submitFn,
    cancelOrder: vi.fn(),
    amendOrder: vi.fn(),
    fetchPositions: vi.fn(),
    fetchBalances: vi.fn(),
    fetchTicker: vi.fn(),
    fetchOpenOrders: vi.fn(),
    fetchRecentFills: vi.fn(),
    subscribePrivate: vi.fn(),
    subscribePublic: vi.fn(),
  } as unknown as OrderbookVenuePort;
}

describe('LiveExecutor', () => {
  describe('successful submit', () => {
    it('submits market order and returns acknowledged order with no fills', async () => {
      const venuePort = makeVenuePort(async (cmd) => ({
        ok: true as const,
        data: {
          orderId: 'venue-oid-1' as OrderId,
          clientOrderId: cmd.clientOrderId,
          status: 'open' as const,
          venueRefId: 'vref-123',
          timestamp: '2026-01-01T00:00:01Z',
        },
      }));

      const idGen = makeIdGen();
      const executor = new LiveExecutor({
        venuePort,
        idGen,
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
      });

      const result = await executor.execute(makePlan(), quantity('3000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // No synthetic fills
      expect(result.data.fills).toEqual([]);

      // Order acknowledged with real venue ref
      expect(result.data.orders).toHaveLength(1);
      const order = result.data.orders[0]!;
      expect(order.venueRefId).toBe('vref-123');
      expect(order.clientOrderId).toBe('plan-1-0');
      expect(order.status).toBe('open');
      expect(order.filledQuantity.toString()).toBe('0');

      // Plan is executing (not completed — fills arrive asynchronously)
      expect(result.data.plan.status).toBe('executing');
      expect(result.data.plan.completedAt).toBeUndefined();
    });
  });

  describe('venue rejection', () => {
    it('returns ok with failed plan when all orders are rejected by the venue', async () => {
      const venuePort = makeVenuePort(async () => ({
        ok: false as const,
        error: {
          code: 'venue.order_rejected',
          message: 'Insufficient margin',
        },
      }));

      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
      });

      const result = await executor.execute(makePlan(), quantity('3000'));

      // Returns ok so per-order detail is preserved for persistence
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.plan.status).toBe('failed');
      expect(result.data.orders).toHaveLength(1);
      expect(result.data.orders[0]!.status).toBe('rejected');
      expect(result.data.fills).toEqual([]);
    });
  });

  describe('partial submit', () => {
    it('returns success with mixed accepted/rejected orders when some succeed', async () => {
      let callCount = 0;
      const venuePort = makeVenuePort(async (cmd) => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true as const,
            data: {
              orderId: 'venue-oid-1' as OrderId,
              clientOrderId: cmd.clientOrderId,
              status: 'open' as const,
              venueRefId: 'vref-1',
              timestamp: '2026-01-01T00:00:01Z',
            },
          };
        }
        return {
          ok: false as const,
          error: { code: 'venue.rate_limited', message: 'Rate limited' },
        };
      });

      const plan = makePlan({
        orders: [
          { side: 'buy', type: 'market', quantity: quantity('0.5') },
          { side: 'buy', type: 'market', quantity: quantity('0.3') },
        ],
      });

      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
      });

      const result = await executor.execute(plan, quantity('3000'));

      // Should be ok since at least one order succeeded
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.orders).toHaveLength(2);
      expect(result.data.orders[0]!.status).toBe('open');
      expect(result.data.orders[1]!.status).toBe('rejected');
      expect(result.data.plan.status).toBe('executing');
      expect(result.data.fills).toEqual([]);
    });
  });

  describe('idempotent client order ID', () => {
    it('generates deterministic clientOrderId from planId and order index', async () => {
      const submittedCmds: OrderCommand[] = [];
      const venuePort = makeVenuePort(async (cmd) => {
        submittedCmds.push(cmd);
        return {
          ok: true as const,
          data: {
            orderId: 'venue-oid-1' as OrderId,
            clientOrderId: cmd.clientOrderId,
            status: 'open' as const,
            venueRefId: 'vref-1',
            timestamp: '2026-01-01T00:00:01Z',
          },
        };
      });

      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}:${idx}`,
      });

      await executor.execute(makePlan({ id: 'plan-xyz' }), quantity('3000'));

      expect(submittedCmds).toHaveLength(1);
      expect(submittedCmds[0]!.clientOrderId).toBe('plan-xyz:0');
    });
  });

  describe('unsupported order types', () => {
    it('submits limit orders in live mode', async () => {
      const venuePort = makeVenuePort(async (cmd) => ({
        ok: true as const,
        data: {
          orderId: 'venue-oid-limit-1' as OrderId,
          clientOrderId: cmd.clientOrderId,
          status: 'open' as const,
          venueRefId: 'vref-limit-1',
          timestamp: '2026-01-01T00:00:02Z',
        },
      }));

      const plan = makePlan({
        orders: [
          { side: 'buy', type: 'limit', quantity: quantity('1'), price: quantity('3000') },
        ],
      });

      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
      });

      const result = await executor.execute(plan, price('3000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.plan.status).toBe('executing');
      expect(result.data.orders[0]!.status).toBe('open');
      expect(result.data.orders[0]!.submissionState).toBe('venue_acknowledged');
    });

    it('rejects swap orders in live mode', async () => {
      const venuePort = makeVenuePort(async () => {
        throw new Error('Should not be called');
      });

      const plan = makePlan({
        orders: [
          { side: 'buy', type: 'swap', quantity: quantity('100') },
        ],
      });

      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
      });

      const result = await executor.execute(plan, quantity('3000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.plan.status).toBe('failed');
      expect(result.data.orders[0]!.status).toBe('rejected');
    });
  });

  describe('no synthetic fills', () => {
    it('never generates fills even when venue acknowledges order immediately as filled', async () => {
      const venuePort = makeVenuePort(async (cmd) => ({
        ok: true as const,
        data: {
          orderId: 'venue-oid-1' as OrderId,
          clientOrderId: cmd.clientOrderId,
          status: 'filled' as const,
          venueRefId: 'vref-filled',
          timestamp: '2026-01-01T00:00:01Z',
        },
      }));

      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
      });

      const result = await executor.execute(makePlan(), quantity('3000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fills array is ALWAYS empty from LiveExecutor — fills come from stream/reconciliation
      expect(result.data.fills).toEqual([]);

      // Order status reflects what the venue said
      expect(result.data.orders[0]!.status).toBe('filled');
    });
  });

  describe('durable submit lifecycle hooks', () => {
    it('emits prepared -> submit_attempting -> venue_acknowledged transitions', async () => {
      const venuePort = makeVenuePort(async (cmd) => ({
        ok: true as const,
        data: {
          orderId: 'venue-oid-1' as OrderId,
          clientOrderId: cmd.clientOrderId,
          status: 'open' as const,
          venueRefId: 'vref-123',
          timestamp: '2026-01-01T00:00:01Z',
        },
      }));

      const transitions: string[] = [];
      const executor = new LiveExecutor({
        venuePort,
        idGen: makeIdGen(),
        clientOrderId: (planId, idx) => `${planId}-${idx}`,
        onOrderStateChange: async (order) => {
          transitions.push(order.submissionState ?? 'none');
        },
      });

      const result = await executor.execute(makePlan(), price('3000'));
      expect(result.ok).toBe(true);
      expect(transitions).toEqual(['prepared', 'submit_attempting', 'venue_acknowledged']);
    });
  });
});
