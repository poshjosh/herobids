import { beforeEach, describe, expect, it, vi } from 'vitest';

const ccxtState = vi.hoisted(() => ({
  isUnifiedEnabled: vi.fn(),
  fetchBalance: vi.fn(),
  fetchPositions: vi.fn(),
  fetchOpenOrders: vi.fn(),
  fetchOrder: vi.fn(),
  fetchOrders: vi.fn(),
  fetchMyTrades: vi.fn(),
  fetchTicker: vi.fn(),
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  editOrder: vi.fn(),
  close: vi.fn(),
  setSandboxMode: vi.fn(),
}));

const privateStreamState = vi.hoisted(() => ({
  config: null as unknown,
  connect: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
}));

vi.mock('ccxt', () => {
  class RateLimitExceeded extends Error {}
  class AuthenticationError extends Error {}
  class InsufficientFunds extends Error {}
  class InvalidOrder extends Error {}
  class OrderNotFound extends Error {}
  class NetworkError extends Error {}
  class ExchangeError extends Error {}

  class MockBybit {
    setSandboxMode = ccxtState.setSandboxMode;
    isUnifiedEnabled = ccxtState.isUnifiedEnabled;
    fetchBalance = ccxtState.fetchBalance;
    fetchPositions = ccxtState.fetchPositions;
    fetchOpenOrders = ccxtState.fetchOpenOrders;
    fetchOrder = ccxtState.fetchOrder;
    fetchOrders = ccxtState.fetchOrders;
    fetchMyTrades = ccxtState.fetchMyTrades;
    fetchTicker = ccxtState.fetchTicker;
    createOrder = ccxtState.createOrder;
    cancelOrder = ccxtState.cancelOrder;
    editOrder = ccxtState.editOrder;
    close = ccxtState.close;

    constructor(_config: unknown) {}
  }

  const defaultExport = {
    bybit: MockBybit,
    RateLimitExceeded,
    AuthenticationError,
    InsufficientFunds,
    InvalidOrder,
    OrderNotFound,
    NetworkError,
    ExchangeError,
  };

  return {
    default: defaultExport,
    RateLimitExceeded,
    AuthenticationError,
    InsufficientFunds,
    InvalidOrder,
    OrderNotFound,
    NetworkError,
    ExchangeError,
  };
});

vi.mock('./bybit-private-stream.js', () => {
  class MockBybitPrivateStream {
    constructor(config: unknown) {
      privateStreamState.config = config;
    }

    connect = privateStreamState.connect;
  }

  return {
    BybitPrivateStream: MockBybitPrivateStream,
  };
});

import { BybitAdapter } from './bybit.js';
import ccxt from 'ccxt';

