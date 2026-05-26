import { describe, it, expect, vi } from 'vitest';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { price, quantity, ok, err } from '@herobids/domain';
import type { OrderId, FillId, TradingInstanceId } from '@herobids/domain';
import { InMemoryJournal } from '@herobids/engine';
import type { JournalEventType } from '@herobids/engine';

/**
 * Cross-venue lifecycle integration test (Phase 2c §4).
 *
 * Runs the same strategy decision (go_long) through both an orderbook venue
 * and a swap venue, then asserts that the journal events, fill records,
 * position records, and reconciliation persistence share matching shapes.
 */

function makeIdGen() {
  let c = 0;
  return {
    orderId: () => `o-${++c}` as OrderId,
    fillId: () => `f-${++c}` as FillId,
    planId: () => `p-${++c}`,
    decisionId: () => `d-${++c}`,
  };
}

function stubRepo() {
  return {
    insertFill: vi.fn().mockResolvedValue('fill-id'),
    getRecentByInstance: vi.fn().mockResolvedValue([]),
    getRecentByVenueAccount: vi.fn().mockResolvedValue([]),
    getOpenByInstance: vi.fn().mockResolvedValue([]),
    getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    insertSnapshot: vi.fn().mockResolvedValue('snap-id'),
    upsert: vi.fn().mockResolvedValue(undefined),
    insertPlan: vi.fn().mockResolvedValue(undefined),
    markExecuting: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    getIncomplete: vi.fn().mockResolvedValue([]),
    getByExecutionPlanId: vi.fn().mockResolvedValue([]),
    upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    insertDecision: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    getLastReconciledAt: vi.fn().mockResolvedValue(null),
    getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
  };
}

