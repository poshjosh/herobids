import type {
  OrderbookVenuePort,
  OrderCommand,
  CancelCommand,
  AmendCommand,
  OrderReceipt,
  BalanceSnapshot,
  Position,
  Ticker,
  VenueError,
  VenueOrder,
  VenueFill,
  VenueProfile,
  VenueCapabilities,
  Subscription,
  PrivateStreamHandlers,
  PublicStreamHandlers,
  MarketMetadata,
} from '@herobids/domain';
import type { OrderId } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { quantity, price } from '@herobids/domain';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { HyperliquidPrivateStream } from './hyperliquid-private-stream.js';
import type { PrivateStreamConfig } from './hyperliquid-private-stream.js';
import ccxt, { type Position as CcxtPosition } from 'ccxt';

export interface HyperliquidCredentials {
  apiKey: string;
  secret: string;
  /**
   * The main Hyperliquid account address (EVM 0x...) whose positions and
   * balances will be queried. Required for fetchPositions / fetchBalances.
   * When using an agent/API wallet, this is the parent account address.
   * When using the main wallet key directly, set this to the same address
   * as apiKey.
   */
  walletAddress: string;
  /** If true, use testnet endpoints */
  testnet?: boolean;
}

export interface HyperliquidAdapterConfig {
  credentials: HyperliquidCredentials;
  /** Rate limiter config. Default: 10 requests/second with burst of 20 */
  rateLimit?: { capacity: number; refillRate: number };
  /** Global WebSocket URL override for private streams. Takes highest priority regardless of environment. */
  wsUrl?: string;
  /** Base URL for testnet REST API. Default: https://api.hyperliquid-testnet.xyz */
  testnetBaseUrl?: string;
  /** WebSocket URL for testnet streams. Used when testnet is true and wsUrl is not set. */
  testnetWsUrl?: string;
  /** Private stream reconnection config */
  streamConfig?: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    maxReconnectAttempts?: number;
  };
}

/**
 * Hyperliquid venue adapter implementing OrderbookVenuePort.
 * Uses ccxt under the hood.
 */
export class HyperliquidAdapter implements OrderbookVenuePort {
  private static capabilitiesWarned = false;
  private readonly exchange: InstanceType<typeof ccxt.hyperliquid>;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly adapterConfig: HyperliquidAdapterConfig;

  constructor(config: HyperliquidAdapterConfig) {
    this.adapterConfig = config;
    this.exchange = new ccxt.hyperliquid({
      apiKey: config.credentials.apiKey,
      secret: config.credentials.secret,
      walletAddress: config.credentials.walletAddress,
      enableRateLimit: false, // we manage our own
    });

    if (config.credentials.testnet) {
      this.exchange.setSandboxMode(true);
    }

    this.rateLimiter = new TokenBucketRateLimiter(
      config.rateLimit ?? { capacity: 20, refillRate: 10 },
    );
  }

  // TODO: Verify actual Hyperliquid API capabilities.
  // These defaults are optimistic — Hyperliquid supports PO and reduceOnly
  // but amend-in-place semantics differ from CEX norms (modify via order ID).
  // Validate against current HL API before relying on these in live trading.
  getCapabilities(): VenueCapabilities {
    if (!HyperliquidAdapter.capabilitiesWarned) {
      HyperliquidAdapter.capabilitiesWarned = true;
      console.warn('[HyperliquidAdapter] getCapabilities() returns optimistic defaults — verify against HL API docs before live trading');
    }
    return {
      limitOrderSubmission: true,
      amendInPlace: false,
      cancelAndReplace: true,
      postOnly: true,
      reduceOnly: true,
      supportedTimeInForce: ['GTC', 'IOC', 'FOK', 'PO'],
      supportsClientOrderId: true,
      supportsLookupByClientOrderId: true,
      supportsLookupByVenueRefId: true,
    };
  }

  async submitOrder(cmd: OrderCommand): Promise<Result<OrderReceipt, VenueError>> {
    return this.withRateLimit(async () => {
      const orderType = cmd.type === 'market' ? 'market' : 'limit';
      const priceValue = cmd.price ? cmd.price.toNumber() : undefined;

      const params: Record<string, unknown> = {};
      if (cmd.clientOrderId) params.clientOrderId = cmd.clientOrderId;
      if (cmd.timeInForce) params.timeInForce = cmd.timeInForce;
      if (cmd.postOnly) params.postOnly = true;
      if (cmd.reduceOnly) params.reduceOnly = true;

      const response = await this.exchange.createOrder(
        cmd.symbol,
        orderType,
        cmd.side,
        cmd.quantity.toNumber(),
        priceValue,
        Object.keys(params).length > 0 ? params : undefined,
      );

      const receipt: OrderReceipt = {
        orderId: (response.id ?? response.info?.oid ?? '') as OrderId,
        clientOrderId: cmd.clientOrderId,
        status: mapOrderStatus(response.status),
        venueRefId: response.id ?? '',
        timestamp: response.datetime ?? new Date().toISOString(),
      };
      return ok(receipt);
    });
  }

