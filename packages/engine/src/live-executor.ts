import type { Result } from '@herobids/domain';
import type { OrderId, TradingInstanceId } from '@herobids/domain';
import type { Price } from '@herobids/domain';
import type { OrderbookVenuePort, OrderCommand } from '@herobids/domain';
import { ok } from '@herobids/domain';
import type { Executor, ExecutionResult, EngineError } from './executor.js';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder } from './order-state.js';
import type { IdGenerator } from './paper-executor.js';

export interface LiveExecutorDeps {
  venuePort: OrderbookVenuePort;
  idGen: IdGenerator;
  /** Generate a deterministic client order ID for idempotency/correlation */
  clientOrderId: (planId: string, orderIndex: number) => string;
}

/**
 * LiveExecutor — submits real orders to the venue.
 *
 * Key invariants:
 * - Market orders only (Phase 4 scope).
 * - Does NOT fabricate fills — fills arrive asynchronously from private stream or reconciliation.
 * - Returns acknowledged orders with real venueRefId values.
 * - Rejects unsupported order types (limit, swap) rather than falling through.
 * - Partial submit scenarios are observable: each order's accept/reject is tracked individually.
 */
export class LiveExecutor implements Executor {
  constructor(private readonly deps: LiveExecutorDeps) {}

  async execute(plan: ExecutionPlan, _currentPrice: Price): Promise<Result<ExecutionResult, EngineError>> {
    const now = new Date().toISOString();
    const orders: ManagedOrder[] = [];

    for (let i = 0; i < plan.orders.length; i++) {
      const planned = plan.orders[i]!;

      // Phase 4: market orders only. Reject unsupported types explicitly.
      if (planned.type !== 'market') {
        orders.push({
          id: this.deps.idGen.orderId(),
          tradingInstanceId: plan.tradingInstanceId as TradingInstanceId,
          executionPlanId: plan.id,
          venueRefId: undefined,
          clientOrderId: this.deps.clientOrderId(plan.id, i),
          venue: plan.venue,
          symbol: plan.symbol,
          side: planned.side,
          type: planned.type,
          quantity: planned.quantity,
          price: planned.price,
          status: 'rejected',
          filledQuantity: '0' as unknown as typeof planned.quantity,
          avgFillPrice: undefined,
          createdAt: now,
          updatedAt: now,
        });
        continue;
      }

      const clientOrderId = this.deps.clientOrderId(plan.id, i);

      const cmd: OrderCommand = {
        symbol: plan.symbol,
        side: planned.side,
        type: 'market',
        quantity: planned.quantity,
        clientOrderId,
      };

      const submitResult = await this.deps.venuePort.submitOrder(cmd);

      if (!submitResult.ok) {
        // Venue rejected the order — record as rejected with error context
        orders.push({
          id: this.deps.idGen.orderId(),
          tradingInstanceId: plan.tradingInstanceId as TradingInstanceId,
          executionPlanId: plan.id,
          venueRefId: undefined,
          clientOrderId,
          venue: plan.venue,
          symbol: plan.symbol,
          side: planned.side,
          type: planned.type,
          quantity: planned.quantity,
          price: planned.price,
          status: 'rejected',
          filledQuantity: '0' as unknown as typeof planned.quantity,
          avgFillPrice: undefined,
          createdAt: now,
          updatedAt: now,
        });
        continue;
      }

      // Order acknowledged by venue
      const receipt = submitResult.data;
      orders.push({
        id: receipt.orderId as unknown as OrderId,
        tradingInstanceId: plan.tradingInstanceId as TradingInstanceId,
        executionPlanId: plan.id,
        venueRefId: receipt.venueRefId,
        clientOrderId,
        venue: plan.venue,
        symbol: plan.symbol,
        side: planned.side,
        type: planned.type,
        quantity: planned.quantity,
        price: planned.price,
        status: receipt.status,
        filledQuantity: '0' as unknown as typeof planned.quantity,
        avgFillPrice: undefined,
        createdAt: receipt.timestamp,
        updatedAt: receipt.timestamp,
      });
    }

    // Determine plan status:
    // - All rejected → failed
    // - Any acknowledged → executing (fills arrive asynchronously)
    const allRejected = orders.every((o) => o.status === 'rejected');
    const planStatus = allRejected ? 'failed' : 'executing';

    const resultPlan: ExecutionPlan = {
      ...plan,
      status: planStatus,
      completedAt: allRejected ? now : undefined,
    };

    // Always return ok() so the trading cycle can persist per-order detail.
    // The plan status communicates whether execution made progress.
    return ok({ plan: resultPlan, orders, fills: [] });
  }
}