function makeOrderbookDeps(journal: InMemoryJournal): TradingActorDeps {
  const repo = stubRepo();
  return {
    strategy: {
      evaluate: vi.fn()
        .mockResolvedValueOnce(ok({
          id: 'd-ob-1',
          tradingInstanceId: 'inst-orderbook' as TradingInstanceId,
          instrumentId: 'BTC/USD:USD',
          intent: 'go_long',
          targetSize: quantity('1'),
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValue(ok(null)),
    } as any,
    journal,
    fillRepo: repo as any,
    positionRepo: repo as any,
    planRepo: repo as any,
    orderRepo: repo as any,
    decisionRepo: repo as any,
    balanceSnapshotRepo: repo as any,
    reconciliationRepo: repo as any,
    riskLimits: {
      maxPositionSize: quantity('100'),
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
    },
    idGen: makeIdGen(),
    fetchPrice: vi.fn().mockResolvedValue({ symbol: 'BTC/USD:USD', price: price('50000'), timestamp: new Date().toISOString() }),
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    venueAccountId: 'va-ob',
    executionMode: 'paper',
    venueType: 'orderbook',
  };
}

function makeSwapDeps(journal: InMemoryJournal): TradingActorDeps {
  const repo = stubRepo();
  const swapVenue = {
    fetchBalances: vi.fn().mockResolvedValue(ok({
      balances: [
        { asset: 'USDC', amount: quantity('10000') },
        { asset: 'SOL', amount: quantity('50') },
      ],
      timestamp: new Date().toISOString(),
    })),
    fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
    quote: vi.fn().mockResolvedValue(ok({
      quoteData: {},
      inputAsset: 'USDC',
      outputAsset: 'SOL',
      inputAmount: quantity('150'),
      expectedOutputAmount: quantity('1'),
      minimumOutputAmount: quantity('0.99'),
      priceImpact: 0.01,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    executeSwap: vi.fn(),
    fetchBalance: vi.fn(),
  } as any;

  return {
    strategy: {
      evaluate: vi.fn()
        .mockResolvedValueOnce(ok({
          id: 'd-sw-1',
          tradingInstanceId: 'inst-swap' as TradingInstanceId,
          instrumentId: 'SOL/USDC',
          intent: 'go_long',
          targetSize: quantity('1'),
          timestamp: new Date().toISOString(),
        }))
        .mockResolvedValue(ok(null)),
    } as any,
    journal,
    fillRepo: repo as any,
    positionRepo: repo as any,
    planRepo: repo as any,
    orderRepo: repo as any,
    decisionRepo: repo as any,
    balanceSnapshotRepo: repo as any,
    reconciliationRepo: repo as any,
    riskLimits: {
      maxPositionSize: quantity('100'),
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
    },
    idGen: makeIdGen(),
    fetchPrice: vi.fn().mockResolvedValue({ symbol: 'SOL/USDC', price: price('150'), timestamp: new Date().toISOString() }),
    venue: 'jupiter',
    symbol: 'SOL/USDC',
    venueAccountId: 'va-sw',
    executionMode: 'paper',
    venueType: 'swap',
    swapVenue,
    swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
  };
}

describe('Cross-venue unified lifecycle (Phase 2c §4)', () => {
  it('same strategy produces identical journal event type taxonomy on both venue types', async () => {
    const obJournal = new InMemoryJournal();
    const swJournal = new InMemoryJournal();

    const obDeps = makeOrderbookDeps(obJournal);
    const swDeps = makeSwapDeps(swJournal);

    const obActor = new TradingActor('inst-orderbook', {}, obDeps, 60_000);
    const swActor = new TradingActor('inst-swap', {}, swDeps, 60_000);

    await obActor.start();
    await swActor.start();
    await new Promise((r) => setTimeout(r, 150));
    await obActor.stop();
    await swActor.stop();

    // Both actors should have produced journal entries
    expect(obJournal.entries.length).toBeGreaterThan(0);
    expect(swJournal.entries.length).toBeGreaterThan(0);

    // Extract ordered event type sequences (ignoring timestamps and payload details)
    const obTypes = obJournal.entries.map((e) => e.type);
    const swTypes = swJournal.entries.map((e) => e.type);

    // Both must contain the same lifecycle events in the same order
    expect(obTypes).toEqual(swTypes);

    // Specifically verify the expected event types for a single open-long paper flow
    const expectedEvents: JournalEventType[] = [
      'decision.created',
      'plan.created',
      'fill.recorded',
      'plan.completed',
      'order.filled',
    ];
    for (const evt of expectedEvents) {
      expect(obTypes).toContain(evt);
      expect(swTypes).toContain(evt);
    }
  });

  it('both venue types produce fill records with the same schema fields', async () => {
    const obJournal = new InMemoryJournal();
    const swJournal = new InMemoryJournal();

    const obDeps = makeOrderbookDeps(obJournal);
    const swDeps = makeSwapDeps(swJournal);

    const obActor = new TradingActor('inst-ob-fill', {}, obDeps, 60_000);
    const swActor = new TradingActor('inst-sw-fill', {}, swDeps, 60_000);

    await obActor.start();
    await swActor.start();
    await new Promise((r) => setTimeout(r, 150));
    await obActor.stop();
    await swActor.stop();

    // Both should have persisted fills via insertFill
    const obFillCalls = (obDeps.fillRepo as any).insertFill.mock.calls;
    const swFillCalls = (swDeps.fillRepo as any).insertFill.mock.calls;
    expect(obFillCalls.length).toBeGreaterThan(0);
    expect(swFillCalls.length).toBeGreaterThan(0);

    const obFill = obFillCalls[0][0];
    const swFill = swFillCalls[0][0];

    // Same schema fields present on both
    const requiredFields = ['orderId', 'tradingInstanceId', 'venue', 'symbol', 'side', 'quantity', 'price', 'filledAt'];
    for (const field of requiredFields) {
      expect(obFill).toHaveProperty(field);
      expect(swFill).toHaveProperty(field);
    }

    // Type parity: both strings/dates in the same format
    expect(typeof obFill.quantity).toBe(typeof swFill.quantity);
    expect(typeof obFill.price).toBe(typeof swFill.price);
    expect(obFill.filledAt).toBeInstanceOf(Date);
    expect(swFill.filledAt).toBeInstanceOf(Date);
  });

  it('both venue types produce position records with the same schema', async () => {
    const obJournal = new InMemoryJournal();
    const swJournal = new InMemoryJournal();

    const obDeps = makeOrderbookDeps(obJournal);
    const swDeps = makeSwapDeps(swJournal);

    const obActor = new TradingActor('inst-ob-pos', {}, obDeps, 60_000);
    const swActor = new TradingActor('inst-sw-pos', {}, swDeps, 60_000);

    await obActor.start();
    await swActor.start();
    await new Promise((r) => setTimeout(r, 150));
    await obActor.stop();
    await swActor.stop();

    // Both should have persisted positions via positionRepo.upsert
    const obPosCalls = (obDeps.positionRepo as any).upsert.mock.calls;
    const swPosCalls = (swDeps.positionRepo as any).upsert.mock.calls;
    expect(obPosCalls.length).toBeGreaterThan(0);
    expect(swPosCalls.length).toBeGreaterThan(0);

    const obPos = obPosCalls[0][0];
    const swPos = swPosCalls[0][0];

    // Same schema fields
    const requiredFields = ['tradingInstanceId', 'venueAccountId', 'venue', 'symbol', 'side', 'size', 'entryPrice', 'realizedPnl'];
    for (const field of requiredFields) {
      expect(obPos).toHaveProperty(field);
      expect(swPos).toHaveProperty(field);
    }

    // Both opened long
    expect(obPos.side).toBe('long');
    expect(swPos.side).toBe('long');

    // Size is a string in both
    expect(typeof obPos.size).toBe('string');
    expect(typeof swPos.size).toBe('string');
  });

  it('reconciliation produces matching persistence shapes for both venue types', async () => {
    const obJournal = new InMemoryJournal();
    const swJournal = new InMemoryJournal();

    const obRepo = stubRepo();
    const swRepo = stubRepo();

    // Orderbook venue with reconciliation enabled
    const obVenuePort = {
      fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49999'), ask: price('50001'), timestamp: new Date().toISOString() })),
      fetchPositions: vi.fn().mockResolvedValue(ok([])),
      fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [{ asset: 'USD', free: quantity('10000'), locked: quantity('0'), total: quantity('10000') }], timestamp: new Date().toISOString() })),
      fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
      fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
      subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
    } as any;

    const obDeps: TradingActorDeps = {
      strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      journal: obJournal,
      fillRepo: obRepo as any,
      positionRepo: obRepo as any,
      planRepo: obRepo as any,
      orderRepo: obRepo as any,
      decisionRepo: obRepo as any,
      balanceSnapshotRepo: obRepo as any,
      reconciliationRepo: obRepo as any,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      idGen: makeIdGen(),
      fetchPrice: vi.fn().mockResolvedValue({ symbol: 'BTC/USD:USD', price: price('50000'), timestamp: new Date().toISOString() }),
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-ob-recon',
      executionMode: 'shadow',
      venueType: 'orderbook',
      venuePort: obVenuePort,
      reconciliationConfig: { intervalMs: 60_000, driftAlertOnly: true },
    };

    // Swap venue with reconciliation enabled
    const swapVenue = {
      fetchBalances: vi.fn().mockResolvedValue(ok({
        balances: [{ asset: 'USDC', amount: quantity('5000') }, { asset: 'SOL', amount: quantity('20') }],
        timestamp: new Date().toISOString(),
      })),
      fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      quote: vi.fn().mockResolvedValue(ok({
        quoteData: {},
        inputAsset: 'USDC',
        outputAsset: 'SOL',
        inputAmount: quantity('150'),
        expectedOutputAmount: quantity('1'),
        minimumOutputAmount: quantity('0.99'),
        priceImpact: 0.01,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      executeSwap: vi.fn(),
      fetchBalance: vi.fn(),
    } as any;

    const swDeps: TradingActorDeps = {
      strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      journal: swJournal,
      fillRepo: swRepo as any,
      positionRepo: swRepo as any,
      planRepo: swRepo as any,
      orderRepo: swRepo as any,
      decisionRepo: swRepo as any,
      balanceSnapshotRepo: swRepo as any,
      reconciliationRepo: swRepo as any,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      idGen: makeIdGen(),
      fetchPrice: vi.fn().mockResolvedValue({ symbol: 'SOL/USDC', price: price('150'), timestamp: new Date().toISOString() }),
      venue: 'jupiter',
      symbol: 'SOL/USDC',
      venueAccountId: 'va-sw-recon',
      executionMode: 'shadow',
      venueType: 'swap',
      swapVenue,
      swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
      reconciliationConfig: { intervalMs: 60_000, driftAlertOnly: true },
    };

    const obActor = new TradingActor('inst-ob-recon', {}, obDeps, 60_000);
    const swActor = new TradingActor('inst-sw-recon', {}, swDeps, 60_000);

    await obActor.start();
    await swActor.start();
    await new Promise((r) => setTimeout(r, 150));
    await obActor.stop();
    await swActor.stop();

    // Both should have persisted reconciliation events
    const obReconCalls = obRepo.insert.mock.calls;
    const swReconCalls = swRepo.insert.mock.calls;
    expect(obReconCalls.length).toBeGreaterThan(0);
    expect(swReconCalls.length).toBeGreaterThan(0);

    const obRecon = obReconCalls[0][0];
    const swRecon = swReconCalls[0][0];

    // Same top-level schema
    const requiredFields = ['tradingInstanceId', 'venueAccountId', 'result', 'localState', 'venueState', 'diff'];
    for (const field of requiredFields) {
      expect(obRecon).toHaveProperty(field);
      expect(swRecon).toHaveProperty(field);
    }

    // Both have structured local/venue state
    expect(obRecon.localState).toHaveProperty('positions');
    expect(obRecon.localState).toHaveProperty('balances');
    expect(obRecon.localState).toHaveProperty('recentFills');
    expect(obRecon.localState).toHaveProperty('openOrders');

    expect(swRecon.localState).toHaveProperty('positions');
    expect(swRecon.localState).toHaveProperty('balances');
    expect(swRecon.localState).toHaveProperty('recentFills');
    expect(swRecon.localState).toHaveProperty('openOrders');

    expect(obRecon.venueState).toHaveProperty('positions');
    expect(obRecon.venueState).toHaveProperty('balances');
    expect(obRecon.venueState).toHaveProperty('recentFills');
    expect(obRecon.venueState).toHaveProperty('openOrders');

    expect(swRecon.venueState).toHaveProperty('positions');
    expect(swRecon.venueState).toHaveProperty('balances');
    expect(swRecon.venueState).toHaveProperty('recentFills');
    expect(swRecon.venueState).toHaveProperty('openOrders');

    // Both persisted balance snapshots
    const obSnapCalls = obRepo.insertSnapshot.mock.calls;
    const swSnapCalls = swRepo.insertSnapshot.mock.calls;
    expect(obSnapCalls.length).toBeGreaterThan(0);
    expect(swSnapCalls.length).toBeGreaterThan(0);

    const obSnap = obSnapCalls[0][0];
    const swSnap = swSnapCalls[0][0];

    // Balance snapshot schema parity
    expect(obSnap).toHaveProperty('venueAccountId');
    expect(obSnap).toHaveProperty('venue');
    expect(obSnap).toHaveProperty('balances');
    expect(obSnap).toHaveProperty('snapshotAt');

    expect(swSnap).toHaveProperty('venueAccountId');
    expect(swSnap).toHaveProperty('venue');
    expect(swSnap).toHaveProperty('balances');
    expect(swSnap).toHaveProperty('snapshotAt');

    // Both balance arrays have the same shape per entry
    expect(Array.isArray(obSnap.balances)).toBe(true);
    expect(Array.isArray(swSnap.balances)).toBe(true);
    if (obSnap.balances.length > 0 && swSnap.balances.length > 0) {
      const obEntry = obSnap.balances[0];
      const swEntry = swSnap.balances[0];
      expect(obEntry).toHaveProperty('asset');
      expect(obEntry).toHaveProperty('total');
      expect(swEntry).toHaveProperty('asset');
      expect(swEntry).toHaveProperty('total');
    }
  });
});