  async cancelOrder(cmd: CancelCommand): Promise<Result<void, VenueError>> {
    return this.withRateLimit(async () => {
      await this.exchange.cancelOrder(cmd.orderId, cmd.symbol);
      return ok(undefined);
    });
  }

  async amendOrder(cmd: AmendCommand): Promise<Result<OrderReceipt, VenueError>> {
    return this.withRateLimit(async () => {
      const response = await this.exchange.editOrder(
        cmd.orderId,
        cmd.symbol,
        cmd.type,
        cmd.side,
        cmd.quantity?.toNumber(),
        cmd.price?.toNumber(),
      );

      const receipt: OrderReceipt = {
        orderId: (response.id ?? '') as OrderId,
        status: mapOrderStatus(response.status),
        venueRefId: response.id ?? '',
        timestamp: response.datetime ?? new Date().toISOString(),
      };
      return ok(receipt);
    });
  }

  async fetchPositions(): Promise<Result<Position[], VenueError>> {
    return this.withRateLimit(async () => {
      const positions = await this.exchange.fetchPositions();
      const mapped: Position[] = positions
        .filter((p: CcxtPosition) => p.contracts !== undefined && p.contracts !== 0)
        .map((p: CcxtPosition) => ({
          symbol: p.symbol ?? '',
          side: mapPositionSide(p.side),
          size: quantity(Math.abs(p.contracts ?? 0).toString()),
          entryPrice: price((p.entryPrice ?? 0).toString()),
          unrealizedPnl: p.unrealizedPnl != null ? price(p.unrealizedPnl.toString()) : undefined,
          leverage: p.leverage ?? undefined,
        }));
      return ok(mapped);
    });
  }

  async fetchBalances(): Promise<Result<BalanceSnapshot, VenueError>> {
    return this.withRateLimit(async () => {
      const balance = await this.exchange.fetchBalance();
      const totals = (balance.total ?? {}) as Record<string, number>;
      const freeBalances = (balance.free ?? {}) as Record<string, number>;
      const usedBalances = (balance.used ?? {}) as Record<string, number>;
      const balances = Object.entries(totals)
        .filter(([, total]) => total !== undefined && total !== 0)
        .map(([asset, total]) => ({
          asset,
          free: quantity((freeBalances[asset] ?? 0).toString()),
          locked: quantity((usedBalances[asset] ?? 0).toString()),
          total: quantity((total ?? 0).toString()),
        }));

      return ok({
        balances,
        timestamp: new Date().toISOString(),
      });
    });
  }

  /** Gracefully close the exchange connection */
  async close(): Promise<void> {
    await this.exchange.close();
  }

  async fetchTicker(symbol: string): Promise<Result<Ticker, VenueError>> {
    return this.withRateLimit(async () => {
      const ticker = await this.exchange.fetchTicker(symbol);
      return ok({
        symbol,
        last: price((ticker.last ?? 0).toString()),
        bid: ticker.bid != null ? price(ticker.bid.toString()) : undefined,
        ask: ticker.ask != null ? price(ticker.ask.toString()) : undefined,
        timestamp: ticker.datetime ?? new Date().toISOString(),
      });
    });
  }

  async fetchOpenOrders(): Promise<Result<VenueOrder[], VenueError>> {
    return this.withRateLimit(async () => {
      const openOrders = await this.exchange.fetchOpenOrders();
      const mapped: VenueOrder[] = openOrders.map((o) => mapCcxtVenueOrder(o));
      return ok(mapped);
    });
  }

  async fetchOrderByVenueRefId(venueRefId: string, symbol?: string): Promise<Result<VenueOrder | null, VenueError>> {
    await this.rateLimiter.waitForToken();
    try {
      const order = await this.exchange.fetchOrder(venueRefId, symbol);
      if (!order) return ok(null);
      return ok(mapCcxtVenueOrder(order));
    } catch (e: unknown) {
      if (e instanceof ccxt.OrderNotFound) {
        return ok(null);
      }
      return err(mapCcxtError(e));
    }
  }

  async fetchOrderByClientOrderId(clientOrderId: string, symbol?: string): Promise<Result<VenueOrder | null, VenueError>> {
    return this.withRateLimit(async () => {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      const openMatch = openOrders.find((o) => o.clientOrderId === clientOrderId);
      if (openMatch) {
        return ok(mapCcxtVenueOrder(openMatch));
      }

      const exchangeWithFetchOrders = this.exchange as unknown as {
        fetchOrders?: (market?: string, since?: number, limit?: number) => Promise<Array<Record<string, unknown>>>;
      };
      if (typeof exchangeWithFetchOrders.fetchOrders !== 'function') {
        return err({
          code: 'venue.lookup_unsupported',
          message: 'Venue does not support direct order history lookup by clientOrderId',
        });
      }

      const recentOrders = await exchangeWithFetchOrders.fetchOrders(symbol, undefined, 100);
      const recentMatch = recentOrders.find((o) => o.clientOrderId === clientOrderId);
      return ok(recentMatch ? mapCcxtVenueOrder(recentMatch) : null);
    });
  }

