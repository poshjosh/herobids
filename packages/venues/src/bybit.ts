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
import { BybitPrivateStream } from './bybit-private-stream.js';
import type { BybitPrivateStreamConfig } from './bybit-private-stream.js';
import ccxt, { type Position as CcxtPosition } from 'ccxt';

export interface BybitCredentials {
  apiKey: string;
  secret: string;
  /** If true, use testnet endpoints */
  testnet?: boolean;
}

export interface BybitAdapterConfig {
  credentials: BybitCredentials;
  /** Rate limiter config. Default: 10 requests/second with burst of 20 */
  rateLimit?: { capacity: number; refillRate: number };
  /** Global WebSocket URL override for private streams. Takes highest priority regardless of environment. */
  wsUrl?: string;
  /** WebSocket URL for public streams. */
  wsPublicUrl?: string;
  /** WebSocket URL for mainnet private streams. Used when testnet is false and wsUrl is not set. */
  wsPrivateUrl?: string;
  /** WebSocket URL for testnet private streams. Used when testnet is true and wsUrl is not set. */
  wsTestnetPrivateUrl?: string;
  /** Private stream reconnection config */
  streamConfig?: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    maxReconnectAttempts?: number;
  };
}

type BybitAccountMode = 'unified' | 'standard';

interface BybitExchangeWithAccountMode extends Omit<InstanceType<typeof ccxt.bybit>, 'isUnifiedEnabled'> {
  isUnifiedEnabled?: () => Promise<[boolean | undefined, boolean | undefined]>;
}

/**
 * Bybit venue adapter implementing OrderbookVenuePort.
 * Supports both Unified Trading Account (UTA) and Standard accounts.
 * Uses ccxt under the hood.
 */
export class BybitAdapter implements OrderbookVenuePort {
  private static capabilitiesWarned = false;
  private readonly exchange: InstanceType<typeof ccxt.bybit>;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly adapterConfig: BybitAdapterConfig;
  private accountModePromise?: Promise<BybitAccountMode>;

  constructor(config: BybitAdapterConfig) {
    this.adapterConfig = config;
    this.exchange = new ccxt.bybit({
      apiKey: config.credentials.apiKey,
      secret: config.credentials.secret,
      enableRateLimit: false, // we manage our own
    });

    if (config.credentials.testnet) {
      this.exchange.setSandboxMode(true);
    }

    this.rateLimiter = new TokenBucketRateLimiter(
      config.rateLimit ?? { capacity: 20, refillRate: 10 },
    );

    // Prime account-mode detection early so standard accounts can be routed to
    // the derivatives wallet before the first balance/position reconciliation.
    void this.getAccountMode().catch(() => undefined);
  }

