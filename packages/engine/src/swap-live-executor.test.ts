import { describe, it, expect, vi } from 'vitest';
import { ok, err, quantity, price } from '@herobids/domain';
import type { SwapVenuePort, SwapQuote, SwapReceipt } from '@herobids/domain';
import { SwapLiveExecutor } from './swap-live-executor.js';
import type { ExecutionPlan } from './planner.js';
import type { IdGenerator } from './paper-executor.js';

function makeIdGen(): IdGenerator {
  let orderCount = 0;
  let fillCount = 0;
  return {
    orderId: () => `o-${++orderCount}` as ReturnType<IdGenerator['orderId']>,
    fillId: () => `f-${++fillCount}` as ReturnType<IdGenerator['fillId']>,
  };
}

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-1',
    decisionId: 'dec-1',
    venueAccountId: 'va-1',
    actorType: 'agent',
    actorId: 'agent-1',
    venue: 'jupiter',
    symbol: 'SOL/USDC',
    action: 'open_long',
    orders: [{
      side: 'buy',
      type: 'swap',
      quantity: quantity('10'),
      swapParams: {
        inputAsset: 'USDC_MINT',
        outputAsset: 'SOL_MINT',
        amount: quantity('1500'),
      },
    }],
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSwapVenue(overrides?: Partial<SwapVenuePort>): SwapVenuePort {
  return {
    quote: vi.fn().mockResolvedValue(ok({
      quoteData: { raw: 'data' },
      inputAsset: 'USDC_MINT',
      outputAsset: 'SOL_MINT',
      inputAmount: quantity('1500'),
      expectedOutputAmount: quantity('10'),
      minimumOutputAmount: quantity('9.5'),
      priceImpact: 0.001,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    } satisfies SwapQuote)),
    executeSwap: vi.fn().mockResolvedValue(ok({
      executionRef: 'tx-hash-123',
      inputAmount: quantity('1500'),
      outputAmount: quantity('10'),
      timestamp: '2026-06-14T10:00:00Z',
    } satisfies SwapReceipt)),
    fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: '' })),
    fetchBalance: vi.fn().mockResolvedValue(ok({ asset: '', amount: quantity('0'), timestamp: '' })),
    fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
    ...overrides,
  };
}

