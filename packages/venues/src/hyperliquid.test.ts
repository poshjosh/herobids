import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for HyperliquidAdapter.
 * Tests construction behaviour and error-result paths without hitting the network.
 *
 * Regression coverage:
 *   Bug 2026-05-30-001 — walletAddress must be forwarded to the CCXT constructor
 *   Bug 2026-05-30-006 — fetchTicker must return an err Result (not throw) so
 *                        fetchPrice can log a warning and return null
 */

const ccxtState = vi.hoisted(() => ({
  constructorConfig: null as unknown,
  fetchTicker: vi.fn(),
  fetchPositions: vi.fn(),
  fetchBalance: vi.fn(),
  fetchOpenOrders: vi.fn(),
  fetchOrder: vi.fn(),
  fetchOrders: vi.fn(),
  fetchMyTrades: vi.fn(),
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  editOrder: vi.fn(),
  close: vi.fn(),
  setSandboxMode: vi.fn(),
  loadMarkets: vi.fn(),
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

  class MockHyperliquid {
    fetchTicker = ccxtState.fetchTicker;
    fetchPositions = ccxtState.fetchPositions;
    fetchBalance = ccxtState.fetchBalance;
    fetchOpenOrders = ccxtState.fetchOpenOrders;
    fetchOrder = ccxtState.fetchOrder;
    fetchOrders = ccxtState.fetchOrders;
    fetchMyTrades = ccxtState.fetchMyTrades;
    createOrder = ccxtState.createOrder;
    cancelOrder = ccxtState.cancelOrder;
    editOrder = ccxtState.editOrder;
    close = ccxtState.close;
    setSandboxMode = ccxtState.setSandboxMode;
    loadMarkets = ccxtState.loadMarkets;

    constructor(config: unknown) {
      ccxtState.constructorConfig = config;
    }
  }

  const defaultExport = {
    hyperliquid: MockHyperliquid,
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

vi.mock('./hyperliquid-private-stream.js', () => {
  class MockHyperliquidPrivateStream {
    constructor(config: unknown) {
      privateStreamState.config = config;
    }

    connect = privateStreamState.connect;
  }

  return {
    HyperliquidPrivateStream: MockHyperliquidPrivateStream,
  };
});

import { HyperliquidAdapter } from './hyperliquid.js';
import ccxt from 'ccxt';

const BASE_CREDS = {
  apiKey: '0xagentapikey000000000000000000000000000000',
  secret: '0xprivatekey00000000000000000000000000000000',
  walletAddress: '0xmainaccount000000000000000000000000000000',
};

let originalFetch: typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Construction — Bug 2026-05-30-001 regression
// ---------------------------------------------------------------------------

describe('HyperliquidAdapter construction', () => {
  beforeEach(() => {
    ccxtState.constructorConfig = null;
    ccxtState.setSandboxMode.mockReset();
    ccxtState.fetchOrder.mockReset();
    ccxtState.fetchOrders.mockReset();
    privateStreamState.config = null;
    privateStreamState.connect.mockClear();
  });

  it('passes walletAddress to the CCXT exchange constructor', () => {
    // Regression: without walletAddress, ccxt.hyperliquid.fetchPositions throws
    // "requires a user parameter inside 'params' or the wallet address set"
    new HyperliquidAdapter({ credentials: BASE_CREDS });

    expect(ccxtState.constructorConfig).toMatchObject({
      walletAddress: BASE_CREDS.walletAddress,
    });
  });

  it('passes apiKey and secret to the CCXT exchange constructor', () => {
    new HyperliquidAdapter({ credentials: BASE_CREDS });

    expect(ccxtState.constructorConfig).toMatchObject({
      apiKey: BASE_CREDS.apiKey,
      secret: BASE_CREDS.secret,
    });
  });

  it('does not enable sandbox mode when testnet is omitted', () => {
    new HyperliquidAdapter({ credentials: BASE_CREDS });

    expect(ccxtState.setSandboxMode).not.toHaveBeenCalled();
  });

  it('enables sandbox mode when credentials.testnet is true', () => {
    new HyperliquidAdapter({ credentials: { ...BASE_CREDS, testnet: true } });

    expect(ccxtState.setSandboxMode).toHaveBeenCalledWith(true);
  });

  it('does not enable sandbox mode when credentials.testnet is false', () => {
    new HyperliquidAdapter({ credentials: { ...BASE_CREDS, testnet: false } });

    expect(ccxtState.setSandboxMode).not.toHaveBeenCalled();
  });

  it('disables ccxt built-in rate limiting (adapter manages its own)', () => {
    new HyperliquidAdapter({ credentials: BASE_CREDS });

    expect(ccxtState.constructorConfig).toMatchObject({
      enableRateLimit: false,
    });
  });

  it('wsUrl overrides testnetWsUrl for testnet private streams', async () => {
    const adapter = new HyperliquidAdapter({
      credentials: { ...BASE_CREDS, testnet: true },
      wsUrl: 'wss://global-override.example/ws',
      testnetWsUrl: 'wss://testnet.example/ws',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://global-override.example/ws' });
  });

  it('uses testnetWsUrl when wsUrl is not set for testnet private streams', async () => {
    const adapter = new HyperliquidAdapter({
      credentials: { ...BASE_CREDS, testnet: true },
      testnetWsUrl: 'wss://testnet.example/ws',
    });

    const result = await adapter.subscribePrivate({} as never);

    expect(result.ok).toBe(true);
    expect(privateStreamState.config).toMatchObject({ wsUrl: 'wss://testnet.example/ws' });
  });

  it('supports direct lookup by venueRefId for recovery evidence', async () => {
    ccxtState.fetchOrder.mockResolvedValue({
      id: 'venue-order-1',
      clientOrderId: 'client-1',
      symbol: 'BTC/USD:USD',
      side: 'buy',
      type: 'limit',
      status: 'open',
      amount: 1,
      filled: 0,
      price: 50000,
      average: undefined,
      datetime: new Date().toISOString(),
    });

    const adapter = new HyperliquidAdapter({ credentials: BASE_CREDS });
    const result = await adapter.fetchOrderByVenueRefId('venue-order-1', 'BTC/USD:USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.venueRefId).toBe('venue-order-1');
      expect(result.data?.status).toBe('open');
    }
  });

  it('supports direct lookup by clientOrderId for recovery evidence', async () => {
    ccxtState.fetchOpenOrders.mockResolvedValue([
      {
        id: 'venue-order-2',
        clientOrderId: 'client-2',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        type: 'limit',
        status: 'open',
        amount: 1,
        filled: 0,
        price: 50000,
        datetime: new Date().toISOString(),
      },
    ]);

    const adapter = new HyperliquidAdapter({ credentials: BASE_CREDS });
    const result = await adapter.fetchOrderByClientOrderId('client-2', 'BTC/USD:USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.venueRefId).toBe('venue-order-2');
      expect(result.data?.clientOrderId).toBe('client-2');
    }
  });
});

describe('HyperliquidAdapter.probe', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the configured testnetBaseUrl when probing testnet symbols', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ universe: [{ name: 'ETH' }, { name: 'BTC' }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const profile = await HyperliquidAdapter.probe({
      apiKey: 'key',
      secret: 'secret',
      walletAddress: '0xmainaccount000000000000000000000000000000',
      testnet: true,
    }, {
      testnetBaseUrl: 'https://hyperliquid-testnet.example',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hyperliquid-testnet.example/info',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(profile.availableSymbols).toEqual(['ETH-PERP', 'BTC-PERP']);
  });

  it('falls back to baseUrl when testnetBaseUrl is not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ universe: [{ name: 'SOL' }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const profile = await HyperliquidAdapter.probe(undefined, {
      baseUrl: 'https://hyperliquid-mainnet.example',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hyperliquid-mainnet.example/info',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(profile.availableSymbols).toEqual(['SOL-PERP']);
  });

  it('prefers baseUrl when both mainnet and testnet URLs are configured without credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ universe: [{ name: 'ETH' }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const profile = await HyperliquidAdapter.probe(undefined, {
      baseUrl: 'https://hyperliquid-mainnet.example',
      testnetBaseUrl: 'https://hyperliquid-testnet.example',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hyperliquid-mainnet.example/info',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(profile.availableSymbols).toEqual(['ETH-PERP']);
  });

  it('ignores baseUrl for testnet probing when testnetBaseUrl is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ universe: [{ name: 'BTC' }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const profile = await HyperliquidAdapter.probe({
      apiKey: 'key',
      secret: 'secret',
      walletAddress: '0xmainaccount000000000000000000000000000000',
      testnet: true,
    }, {
      baseUrl: 'https://hyperliquid-mainnet.example',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.hyperliquid-testnet.xyz/info',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(profile.availableSymbols).toEqual(['BTC-PERP']);
  });

  it('defaults to the mainnet URL when no explicit probe URL is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ universe: [] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await HyperliquidAdapter.probe(undefined, {});

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.hyperliquid.xyz/info',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchTicker error path — Bug 2026-05-30-006 regression
//
// fetchPrice in apps/worker/src/index.ts relies on fetchTicker returning an
// err Result (not throwing) so it can log a warning.  These tests verify the
// adapter wraps every CCXT exception in an err Result.
// ---------------------------------------------------------------------------

describe('HyperliquidAdapter.fetchTicker error path', () => {
  let adapter: HyperliquidAdapter;

  beforeEach(() => {
    ccxtState.fetchTicker.mockReset();
    adapter = new HyperliquidAdapter({ credentials: BASE_CREDS });
  });

  it('returns err with venue.exchange_error when exchange throws for unknown symbol', async () => {
    // Regression: wrong symbol format (e.g. ETH/USD:USD instead of ETH/USDC:USDC)
    // causes ccxt to throw.  The adapter must return err(...) so fetchPrice
    // can detect the failure and log a warning instead of silently returning null.
    const thrown = new ccxt.ExchangeError(
      "hyperliquid does not have market symbol 'ETH/USD:USD'",
    );
    ccxtState.fetchTicker.mockRejectedValue(thrown);

    const result = await adapter.fetchTicker('ETH/USD:USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('venue.exchange_error');
      expect(result.error.message).toContain('does not have market symbol');
    }
  });

  it('returns err with venue.network_error when exchange throws NetworkError', async () => {
    const thrown = new ccxt.NetworkError('connection refused');
    ccxtState.fetchTicker.mockRejectedValue(thrown);

    const result = await adapter.fetchTicker('ETH/USDC:USDC');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('venue.network_error');
    }
  });

  it('returns err with venue.rate_limited when exchange throws RateLimitExceeded', async () => {
    const thrown = new ccxt.RateLimitExceeded('too many requests');
    ccxtState.fetchTicker.mockRejectedValue(thrown);

    const result = await adapter.fetchTicker('ETH/USDC:USDC');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('venue.rate_limited');
    }
  });

  it('returns err with venue.unknown for unexpected errors', async () => {
    ccxtState.fetchTicker.mockRejectedValue(new Error('unexpected internal error'));

    const result = await adapter.fetchTicker('ETH/USDC:USDC');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('venue.unknown');
    }
  });

  it('returns ok with structured Ticker when fetch succeeds', async () => {
    ccxtState.fetchTicker.mockResolvedValue({
      last: 3200.5,
      bid: 3200.0,
      ask: 3201.0,
      datetime: '2026-05-30T00:00:00.000Z',
    });

    const result = await adapter.fetchTicker('ETH/USDC:USDC');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.symbol).toBe('ETH/USDC:USDC');
      expect(result.data.last.toString()).toBe('3200.5');
      expect(result.data.timestamp).toBe('2026-05-30T00:00:00.000Z');
    }
  });

  it('falls back to current time when exchange returns no datetime', async () => {
    ccxtState.fetchTicker.mockResolvedValue({
      last: 100,
      bid: null,
      ask: null,
      datetime: null,
    });

    const result = await adapter.fetchTicker('BTC/USDC:USDC');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.timestamp).toBeDefined();
      expect(new Date(result.data.timestamp).getTime()).toBeGreaterThan(0);
    }
  });
});
