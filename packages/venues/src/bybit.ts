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
  Subscription,
  PrivateStreamHandlers,
  PublicStreamHandlers,
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
  /** WebSocket URL for private streams. Overrides default based on testnet flag. */
  wsUrl?: string;
  /** WebSocket URL for public streams. Overrides default based on testnet flag. */
  wsPublicUrl?: string;
  /** Private stream reconnection config */
  streamConfig?: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    maxReconnectAttempts?: number;
  };
}

/**
 * Bybit venue adapter implementing OrderbookVenuePort.
 * Supports both Unified Trading Account (UTA) and Standard accounts.
 * Uses ccxt under the hood.
 */
export class BybitAdapter implements OrderbookVenuePort {
  private readonly exchange: InstanceType<typeof ccxt.bybit>;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly adapterConfig: BybitAdapterConfig;

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
  }

  async submitOrder(cmd: OrderCommand): Promise<Result<OrderReceipt, VenueError>> {
    return this.withRateLimit(async () => {
      const orderType = cmd.type === 'market' ? 'market' : 'limit';
      const priceValue = cmd.price ? cmd.price.toNumber() : undefined;

      const response = await this.exchange.createOrder(
        cmd.symbol,
        orderType,
        cmd.side,
        cmd.quantity.toNumber(),
        priceValue,
        cmd.clientOrderId ? { clientOrderId: cmd.clientOrderId } : undefined,
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
      const mapped: VenueOrder[] = openOrders.map((o) => ({
        venueRefId: o.id ?? '',
        clientOrderId: o.clientOrderId ?? undefined,
        symbol: o.symbol ?? '',
        side: (o.side === 'buy' ? 'buy' : 'sell') as VenueOrder['side'],
        type: mapCcxtOrderType(o.type),
        status: mapCcxtOrderStatus(o.status),
        quantity: quantity((o.amount ?? 0).toString()),
        filledQuantity: quantity((o.filled ?? 0).toString()),
        price: o.price != null ? price(o.price.toString()) : undefined,
        avgFillPrice: o.average != null ? price(o.average.toString()) : undefined,
        createdAt: o.datetime ?? new Date().toISOString(),
      }));
      return ok(mapped);
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
        feeCurrency: t.fee?.currency ?? 'USDT',
        filledAt: t.datetime ?? new Date().toISOString(),
      }));
      return ok(mapped);
    });
  }

  async subscribePrivate(handlers: PrivateStreamHandlers): Promise<Result<Subscription, VenueError>> {
    const { credentials, wsUrl, streamConfig } = this.adapterConfig;
    const effectiveWsUrl = wsUrl ?? (credentials.testnet
      ? 'wss://stream-testnet.bybit.com/v5/private'
      : 'wss://stream.bybit.com/v5/private');

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
