import { describe, it, expect, vi } from 'vitest';
import { createOrderbookVenueStateLoader, createSwapVenueStateLoader } from './venue-state-loaders.js';
import { ok, err, quantity, price } from '@herobids/domain';
import type { OrderbookVenuePort, SwapVenuePort } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { FULL_CAPABILITIES } from '@herobids/tests/fixtures/venue-capabilities.js';
import { Decimal } from '@herobids/domain';

function makeLogger() {
  return { error: vi.fn() };
}

// --- Orderbook loader ---

function makeOrderbookVenue(overrides: Partial<{
  positions: Result<any, any>;
  balances: Result<any, any>;
  fills: Result<any, any>;
  orders: Result<any, any>;
}> = {}): OrderbookVenuePort {
  return {
    getCapabilities: () => FULL_CAPABILITIES,
    fetchPositions: vi.fn().mockResolvedValue(overrides.positions ?? ok([])),
    fetchBalances: vi.fn().mockResolvedValue(overrides.balances ?? ok({ balances: [], timestamp: '2026-05-24T12:00:00Z' })),
    fetchRecentFills: vi.fn().mockResolvedValue(overrides.fills ?? ok([])),
    fetchOpenOrders: vi.fn().mockResolvedValue(overrides.orders ?? ok([])),
    // Methods not relevant to loader
    submitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    amendOrder: vi.fn(),
    fetchTicker: vi.fn(),
    subscribePrivate: vi.fn(),
    subscribePublic: vi.fn(),
  } as unknown as OrderbookVenuePort;
}

describe('createOrderbookVenueStateLoader', () => {
  it('returns VenueState when all calls succeed', async () => {
    const positions = [{ symbol: 'BTC/USD', side: 'long', size: new Decimal('1'), entryPrice: new Decimal('50000') }];
    const balances = { balances: [{ asset: 'USDC', free: new Decimal('5000'), locked: new Decimal('0'), total: new Decimal('5000') }], timestamp: '2026-05-24T12:00:00Z' };
    const fills = [{ venueRefId: 'f1', symbol: 'BTC/USD', side: 'buy', quantity: new Decimal('1'), price: new Decimal('50000'), fee: new Decimal('5'), feeCurrency: 'USDC', filledAt: '2026-05-24T11:00:00Z' }];
    const orders = [{ venueRefId: 'o1', clientId: 'c1', symbol: 'BTC/USD', side: 'buy', type: 'limit', quantity: new Decimal('0.5'), price: new Decimal('49000'), status: 'open' }];

    const venue = makeOrderbookVenue({
      positions: ok(positions),
      balances: ok(balances),
      fills: ok(fills),
      orders: ok(orders),
    });
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    const result = await loader(new Date('2026-05-24T10:00:00Z'));

    expect(result).not.toBeNull();
    expect(result!.positions).toEqual(positions);
    expect(result!.balances).toEqual(balances);
    expect(result!.recentFills).toEqual(fills);
    expect(result!.openOrders).toEqual(orders);
  });

  it('passes since to fetchRecentFills', async () => {
    const venue = makeOrderbookVenue();
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    const since = new Date('2026-05-24T10:00:00Z');
    await loader(since);

    expect(venue.fetchRecentFills).toHaveBeenCalledWith(since);
  });

  it('passes undefined when since is null', async () => {
    const venue = makeOrderbookVenue();
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    await loader(null);

    expect(venue.fetchRecentFills).toHaveBeenCalledWith(undefined);
  });

  it('returns null and logs when positions fetch fails', async () => {
    const venue = makeOrderbookVenue({
      positions: err({ code: 'venue.network', message: 'timeout' }),
    });
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to fetch venue positions',
    );
  });

  it('returns null and logs when balances fetch fails', async () => {
    const venue = makeOrderbookVenue({
      balances: err({ code: 'venue.network', message: 'timeout' }),
    });
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to fetch venue balances',
    );
  });

  it('returns null and logs when fills fetch fails', async () => {
    const venue = makeOrderbookVenue({
      fills: err({ code: 'venue.network', message: 'timeout' }),
    });
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to fetch venue fills',
    );
  });

  it('returns null and logs when orders fetch fails', async () => {
    const venue = makeOrderbookVenue({
      orders: err({ code: 'venue.network', message: 'timeout' }),
    });
    const logger = makeLogger();
    const loader = createOrderbookVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to fetch venue orders',
    );
  });
});

// --- Swap loader ---

function makeSwapVenue(overrides: Partial<{
  balances: Result<any, any>;
  transactions: Result<any, any>;
}> = {}): SwapVenuePort {
  return {
    fetchBalances: vi.fn().mockResolvedValue(overrides.balances ?? ok({ balances: [], timestamp: '2026-05-24T12:00:00Z' })),
    fetchRecentTransactions: vi.fn().mockResolvedValue(overrides.transactions ?? ok([])),
    quote: vi.fn(),
    executeSwap: vi.fn(),
    fetchBalance: vi.fn(),
  } as unknown as SwapVenuePort;
}