describe('BybitAdapter account-mode routing', () => {
  beforeEach(() => {
    ccxtState.isUnifiedEnabled.mockReset();
    ccxtState.isUnifiedEnabled.mockResolvedValue([false, true]);
    ccxtState.fetchBalance.mockReset();
    ccxtState.fetchPositions.mockReset();
    ccxtState.fetchOpenOrders.mockReset();
    ccxtState.fetchOrder.mockReset();
    ccxtState.fetchOrders.mockReset();
    ccxtState.fetchMyTrades.mockReset();
    ccxtState.fetchTicker.mockReset();
    ccxtState.createOrder.mockReset();
    ccxtState.cancelOrder.mockReset();
    ccxtState.editOrder.mockReset();
    ccxtState.close.mockReset();
    ccxtState.setSandboxMode.mockReset();
    privateStreamState.config = null;
    privateStreamState.connect.mockClear();
  });

  it('routes standard-account balances to the derivatives wallet', async () => {
    ccxtState.isUnifiedEnabled.mockResolvedValue([false, false]);
    ccxtState.fetchBalance.mockResolvedValue({
      total: { USDT: 10 },
      free: { USDT: 7 },
      used: { USDT: 3 },
      info: {},
    });

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    expect(ccxtState.fetchBalance).toHaveBeenCalledWith({ type: 'swap', subType: 'linear' });
  });

  it('keeps unified-account balances on the unified wallet', async () => {
    ccxtState.isUnifiedEnabled.mockResolvedValue([false, true]);
    ccxtState.fetchBalance.mockResolvedValue({
      total: { USDT: 10 },
      free: { USDT: 7 },
      used: { USDT: 3 },
      info: {},
    });

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    expect(ccxtState.fetchBalance).toHaveBeenCalledWith();
  });

  it('routes standard-account positions to linear swap params', async () => {
    ccxtState.isUnifiedEnabled.mockResolvedValue([false, false]);
    ccxtState.fetchPositions.mockResolvedValue([
      {
        symbol: 'BTC/USDT:USDT',
        contracts: 1,
        side: 'long',
        entryPrice: 67000,
        unrealizedPnl: 12.5,
        leverage: 5,
      },
    ]);

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    const result = await adapter.fetchPositions();

    expect(result.ok).toBe(true);
    expect(ccxtState.fetchPositions).toHaveBeenCalledWith(undefined, { type: 'swap', subType: 'linear' });
  });

  it('defaults to unified when isUnifiedEnabled throws AuthenticationError', async () => {
    ccxtState.isUnifiedEnabled.mockRejectedValue(new ccxt.AuthenticationError('permission denied'));
    ccxtState.fetchBalance.mockResolvedValue({
      total: { USDT: 10 },
      free: { USDT: 7 },
      used: { USDT: 3 },
      info: {},
    });

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    // Unified accounts don't pass extra params
    expect(ccxtState.fetchBalance).toHaveBeenCalledWith();
  });

  it('retries account-mode detection after transient NetworkError', async () => {
    ccxtState.isUnifiedEnabled
      .mockRejectedValueOnce(new ccxt.NetworkError('timeout'))
      .mockResolvedValueOnce([false, false]);
    ccxtState.fetchBalance.mockResolvedValue({
      total: { USDT: 5 },
      free: { USDT: 5 },
      used: { USDT: 0 },
      info: {},
    });

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    // First call — NetworkError propagates through withRateLimit → mapped to venue.network_error
    const result1 = await adapter.fetchBalances();
    expect(result1.ok).toBe(false);
    if (!result1.ok) {
      expect(result1.error.code).toBe('venue.network_error');
    }

    // Second call — detection retries (promise was cleared), succeeds as standard
    const result2 = await adapter.fetchBalances();
    expect(result2.ok).toBe(true);
    expect(ccxtState.fetchBalance).toHaveBeenLastCalledWith({ type: 'swap', subType: 'linear' });
  });

  it('wsUrl overrides wsPrivateUrl for live private streams', async () => {
    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret', testnet: false },
      wsUrl: 'wss://global-override.example/private',
      wsPrivateUrl: 'wss://live.example/private',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://global-override.example/private' });
  });

  it('uses wsPrivateUrl when wsUrl is not set for live private streams', async () => {
    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret', testnet: false },
      wsPrivateUrl: 'wss://live.example/private',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://live.example/private' });
  });

  it('prefers wsTestnetPrivateUrl over built-in default for testnet private streams', async () => {
    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret', testnet: true },
      wsTestnetPrivateUrl: 'wss://testnet.example/private',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://testnet.example/private' });
  });

  it('wsUrl overrides wsTestnetPrivateUrl for testnet private streams', async () => {
    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret', testnet: true },
      wsUrl: 'wss://global-override.example/private',
      wsTestnetPrivateUrl: 'wss://testnet.example/private',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://global-override.example/private' });
  });

  it('wsUrl is used for testnet private streams when no testnet URL is configured', async () => {
    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret', testnet: true },
      wsUrl: 'wss://global-override.example/private',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://global-override.example/private' });
  });

  it('falls back to the built-in mainnet private stream when no URL is configured', async () => {
    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret', testnet: false },
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://stream.bybit.com/v5/private' });
  });

  it('supports direct lookup by venueRefId for recovery evidence', async () => {
    ccxtState.fetchOrder.mockResolvedValue({
      id: 'venue-order-1',
      clientOrderId: 'client-1',
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'limit',
      status: 'open',
      amount: 1,
      filled: 0,
      price: 50000,
      average: undefined,
      datetime: new Date().toISOString(),
    });

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    const result = await adapter.fetchOrderByVenueRefId('venue-order-1', 'BTC/USDT:USDT');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.venueRefId).toBe('venue-order-1');
      expect(result.data?.status).toBe('open');
    }
  });

  it('supports direct lookup by clientOrderId for recovery evidence', async () => {
    ccxtState.fetchOpenOrders.mockResolvedValue([{ id: 'venue-order-2', clientOrderId: 'client-2', symbol: 'BTC/USDT:USDT', side: 'buy', type: 'limit', status: 'open', amount: 1, filled: 0, price: 50000, datetime: new Date().toISOString() }]);

    const adapter = new BybitAdapter({
      credentials: { apiKey: 'key', secret: 'secret' },
    });

    const result = await adapter.fetchOrderByClientOrderId('client-2', 'BTC/USDT:USDT');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.venueRefId).toBe('venue-order-2');
      expect(result.data?.clientOrderId).toBe('client-2');
    }
  });
});