describe('SwapLiveExecutor', () => {
  it('emits deterministic swap submission states for recovery evidence', async () => {
    const venue = makeSwapVenue();
    const orderStateCalls: Array<{
      clientOrderId?: string;
      submissionState?: string;
      status: string;
      venueRefId?: string;
      referencePrice?: string;
    }> = [];

    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      clientOrderId: (planId, idx) => `swap:${planId}:${idx}`,
      onOrderStateChange: async (order) => {
        orderStateCalls.push({
          clientOrderId: order.clientOrderId,
          submissionState: order.submissionState,
          status: order.status,
          venueRefId: order.venueRefId,
          referencePrice: order.referencePrice?.toString(),
        });
      },
    });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(orderStateCalls).toHaveLength(4);
    expect(orderStateCalls[0]).toMatchObject({
      clientOrderId: 'swap:plan-1:0',
      submissionState: 'prepared',
      status: 'pending',
    });
    expect(orderStateCalls[1]).toMatchObject({
      submissionState: 'submit_attempting',
      status: 'pending',
    });
    expect(orderStateCalls[2]).toMatchObject({
      submissionState: 'venue_acknowledged',
      status: 'pending',
      venueRefId: 'tx-hash-123',
    });
    expect(orderStateCalls[3]).toMatchObject({
      submissionState: 'terminal',
      status: 'filled',
      venueRefId: 'tx-hash-123',
    });

    expect(result.data.orders[0]!.clientOrderId).toBe('swap:plan-1:0');
    expect(result.data.orders[0]!.referencePrice?.toString()).toBeDefined();
  });

  it('quotes, executes, and returns filled order with fill', async () => {
    const venue = makeSwapVenue();
    const executor = new SwapLiveExecutor({ swapVenue: venue, idGen: makeIdGen() });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orders).toHaveLength(1);
    expect(result.data.orders[0]!.status).toBe('filled');
    expect(result.data.orders[0]!.venueRefId).toBe('tx-hash-123');

    expect(result.data.fills).toHaveLength(1);
    expect(result.data.fills[0]!.venueRefId).toBe('tx-hash-123');
    expect(result.data.fills[0]!.quantity.toString()).toBe('10');

    expect(result.data.plan.status).toBe('completed');
  });

  it('rejects order when quote fails', async () => {
    const venue = makeSwapVenue({
      quote: vi.fn().mockResolvedValue(err({ code: 'QUOTE_FAILED', message: 'Insufficient liquidity' })),
    });
    const executor = new SwapLiveExecutor({ swapVenue: venue, idGen: makeIdGen() });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orders[0]!.status).toBe('rejected');
    expect(result.data.fills).toHaveLength(0);
    expect(result.data.plan.status).toBe('failed');
  });

  it('rejects order when execution fails', async () => {
    const venue = makeSwapVenue({
      executeSwap: vi.fn().mockResolvedValue(err({ code: 'SWAP_TX_FAILED', message: 'Transaction reverted' })),
    });
    const executor = new SwapLiveExecutor({ swapVenue: venue, idGen: makeIdGen() });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orders[0]!.status).toBe('rejected');
    expect(result.data.fills).toHaveLength(0);
    expect(result.data.plan.status).toBe('failed');
  });

  it('rejects order without swapParams', async () => {
    const venue = makeSwapVenue();
    const executor = new SwapLiveExecutor({ swapVenue: venue, idGen: makeIdGen() });

    const plan = makePlan({
      orders: [{
        side: 'buy',
        type: 'market',
        quantity: quantity('10'),
        // No swapParams
      }],
    });

    const result = await executor.execute(plan, price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orders[0]!.status).toBe('rejected');
    expect(venue.quote).not.toHaveBeenCalled();
  });

  it('handles multiple orders with mixed results', async () => {
    let quoteCallCount = 0;
    const venue = makeSwapVenue({
      quote: vi.fn().mockImplementation(async () => {
        quoteCallCount++;
        if (quoteCallCount === 2) {
          return err({ code: 'QUOTE_FAILED', message: 'No route' });
        }
        return ok({
          quoteData: {},
          inputAsset: 'USDC_MINT',
          outputAsset: 'SOL_MINT',
          inputAmount: quantity('1500'),
          expectedOutputAmount: quantity('10'),
          minimumOutputAmount: quantity('9.5'),
          priceImpact: 0.001,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
      }),
    });
    const executor = new SwapLiveExecutor({ swapVenue: venue, idGen: makeIdGen() });

    const plan = makePlan({
      orders: [
        { side: 'buy', type: 'swap', quantity: quantity('10'), swapParams: { inputAsset: 'USDC', outputAsset: 'SOL', amount: quantity('1500') } },
        { side: 'sell', type: 'swap', quantity: quantity('5'), swapParams: { inputAsset: 'SOL', outputAsset: 'USDC', amount: quantity('5') } },
      ],
    });

    const result = await executor.execute(plan, price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orders).toHaveLength(2);
    expect(result.data.orders[0]!.status).toBe('filled');
    expect(result.data.orders[1]!.status).toBe('rejected');
    expect(result.data.fills).toHaveLength(1);
    // Not all rejected, has fills → completed
    expect(result.data.plan.status).toBe('completed');
  });
});