  // TODO: Verify actual Bybit API capabilities per-account-type.
  // These defaults are optimistic — review against Bybit V5 API docs
  // and adjust for unified margin vs. classic account differences.
  getCapabilities(): VenueCapabilities {
    if (!BybitAdapter.capabilitiesWarned) {
      BybitAdapter.capabilitiesWarned = true;
      console.warn('[BybitAdapter] getCapabilities() returns optimistic defaults — verify against V5 API docs before live trading');
    }
    return {
      limitOrderSubmission: true,
      amendInPlace: true,
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
        orderId: (response.id ?? '') as OrderId,
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
      const requestParams = await this.getStandardDerivativesParams();
      const positions = requestParams
        ? await this.exchange.fetchPositions(undefined, requestParams)
        : await this.exchange.fetchPositions();
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
      const requestParams = await this.getStandardDerivativesParams();
      const balance = requestParams
        ? await this.exchange.fetchBalance(requestParams)
        : await this.exchange.fetchBalance();
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
      const requestParams = await this.getStandardDerivativesParams();
      const openOrders = requestParams
        ? await this.exchange.fetchOpenOrders(undefined, undefined, undefined, requestParams)
        : await this.exchange.fetchOpenOrders();
      const mapped: VenueOrder[] = openOrders.map((o) => mapCcxtVenueOrder(o));
      return ok(mapped);
    });
  }

  async fetchOrderByVenueRefId(venueRefId: string, symbol?: string): Promise<Result<VenueOrder | null, VenueError>> {
    await this.rateLimiter.waitForToken();
    try {
      const requestParams = await this.getStandardDerivativesParams();
      const order = await this.exchange.fetchOrder(venueRefId, symbol, requestParams);
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
      const requestParams = await this.getStandardDerivativesParams();
      const openOrders = requestParams
        ? await this.exchange.fetchOpenOrders(symbol, undefined, undefined, requestParams)
        : await this.exchange.fetchOpenOrders(symbol);
      const openMatch = openOrders.find((o) => o.clientOrderId === clientOrderId);
      if (openMatch) {
        return ok(mapCcxtVenueOrder(openMatch));
      }

      const exchangeWithFetchOrders = this.exchange as unknown as {
        fetchOrders?: (market?: string, since?: number, limit?: number, params?: Record<string, string>) => Promise<Array<Record<string, unknown>>>;
      };
      if (typeof exchangeWithFetchOrders.fetchOrders !== 'function') {
        return err({
          code: 'venue.lookup_unsupported',
          message: 'Venue does not support direct order history lookup by clientOrderId',
        });
      }

      const recentOrders = await exchangeWithFetchOrders.fetchOrders(symbol, undefined, 100, requestParams);
      const recentMatch = recentOrders.find((o) => o.clientOrderId === clientOrderId);
      return ok(recentMatch ? mapCcxtVenueOrder(recentMatch) : null);
    });
  }

  async fetchRecentFills(since?: Date): Promise<Result<VenueFill[], VenueError>> {
    return this.withRateLimit(async () => {
      const sinceMs = since ? since.getTime() : undefined;
      const requestParams = await this.getStandardDerivativesParams();
      const trades = requestParams
        ? await this.exchange.fetchMyTrades(undefined, sinceMs, undefined, requestParams)
        : await this.exchange.fetchMyTrades(undefined, sinceMs);
      const mapped: VenueFill[] = trades.map((t) => ({
        venueRefId: t.id ?? '',
        orderId: t.order ?? undefined,
        symbol: t.symbol ?? '',
        side: (t.side === 'buy' ? 'buy' : 'sell') as VenueFill['side'],
        quantity: quantity((t.amount ?? 0).toString()),
        price: price((t.price ?? 0).toString()),
        fee: quantity((t.fee?.cost ?? 0).toString()),
        feeCurrency: t.fee?.currency ?? 'USDT',
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
      ? 'wss://stream-testnet.bybit.com/v5/private'
      : 'wss://stream.bybit.com/v5/private';
    // Resolution: global wsUrl override → environment-specific field → built-in default
    const environmentWsUrl = credentials.testnet
      ? this.adapterConfig.wsTestnetPrivateUrl
      : this.adapterConfig.wsPrivateUrl;
    const effectiveWsUrl = wsUrl ?? environmentWsUrl ?? defaultWsUrl;

    if (!effectiveWsUrl) {
      return err({ code: 'venue.misconfigured', message: 'No WebSocket URL configured for Bybit private streams. Set wsUrl, wsPrivateUrl, or wsTestnetPrivateUrl in venue config.' });
    }

    const streamCfg: BybitPrivateStreamConfig = {
      wsUrl: effectiveWsUrl,
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      reconnectBaseMs: streamConfig?.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: streamConfig?.reconnectMaxMs ?? 30_000,
      maxReconnectAttempts: streamConfig?.maxReconnectAttempts ?? 10,
    };

    const stream = new BybitPrivateStream(streamCfg, handlers);
    const connectResult = await stream.connect();
    if (!connectResult.ok) {
      return err(connectResult.error);
    }
    return ok(stream);
  }

  async subscribePublic(_symbols: string[], _handlers: PublicStreamHandlers): Promise<Result<Subscription, VenueError>> {
    return err({ code: 'venue.not_implemented', message: 'subscribePublic requires a worker-scoped PublicStreamPool. Use the pool directly.' });
  }

  /** Gracefully close the exchange connection */
  async close(): Promise<void> {
    await this.exchange.close();
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

  private async getAccountMode(): Promise<BybitAccountMode> {
    if (!this.accountModePromise) {
      this.accountModePromise = this.detectAccountMode().catch((e) => {
        // Clear cached promise so next call retries instead of permanently failing
        this.accountModePromise = undefined;
        throw e;
      });
    }
    return this.accountModePromise;
  }

  private async detectAccountMode(): Promise<BybitAccountMode> {
    const exchangeWithAccountMode = this.exchange as BybitExchangeWithAccountMode;
    if (typeof exchangeWithAccountMode.isUnifiedEnabled === 'function') {
      try {
        const [enableUnifiedMargin, enableUnifiedAccount] = await exchangeWithAccountMode.isUnifiedEnabled();
        return (enableUnifiedMargin || enableUnifiedAccount) ? 'unified' : 'standard';
      } catch (e: unknown) {
        // Only suppress auth/permission errors — these indicate the key lacks
        // "Account Transfer" permission. Default to 'unified' (safe: no extra routing params).
        // Transient errors (network, timeout, rate limit) must propagate so
        // getAccountMode() clears the cached promise and retries on next call.
        if (e instanceof ccxt.AuthenticationError) {
          return 'unified';
        }
        throw e;
      }
    }
    // Fallback: ccxt always has isUnifiedEnabled on bybit, but guard anyway
    return 'unified';
  }

  private async getStandardDerivativesParams(): Promise<Record<string, string> | undefined> {
    const accountMode = await this.getAccountMode();
    if (accountMode !== 'standard') {
      return undefined;
    }
    return {
      type: 'swap',
      subType: 'linear',
    };
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
