/**
 * SwapLiveExecutor — submits real swap transactions to the venue.
 *
 * Unlike the orderbook LiveExecutor which submits market orders and waits for
 * fills from the private stream, the swap executor:
 * 1. Requests a quote from the swap venue
 * 2. Executes the swap (which signs + broadcasts the transaction)
 * 3. The fill is immediate on receipt confirmation (atomic swap semantics)
 *
 * Confirmation polling is handled by the calling layer (SwapConfirmationPoller)
 * since some venues confirm synchronously during executeSwap (1inch, Jupiter with signing).
 */

import type { Result } from '@herobids/domain';
import type { SwapVenuePort } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';
import { ok, quantity, Decimal } from '@herobids/domain';
import type { Executor, ExecutionResult, EngineError } from './executor.js';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder, FillEvent } from './order-state.js';
import type { IdGenerator } from './paper-executor.js';

export interface SwapLiveExecutorDeps {
  swapVenue: SwapVenuePort;
  idGen: IdGenerator;
  clientOrderId?: (planId: string, orderIndex: number) => string;
  onOrderStateChange?: (order: ManagedOrder) => Promise<void>;
}

export class SwapLiveExecutor implements Executor {
  constructor(private readonly deps: SwapLiveExecutorDeps) {}

  private async emitOrderState(order: ManagedOrder): Promise<void> {
    if (!this.deps.onOrderStateChange) return;
    await this.deps.onOrderStateChange(order);
  }

  async execute(plan: ExecutionPlan, _currentPrice: Price): Promise<Result<ExecutionResult, EngineError>> {
    const orders: ManagedOrder[] = [];
    const fills: FillEvent[] = [];

    for (let i = 0; i < plan.orders.length; i++) {
      const planned = plan.orders[i]!;
      const now = new Date().toISOString();
      const orderId = this.deps.idGen.orderId();
      const clientOrderId = this.deps.clientOrderId?.(plan.id, i);

      const preparedOrder: ManagedOrder = {
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
        status: 'pending',
        submissionState: 'prepared',
        filledQuantity: quantity('0'),
        avgFillPrice: undefined,
        createdAt: now,
        updatedAt: now,
      };
      await this.emitOrderState(preparedOrder);

      // Only swap orders with explicit swapParams are supported
      if (!planned.swapParams) {
        orders.push(await this.buildRejectedOrder(plan, preparedOrder, now, 'swap_executor_requires_swap_params'));
        continue;
      }

      // 1. Get quote
      const quoteResult = await this.deps.swapVenue.quote({
        inputAsset: planned.swapParams.inputAsset,
        outputAsset: planned.swapParams.outputAsset,
        amount: planned.swapParams.amount,
        slippageBps: 50, // Default slippage — configurable in future
      });

      if (!quoteResult.ok) {
        orders.push(await this.buildRejectedOrder(plan, preparedOrder, now, `quote_failed: ${quoteResult.error.message}`));
        continue;
      }

      const submitAttemptedAt = new Date().toISOString();
      const expectedPrice = planned.side === 'buy'
        ? computeEffectivePrice(quoteResult.data.inputAmount, quoteResult.data.expectedOutputAmount)
        : computeEffectivePrice(quoteResult.data.expectedOutputAmount, quoteResult.data.inputAmount);
      await this.emitOrderState({
        ...preparedOrder,
        status: 'pending',
        referencePrice: expectedPrice,
        submissionState: 'submit_attempting',
        submitAttemptedAt,
        updatedAt: submitAttemptedAt,
      });

      // 2. Execute swap (sign + broadcast + confirm)
      const execResult = await this.deps.swapVenue.executeSwap(quoteResult.data);

      if (!execResult.ok) {
        orders.push(await this.buildRejectedOrder(plan, preparedOrder, new Date().toISOString(), `execution_failed: ${execResult.error.message}`, {
          submissionState: 'terminal',
          submitAttemptedAt,
          referencePrice: expectedPrice,
        }));
        continue;
      }

      const receipt = execResult.data;

      // Fill quantity and price depend on swap direction:
      // - Buy (quote→base): filledQuantity = outputAmount (base received), price = input/output
      // - Sell (base→quote): filledQuantity = inputAmount (base sold), price = output/input
      const isBuy = planned.side === 'buy';
      const fillQuantity = isBuy ? receipt.outputAmount : receipt.inputAmount;
      const fillPrice = isBuy
        ? computeEffectivePrice(receipt.inputAmount, receipt.outputAmount)
        : computeEffectivePrice(receipt.outputAmount, receipt.inputAmount);

      const acknowledgedAt = receipt.timestamp;
      await this.emitOrderState({
        ...preparedOrder,
        venueRefId: receipt.executionRef,
        status: 'pending',
        referencePrice: expectedPrice,
        submissionState: 'venue_acknowledged',
        submitAttemptedAt,
        acknowledgedAt,
        updatedAt: acknowledgedAt,
      });

      // Swap is atomic — order is immediately filled on successful execution
      orders.push({
        id: preparedOrder.id,
        venueAccountId: plan.venueAccountId,
        actorType: plan.actorType,
        actorId: plan.actorId,
        executionPlanId: plan.id,
        venueRefId: receipt.executionRef,
        clientOrderId,
        venue: plan.venue,
        symbol: plan.symbol,
        side: planned.side,
        type: planned.type,
        quantity: planned.quantity,
        price: fillPrice,
        referencePrice: expectedPrice,
        status: 'filled',
        submissionState: 'terminal',
        submitAttemptedAt,
        acknowledgedAt,
        filledQuantity: fillQuantity,
        avgFillPrice: fillPrice,
        createdAt: preparedOrder.createdAt,
        updatedAt: receipt.timestamp,
      });

      await this.emitOrderState(orders.at(-1)!);

      fills.push({
        id: this.deps.idGen.fillId(),
        orderId: preparedOrder.id,
        venueAccountId: plan.venueAccountId,
        actorType: plan.actorType,
        actorId: plan.actorId,
        venueRefId: receipt.executionRef,
        venue: plan.venue,
        symbol: plan.symbol,
        side: planned.side,
        quantity: fillQuantity,
        price: fillPrice,
        fee: quantity('0'),
        filledAt: receipt.timestamp,
      });
    }

    // Determine plan status
    const allRejected = orders.every((o) => o.status === 'rejected');
    const anyFilled = orders.some((o) => o.status === 'filled');
    const planStatus = allRejected ? 'failed' : anyFilled ? 'completed' : 'executing';
    const completedAt = planStatus !== 'executing' ? new Date().toISOString() : undefined;

    const resultPlan: ExecutionPlan = {
      ...plan,
      status: planStatus,
      completedAt,
    };

    return ok({ plan: resultPlan, orders, fills });
  }