describe('SwapLiveExecutor — state transition coverage', () => {
  it('produces Jupiter-specific execution evidence with venueRefId for recovery', async () => {
    const venue = makeSwapVenue({
      executeSwap: vi.fn().mockResolvedValue(ok({
        executionRef: 'jupiter-sig-5xK3mR...',
        inputAmount: quantity('100'),
        outputAmount: quantity('0.666'),
        timestamp: '2026-06-15T10:00:00Z',
      } satisfies SwapReceipt)),
    });

    const stateChanges: Array<{ submissionState?: string; venueRefId?: string }> = [];
    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      onOrderStateChange: async (order) => {
        stateChanges.push({ submissionState: order.submissionState, venueRefId: order.venueRefId });
      },
    });

    const plan = makePlan({ venue: 'jupiter' });
    const result = await executor.execute(plan, price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // venue_acknowledged state carries the transaction signature in the in-process callback payload
    const acknowledged = stateChanges.find(s => s.submissionState === 'venue_acknowledged');
    expect(acknowledged?.venueRefId).toBe('jupiter-sig-5xK3mR...');

    // Terminal state also preserves the signature
    const terminal = stateChanges.find(s => s.submissionState === 'terminal');
    expect(terminal?.venueRefId).toBe('jupiter-sig-5xK3mR...');
  });

  it('produces 1inch-specific execution evidence with transaction hash for recovery', async () => {
    const venue = makeSwapVenue({
      executeSwap: vi.fn().mockResolvedValue(ok({
        executionRef: '0xabc123def456...',
        inputAmount: quantity('10'),
        outputAmount: quantity('0.005'),
        timestamp: '2026-06-15T10:00:00Z',
      } satisfies SwapReceipt)),
    });

    const stateChanges: Array<{ submissionState?: string; venueRefId?: string }> = [];
    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      onOrderStateChange: async (order) => {
        stateChanges.push({ submissionState: order.submissionState, venueRefId: order.venueRefId });
      },
    });

    const plan = makePlan({ venue: '1inch' });
    const result = await executor.execute(plan, price('2000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // venue_acknowledged state carries the transaction hash in the in-process callback payload
    const acknowledged = stateChanges.find(s => s.submissionState === 'venue_acknowledged');
    expect(acknowledged?.venueRefId).toBe('0xabc123def456...');
  });

  it('enters deterministic submission states enabling restart recovery for either venue', async () => {
    const venue = makeSwapVenue();
    const states: string[] = [];
    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      onOrderStateChange: async (order) => { states.push(order.submissionState!); },
    });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);

    // Full state sequence: prepared → submit_attempting → venue_acknowledged → terminal.
    // This documents the generic swap executor state machine rather than venue-specific parity.
    expect(states).toEqual(['prepared', 'submit_attempting', 'venue_acknowledged', 'terminal']);
  });

  it('quote failure halts at prepared → terminal without ambiguous state', async () => {
    const venue = makeSwapVenue({
      quote: vi.fn().mockResolvedValue(err({ code: 'QUOTE_FAILED', message: 'No route found' })),
    });
    const states: string[] = [];
    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      onOrderStateChange: async (order) => { states.push(order.submissionState!); },
    });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only prepared → terminal — no ambiguous submit_attempting state was entered
    expect(states).toEqual(['prepared', 'terminal']);
    expect(result.data.orders[0]!.status).toBe('rejected');
  });

  it('execution failure after submit_attempting enters terminal with rejection (recovery safe)', async () => {
    const venue = makeSwapVenue({
      executeSwap: vi.fn().mockResolvedValue(err({ code: 'SWAP_TX_FAILED', message: 'Reverted' })),
    });
    const states: string[] = [];
    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      onOrderStateChange: async (order) => { states.push(order.submissionState!); },
    });

    const result = await executor.execute(makePlan(), price('150'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // prepared → submit_attempting → terminal (rejected, no venue_acknowledged)
    expect(states).toEqual(['prepared', 'submit_attempting', 'terminal']);
    expect(result.data.orders[0]!.status).toBe('rejected');
  });

  it('emits the venue_acknowledged callback payload used by confirmation pollers', async () => {
    // This test covers the in-process callback payload emitted at venue_acknowledged.
    // Persistence and restart recovery still need integration coverage at the actor/store boundary.
    const venue = makeSwapVenue({
      executeSwap: vi.fn().mockResolvedValue(ok({
        executionRef: 'tx-hash-for-poller',
        inputAmount: quantity('1500'),
        outputAmount: quantity('10'),
        timestamp: '2026-06-15T10:00:00Z',
      } satisfies SwapReceipt)),
    });

    const acknowledgedOrders: Array<{
      venueRefId?: string;
      submissionState?: string;
      clientOrderId?: string;
      status: string;
    }> = [];
    const executor = new SwapLiveExecutor({
      swapVenue: venue,
      idGen: makeIdGen(),
      clientOrderId: (planId, idx) => `swap:${planId}:${idx}`,
      onOrderStateChange: async (order) => {
        if (order.submissionState === 'venue_acknowledged') {
          acknowledgedOrders.push({
            venueRefId: order.venueRefId,
            submissionState: order.submissionState,
            clientOrderId: order.clientOrderId,
            status: order.status,
          });
        }
      },
    });

    await executor.execute(makePlan(), price('150'));

    // The venue_acknowledged callback payload must carry:
    // 1. venueRefId (the txRef the poller will check)
    // 2. status: 'pending' (not terminal yet)
    // 3. clientOrderId (for idempotent lookup)
    expect(acknowledgedOrders).toHaveLength(1);
    expect(acknowledgedOrders[0]).toMatchObject({
      venueRefId: 'tx-hash-for-poller',
      submissionState: 'venue_acknowledged',
      clientOrderId: 'swap:plan-1:0',
      status: 'pending',
    });
  });
});