  async fetchRecentFills(since?: Date): Promise<Result<VenueFill[], VenueError>> {
    return this.withRateLimit(async () => {
      const sinceMs = since ? since.getTime() : undefined;
      const trades = await this.exchange.fetchMyTrades(undefined, sinceMs);
      const mapped: VenueFill[] = trades.map((t) => ({
        venueRefId: t.id ?? '',
        orderId: t.order ?? undefined,
        symbol: t.symbol ?? '',
        side: (t.side === 'buy' ? 'buy' : 'sell') as VenueFill['side'],
        quantity: quantity((t.amount ?? 0).toString()),
        price: price((t.price ?? 0).toString()),
        fee: quantity((t.fee?.cost ?? 0).toString()),
        feeCurrency: t.fee?.currency ?? 'USD',
        filledAt: t.datetime ?? new Date().toISOString(),
      }));
      return ok(mapped);
    });
  }

  async fetchAvailableSymbols(): Promise<Result<string[], VenueError>> {
    return this.withRateLimit(async () => {
      const markets = await this.exchange.loadMarkets();
      // Filter to linear perpetuals — the adapter primarily trades derivatives.
      // ccxt caches loadMarkets() results in memory after the first call.
      const symbols = Object.values(markets)
        .filter((m: { type?: string; linear?: boolean }) => m.type === 'swap' && m.linear === true)
        .map((m: { symbol: string }) => m.symbol);
      return ok(symbols);
    });
  }

  async fetchMarketMetadata(): Promise<Result<MarketMetadata[], VenueError>> {
    return this.withRateLimit(async () => {
      const markets = await this.exchange.loadMarkets();
      const result: MarketMetadata[] = [];
      for (const m of Object.values(markets)) {
        const market = m as { type?: string; linear?: boolean; symbol: string; base?: string; quote?: string; precision?: { price?: number; amount?: number } };
        if (market.type === 'swap' && market.linear === true) {
          result.push({
            symbol: market.symbol,
            type: market.type,
            base: market.base ?? '',
            quote: market.quote ?? '',
            tickSize: String(market.precision?.price ?? 0),
            lotSize: String(market.precision?.amount ?? 0),
          });
        }
      }
      return ok(result);
    });
  }

  async subscribePrivate(handlers: PrivateStreamHandlers): Promise<Result<Subscription, VenueError>> {
    const { credentials, wsUrl, streamConfig } = this.adapterConfig;
    const defaultWsUrl = credentials.testnet
      ? 'wss://api.hyperliquid-testnet.xyz/ws'
      : 'wss://api.hyperliquid.xyz/ws';
    // Resolution: global wsUrl override → environment-specific field → built-in default
    const environmentWsUrl = credentials.testnet
      ? this.adapterConfig.testnetWsUrl
      : undefined;
    const effectiveWsUrl = wsUrl ?? environmentWsUrl ?? defaultWsUrl;

    if (!effectiveWsUrl) {
      return err({ code: 'venue.misconfigured', message: 'No WebSocket URL configured for Hyperliquid private streams. Set wsUrl or testnetWsUrl in venue config.' });
    }

    const streamCfg: PrivateStreamConfig = {
      wsUrl: effectiveWsUrl,
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      reconnectBaseMs: streamConfig?.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: streamConfig?.reconnectMaxMs ?? 30_000,
      maxReconnectAttempts: streamConfig?.maxReconnectAttempts ?? 10,
    };

    const stream = new HyperliquidPrivateStream(streamCfg, handlers);
    const connectResult = await stream.connect();
    if (!connectResult.ok) {
      return err(connectResult.error);
    }
    return ok(stream);
  }

  getPublicWsUrl(): string {
    return this.adapterConfig.credentials.testnet
      ? this.adapterConfig.testnetWsUrl ?? 'wss://api.hyperliquid-testnet.xyz/ws'
      : this.adapterConfig.wsUrl ?? 'wss://api.hyperliquid.xyz/ws';
  }

  async subscribePublic(_symbols: string[], _handlers: PublicStreamHandlers): Promise<Result<Subscription, VenueError>> {
    // Real implementation delegates to the worker-scoped PublicStreamPool.
    // The adapter does not own a public WebSocket — the pool manages shared connections.
    return err({ code: 'venue.not_implemented', message: 'subscribePublic requires a worker-scoped PublicStreamPool. Use the pool directly.' });
  }