describe('createSwapVenueStateLoader', () => {
  it('returns empty VenueState for empty venue', async () => {
    const venue = makeSwapVenue();
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result).not.toBeNull();
    expect(result!.positions).toEqual([]);
    expect(result!.recentFills).toEqual([]);
    expect(result!.openOrders).toEqual([]);
  });

  it('does not synthesize positions from balances (avoids false drift)', async () => {
    const venue = makeSwapVenue({
      balances: ok({
        balances: [
          { asset: 'SOL', amount: quantity('10') },
          { asset: 'USDC', amount: quantity('1000') },
        ],
        timestamp: '2026-05-24T12:00:00Z',
      }),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    // Positions should be empty — swap holdings are tracked via balance comparison only
    expect(result!.positions).toEqual([]);
  });

  it('always returns empty positions array (swap venues have no directional positions)', async () => {
    const venue = makeSwapVenue({
      balances: ok({
        balances: [
          { asset: 'SOL', amount: quantity('10') },
          { asset: 'BONK', amount: quantity('0') },
        ],
        timestamp: '2026-05-24T12:00:00Z',
      }),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    // Even with funded balances, positions is empty — reconciliation uses balance comparison
    expect(result!.positions).toEqual([]);
  });

  it('always returns empty recentFills (avoids false unknown-fill diffs in shadow mode)', async () => {
    const venue = makeSwapVenue({
      transactions: ok([
        {
          executionRef: 'tx-1',
          inputAsset: 'SOL',
          outputAsset: 'USDC',
          inputAmount: quantity('2'),
          outputAmount: quantity('300'),
          timestamp: '2026-05-24T11:00:00Z',
        },
      ]),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    // Transactions are NOT mapped to fills — doing so causes false "unknown fill" diffs
    // because shadow mode never executes real swaps
    expect(result!.recentFills).toEqual([]);
  });

  it('does not fetch transactions (not needed for balance-only reconciliation)', async () => {
    const venue = makeSwapVenue();
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    await loader(null);

    // fetchRecentTransactions should NOT be called — swap reconciliation
    // relies solely on balance comparison
    expect(venue.fetchRecentTransactions).not.toHaveBeenCalled();
  });

  it('maps balance snapshot with correct structure', async () => {
    const venue = makeSwapVenue({
      balances: ok({
        balances: [
          { asset: 'SOL', amount: quantity('5') },
        ],
        timestamp: '2026-05-24T12:00:00Z',
      }),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result!.balances.timestamp).toBe('2026-05-24T12:00:00Z');
    expect(result!.balances.balances).toHaveLength(1);
    expect(result!.balances.balances[0].asset).toBe('SOL');
    expect(result!.balances.balances[0].free.toString()).toBe('5');
    expect(result!.balances.balances[0].locked.toString()).toBe('0');
    expect(result!.balances.balances[0].total.toString()).toBe('5');
  });

  it('returns null when balances fail', async () => {
    const venue = makeSwapVenue({
      balances: err({ code: 'swap.network', message: 'rpc error' }),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to fetch swap venue balances',
    );
  });

  it('succeeds even when transactions endpoint would fail (not called)', async () => {
    const venue = makeSwapVenue({
      transactions: err({ code: 'swap.network', message: 'rpc error' }),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    // Should succeed because transactions are not fetched
    expect(result).not.toBeNull();
    expect(result!.recentFills).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('always sets openOrders to empty array', async () => {
    const venue = makeSwapVenue({
      balances: ok({
        balances: [{ asset: 'SOL', amount: quantity('5') }],
        timestamp: 'ts',
      }),
      transactions: ok([]),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    expect(result!.openOrders).toEqual([]);
  });

  // --- BUG-006 regression: swap balances must never produce positions (false drift) ---

  it('returns empty positions even with many non-zero balances (regression: false drift)', async () => {
    const venue = makeSwapVenue({
      balances: ok({
        balances: [
          { asset: 'SOL', amount: quantity('100') },
          { asset: 'USDC', amount: quantity('50000') },
          { asset: 'BONK', amount: quantity('999999') },
          { asset: 'JUP', amount: quantity('500') },
        ],
        timestamp: '2026-05-24T12:00:00Z',
      }),
    });
    const logger = makeLogger();
    const loader = createSwapVenueStateLoader(venue, logger);

    const result = await loader(null);

    // No positions should be synthesized — engine position tracker never tracks swap balances.
    // Synthesizing them caused reconciliation to always report drift.
    expect(result!.positions).toEqual([]);
    // Balances are still tracked for balance-level comparison
    expect(result!.balances.balances).toHaveLength(4);
  });
});
