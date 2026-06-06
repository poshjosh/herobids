import type { Result } from '@herobids/domain';
import type { OrderId, FillId } from '@herobids/domain';
import type { Price } from '@herobids/domain';
import { ok } from '@herobids/domain';
import { quantity } from '@herobids/domain';
import type { Executor, ExecutionResult, EngineError } from './executor.js';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder, FillEvent } from './order-state.js';
import type { Clock } from './trading-cycle.js';

export interface IdGenerator {
  orderId(): OrderId;
  fillId(): FillId;
}

/**
 * Paper executor — simulates instant fills at the provided market price.
 * No venue interaction. Used for paper trading mode.
 */
export class PaperExecutor implements Executor {
  constructor(
    private readonly idGen: IdGenerator,
    private readonly clock?: Clock,
  ) {}

  async execute(plan: ExecutionPlan, currentPrice: Price): Promise<Result<ExecutionResult, EngineError>> {
    const now = this.clock ? this.clock.now() : new Date().toISOString();
    const orders: ManagedOrder[] = [];
    const fills: FillEvent[] = [];

    for (const planned of plan.orders) {
      const orderId = this.idGen.orderId();
      const fillId = this.idGen.fillId();
      // Paper mode: fill immediately at current price (market) or limit price
      const fillPrice = planned.type === 'market' ? currentPrice : (planned.price ?? currentPrice);

      const order: ManagedOrder = {
        id: orderId,
        venueAccountId: plan.venueAccountId,
        botId: plan.botId,
        actorType: plan.actorType,
        actorId: plan.actorId,
        executionPlanId: plan.id,
        venueRefId: `paper-${orderId}`,
        clientOrderId: undefined,
        venue: plan.venue,
        symbol: plan.symbol,
        side: planned.side,
        type: planned.type,
        quantity: planned.quantity,
        price: planned.price,
        status: 'filled',
        filledQuantity: planned.quantity,
        avgFillPrice: fillPrice,
        createdAt: now,
        updatedAt: now,
      };
      orders.push(order);

      const fill: FillEvent = {
        id: fillId,
        orderId,
        venueAccountId: plan.venueAccountId,
        botId: plan.botId,
        actorType: plan.actorType,
        actorId: plan.actorId,
        venueRefId: `paper-${fillId}`,
        venue: plan.venue,
        symbol: plan.symbol,
        side: planned.side,
        quantity: planned.quantity,
        price: fillPrice,
        fee: quantity('0'),
        feeCurrency: 'USD',
        filledAt: now,
      };
      fills.push(fill);
    }

    const completedPlan: ExecutionPlan = {
      ...plan,
      status: 'completed',
      completedAt: now,
    };

    return ok({ plan: completedPlan, orders, fills });
  }
}