  /**
   * Probe the venue using the provided credentials.
   * Returns a VenueProfile describing what instruments and modes are available.
   * Unauthenticated probe (no real keys) uses the public Hyperliquid API.
   */
  static async probe(
    credentials?: HyperliquidCredentials,
    options?: { testnetBaseUrl?: string; baseUrl?: string },
  ): Promise<VenueProfile> {
    const testnet = credentials?.testnet ?? false;
    const baseUrl = testnet
      ? options?.testnetBaseUrl ?? 'https://api.hyperliquid-testnet.xyz'
      : options?.baseUrl ?? 'https://api.hyperliquid.xyz';

    const availableSymbols: string[] = [];

    try {
      const res = await fetch(`${baseUrl}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json() as { universe?: Array<{ name: string }> };
        for (const inst of data.universe ?? []) {
          availableSymbols.push(`${inst.name}-PERP`);
        }
      }
    } catch {
      // Best-effort — return empty symbols if probe fails
    }

    const authenticated = !!(credentials?.apiKey && credentials.apiKey.length > 0);
    const supportedExecutionModes: VenueProfile['supportedExecutionModes'] = authenticated
      ? ['paper', 'shadow', 'live']
      : ['paper'];

    return {
      venue: 'hyperliquid',
      venueType: 'orderbook',
      availableSymbols,
      supportedExecutionModes,
      authenticated,
      probedAt: new Date().toISOString(),
    };
  }

  /**
   * Wraps an exchange call with rate limiting and error mapping.
   * Never throws — always returns Result.
   */
  private async withRateLimit<T>(
    fn: () => Promise<Result<T, VenueError>>,
  ): Promise<Result<T, VenueError>> {
    await this.rateLimiter.waitForToken();
    try {
      return await fn();
    } catch (e: unknown) {
      return err(mapCcxtError(e));
    }
  }
}

function mapOrderStatus(status: string | undefined): OrderReceipt['status'] {
  switch (status) {
    case 'open': return 'open';
    case 'closed': return 'filled';
    case 'canceled': return 'cancelled';
    case 'expired': return 'cancelled';
    case 'rejected': return 'rejected';
    default: return 'pending';
  }
}

function mapCcxtOrderType(type: string | undefined): VenueOrder['type'] {
  switch (type) {
    case 'market': return 'market';
    case 'limit': return 'limit';
    case 'stop': return 'stop_market';
    case 'stop_limit': return 'stop_limit';
    default: return 'market';
  }
}

function mapCcxtOrderStatus(status: string | undefined): VenueOrder['status'] {
  switch (status) {
    case 'open': return 'open';
    case 'closed': return 'filled';
    case 'canceled': return 'cancelled';
    case 'expired': return 'cancelled';
    case 'rejected': return 'rejected';
    default: return 'pending';
  }
}

function mapCcxtVenueOrder(order: {
  id?: string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  amount?: number;
  filled?: number;
  price?: number;
  average?: number;
  datetime?: string;
}): VenueOrder {
  return {
    venueRefId: order.id ?? '',
    clientOrderId: order.clientOrderId ?? undefined,
    symbol: order.symbol ?? '',
    side: (order.side === 'buy' ? 'buy' : 'sell') as VenueOrder['side'],
    type: mapCcxtOrderType(order.type),
    status: mapCcxtOrderStatus(order.status),
    quantity: quantity((order.amount ?? 0).toString()),
    filledQuantity: quantity((order.filled ?? 0).toString()),
    price: order.price != null ? price(order.price.toString()) : undefined,
    avgFillPrice: order.average != null ? price(order.average.toString()) : undefined,
    createdAt: order.datetime ?? new Date().toISOString(),
  };
}

function mapPositionSide(side: string | undefined | null): Position['side'] {
  if (side === 'long') return 'long';
  if (side === 'short') return 'short';
  return 'flat';
}

function mapCcxtError(e: unknown): VenueError {
  if (e instanceof ccxt.RateLimitExceeded) {
    return { code: 'venue.rate_limited', message: e.message };
  }
  if (e instanceof ccxt.AuthenticationError) {
    return { code: 'venue.auth_failed', message: e.message };
  }
  if (e instanceof ccxt.InsufficientFunds) {
    return { code: 'venue.insufficient_funds', message: e.message };
  }
  if (e instanceof ccxt.InvalidOrder) {
    return { code: 'venue.order_rejected', message: e.message };
  }
  if (e instanceof ccxt.OrderNotFound) {
    return { code: 'venue.order_not_found', message: e.message };
  }
  if (e instanceof ccxt.NetworkError) {
    return { code: 'venue.network_error', message: e.message };
  }
  if (e instanceof ccxt.ExchangeError) {
    return { code: 'venue.exchange_error', message: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { code: 'venue.unknown', message: msg };
}