  private async buildRejectedOrder(
    plan: ExecutionPlan,
    preparedOrder: ManagedOrder,
    now: string,
    _reason: string,
    extra?: Partial<ManagedOrder>,
  ): Promise<ManagedOrder> {
    const rejectedOrder: ManagedOrder = {
      id: preparedOrder.id,
      venueAccountId: plan.venueAccountId,
      actorType: plan.actorType,
      actorId: plan.actorId,
      executionPlanId: plan.id,
      venueRefId: preparedOrder.venueRefId,
      clientOrderId: preparedOrder.clientOrderId,
      venue: plan.venue,
      symbol: plan.symbol,
      side: preparedOrder.side,
      type: preparedOrder.type,
      quantity: preparedOrder.quantity,
      price: preparedOrder.price,
      referencePrice: preparedOrder.referencePrice,
      status: 'rejected',
      submissionState: 'terminal',
      filledQuantity: quantity('0'),
      avgFillPrice: undefined,
      createdAt: preparedOrder.createdAt,
      updatedAt: now,
    };

    const mergedOrder = {
      ...rejectedOrder,
      ...extra,
      updatedAt: now,
    };

    await this.emitOrderState(mergedOrder);
    return mergedOrder;
  }
}

/** Compute effective price: inputAmount / outputAmount */
function computeEffectivePrice(inputAmount: Quantity, outputAmount: Quantity): Price {
  const input = new Decimal(inputAmount.toString());
  const output = new Decimal(outputAmount.toString());
  if (output.isZero()) return quantity('0') as unknown as Price;
  return input.div(output) as unknown as Price;
}
