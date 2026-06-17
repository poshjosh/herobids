import type { Result } from '@herobids/domain';
import type { OrderId } from '@herobids/domain';
import type { Price } from '@herobids/domain';
import type { OrderbookVenuePort, OrderCommand } from '@herobids/domain';
import { ok, quantity } from '@herobids/domain';
import { validateOrderAttributes } from '@herobids/domain';
import type { Executor, ExecutionResult, EngineError } from './executor.js';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder } from './order-state.js';
import type { IdGenerator } from './paper-executor.js';

export interface LiveExecutorDeps {
  venuePort: OrderbookVenuePort;
  idGen: IdGenerator;
  /** Generate a deterministic client order ID for idempotency/correlation */
  clientOrderId: (planId: string, orderIndex: number) => string;
  /** Optional hook to durably persist order submit-state transitions. */
  onOrderStateChange?: (order: ManagedOrder) => Promise<void>;
}

/**
 * LiveExecutor — submits real orders to the venue.
 *
 * Key invariants:
 * - Supports market and limit orders with optional time-in-force, post-only, and reduce-only.
 * - Gates advanced attributes (post-only, reduce-only, non-GTC TIF) on venue capabilities.
 * - Does NOT fabricate fills — fills arrive asynchronously from private stream or reconciliation.
 * - Returns acknowledged orders with real venueRefId values.
 * - Rejects unsupported order types (swap) rather than falling through.
 * - Partial submit scenarios are observable: each order's accept/reject is tracked individually.
 */
export class LiveExecutor implements Executor {
  constructor(private readonly deps: LiveExecutorDeps) {}

  async execute(plan: ExecutionPlan, currentPrice: Price): Promise<Result<ExecutionResult, EngineError>> {
    const now = new Date().toISOString();
    const orders: ManagedOrder[] = [];
    const capabilities = this.deps.venuePort.getCapabilities();

    for (let i = 0; i < plan.orders.length; i++) {
      const planned = plan.orders[i]!;
      const clientOrderId = this.deps.clientOrderId(plan.id, i);

      const unsupported = planned.type !== 'market' && planned.type !== 'limit';
      if (unsupported) {
        const rejected = await this.rejectOrder(plan, planned, now, clientOrderId, currentPrice);
        orders.push(rejected);
        continue;
      }

      // Validate venue capabilities for requested limit-order attributes
      if (planned.type === 'limit') {
        const attrCheck = validateOrderAttributes(capabilities, {
          timeInForce: planned.timeInForce,
          postOnly: planned.postOnly,
          reduceOnly: planned.reduceOnly,
        });
        if (!attrCheck.ok) {
          const rejected = await this.rejectOrder(plan, planned, now, clientOrderId, currentPrice, attrCheck.error.message);
          orders.push(rejected);
          continue;
        }
      }

      const orderId = this.deps.idGen.orderId();
      const preparedAt = new Date().toISOString();
      const prepared: ManagedOrder = {
        id: orderId,
        venueAccountId: plan.venueAccountId,
        actorType: plan.actorType,
        actorId: plan.actorId,
        executionPlanId: plan.id,
        venueRefId: undefined,
        clientOrderId,
        venue: plan.venue,
        symbol: plan.symbol,
        side: planned.side,
        type: planned.type,
        quantity: planned.quantity,
        price: planned.price,
        timeInForce: planned.timeInForce,
        postOnly: planned.postOnly,
        reduceOnly: planned.reduceOnly,
        referencePrice: currentPrice,
        status: 'pending',
        submissionState: 'prepared',
        submitAttemptedAt: undefined,
        acknowledgedAt: undefined,
        filledQuantity: quantity('0'),
        avgFillPrice: undefined,
        createdAt: preparedAt,
        updatedAt: preparedAt,
      };
      await this.deps.onOrderStateChange?.(prepared);

      const submitAttemptedAt = new Date().toISOString();
      const attempting: ManagedOrder = {
        ...prepared,
        submissionState: 'submit_attempting',
        submitAttemptedAt,
        updatedAt: submitAttemptedAt,
      };
      await this.deps.onOrderStateChange?.(attempting);

      const cmd: OrderCommand = {
        symbol: plan.symbol,
        side: planned.side,
        type: planned.type,
        quantity: planned.quantity,
        price: planned.price,
        clientOrderId,
        timeInForce: planned.timeInForce,
        postOnly: planned.postOnly,
        reduceOnly: planned.reduceOnly,
      };

      const submitResult = await this.deps.venuePort.submitOrder(cmd);

      if (!submitResult.ok) {
        const failedAt = new Date().toISOString();
        const rejected: ManagedOrder = {
          ...attempting,
          status: 'rejected',
          submissionState: 'terminal',
          updatedAt: failedAt,
        };
        await this.deps.onOrderStateChange?.(rejected);
        orders.push(rejected);
        continue;
      }

      const receipt = submitResult.data;
      const terminal = receipt.status === 'filled' || receipt.status === 'cancelled' || receipt.status === 'rejected';
      const acknowledged: ManagedOrder = {
        ...attempting,
        id: receipt.orderId as unknown as OrderId,
        venueRefId: receipt.venueRefId,
        status: receipt.status,
        submissionState: terminal ? 'terminal' : 'venue_acknowledged',
        acknowledgedAt: receipt.timestamp,
        updatedAt: receipt.timestamp,
      };
      await this.deps.onOrderStateChange?.(acknowledged);
      orders.push(acknowledged);
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

  private async rejectOrder(
    plan: ExecutionPlan,
    planned: ExecutionPlan['orders'][number],
    now: string,
    clientOrderId: string,
    referencePrice: Price,
    reason?: string,
  ): Promise<ManagedOrder> {
    if (reason) {
      console.warn(`[LiveExecutor] rejecting order for plan ${plan.id}: ${reason}`);
    }
    const rejected = this.buildRejectedOrder(plan, planned, now, clientOrderId, referencePrice);
    await this.deps.onOrderStateChange?.(rejected);
    return rejected;
  }

  private buildRejectedOrder(
    plan: ExecutionPlan,
    planned: ExecutionPlan['orders'][number],
    now: string,
    clientOrderId: string,
    referencePrice: Price,
  ): ManagedOrder {
    return {
      id: this.deps.idGen.orderId(),
      venueAccountId: plan.venueAccountId,
      actorType: plan.actorType,
      actorId: plan.actorId,
      executionPlanId: plan.id,
      venueRefId: undefined,
      clientOrderId,
      venue: plan.venue,
      symbol: plan.symbol,
      side: planned.side,
      type: planned.type,
      quantity: planned.quantity,
      price: planned.price,
      timeInForce: planned.timeInForce,
      postOnly: planned.postOnly,
      reduceOnly: planned.reduceOnly,
      referencePrice,
      status: 'rejected',
      submissionState: 'terminal',
      submitAttemptedAt: undefined,
      acknowledgedAt: undefined,
      filledQuantity: quantity('0'),
      avgFillPrice: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }
}
