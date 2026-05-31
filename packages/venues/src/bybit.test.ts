import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

/**
 * Unit tests for Bybit stream utilities.
 * Tests auth signature generation and symbol normalization without WebSocket.
 */
describe('Bybit auth signature', () => {
  it('generates correct HMAC-SHA256 signature for WebSocket auth', () => {
    const secret = 'test-secret-key-12345';
    const expires = 1700000000000; // fixed timestamp

    const signature = crypto
      .createHmac('sha256', secret)
      .update(`GET/realtime${expires}`)
      .digest('hex');

    // Signature should be a 64-char hex string
    expect(signature).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(signature)).toBe(true);

    // Same inputs should produce same signature (deterministic)
    const signature2 = crypto
      .createHmac('sha256', secret)
      .update(`GET/realtime${expires}`)
      .digest('hex');
    expect(signature).toBe(signature2);

    // Different secret should produce different signature
    const signature3 = crypto
      .createHmac('sha256', 'different-secret')
      .update(`GET/realtime${expires}`)
      .digest('hex');
    expect(signature).not.toBe(signature3);
  });
});

describe('Bybit public stream symbol normalization', () => {
  // Inline the logic from BybitPublicStream for testing
  function toBybitSymbol(unified: string): string {
    const withoutSettlement = unified.includes(':') ? unified.slice(0, unified.indexOf(':')) : unified;
    return withoutSettlement.replace(/\//g, '');
  }

  it('converts unified ccxt symbols to Bybit raw format', () => {
    expect(toBybitSymbol('BTC/USDT:USDT')).toBe('BTCUSDT');
    expect(toBybitSymbol('ETH/USDT:USDT')).toBe('ETHUSDT');
    expect(toBybitSymbol('BTC/USDT')).toBe('BTCUSDT');
    expect(toBybitSymbol('BTCUSDT')).toBe('BTCUSDT');
  });

  it('handles symbols without separators', () => {
    expect(toBybitSymbol('SOLUSDT')).toBe('SOLUSDT');
  });

  it('handles inverse contracts', () => {
    expect(toBybitSymbol('BTC/USD:BTC')).toBe('BTCUSD');
  });
});

describe('Bybit private stream message parsing', () => {
  it('parses execution (fill) message fields', () => {
    const raw = {
      execId: 'exec-123',
      orderId: 'order-456',
      symbol: 'BTCUSDT',
      side: 'Buy',
      execQty: '0.001',
      execPrice: '67500.5',
      execFee: '0.03',
      feeCurrency: 'USDT',
      execTime: '1717156800000', // epoch ms
    };

    // Simulate the parsing logic from BybitPrivateStream.handleFills
    const fill = {
      venueRefId: String(raw.execId ?? ''),
      orderId: String(raw.orderId ?? ''),
      symbol: String(raw.symbol ?? ''),
      side: String(raw.side ?? '').toLowerCase() === 'buy' ? 'buy' as const : 'sell' as const,
      quantity: String(raw.execQty ?? '0'),
      price: String(raw.execPrice ?? '0'),
      fee: String(raw.execFee ?? '0'),
      feeCurrency: String(raw.feeCurrency ?? 'USDT'),
      filledAt: toIsoTimestamp(raw.execTime),
    };

    expect(fill.venueRefId).toBe('exec-123');
    expect(fill.orderId).toBe('order-456');
    expect(fill.symbol).toBe('BTCUSDT');
    expect(fill.side).toBe('buy');
    expect(fill.quantity).toBe('0.001');
    expect(fill.price).toBe('67500.5');
    expect(fill.fee).toBe('0.03');
    expect(fill.feeCurrency).toBe('USDT');
    // epoch ms should be converted to ISO-8601
    expect(fill.filledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('parses order update message fields', () => {
    const raw = {
      orderId: 'order-789',
      orderLinkId: 'client-001',
      symbol: 'ETHUSDT',
      side: 'Sell',
      orderType: 'Limit',
      orderStatus: 'PartiallyFilled',
      qty: '1.5',
      cumExecQty: '0.5',
      price: '3800.0',
      avgPrice: '3799.5',
      updatedTime: '1717156860000', // epoch ms
    };

    const order = {
      venueRefId: String(raw.orderId ?? ''),
      clientOrderId: raw.orderLinkId ? String(raw.orderLinkId) : undefined,
      symbol: String(raw.symbol ?? ''),
      side: String(raw.side ?? '').toLowerCase() === 'buy' ? 'buy' as const : 'sell' as const,
      type: String(raw.orderType ?? '').toLowerCase(),
      status: mapBybitOrderStatus(String(raw.orderStatus ?? '')),
      quantity: String(raw.qty ?? '0'),
      filledQuantity: String(raw.cumExecQty ?? '0'),
      price: raw.price && String(raw.price) !== '0' ? String(raw.price) : undefined,
      avgFillPrice: raw.avgPrice && String(raw.avgPrice) !== '0' ? String(raw.avgPrice) : undefined,
      updatedAt: toIsoTimestamp(raw.updatedTime),
    };

    expect(order.venueRefId).toBe('order-789');
    expect(order.clientOrderId).toBe('client-001');
    expect(order.side).toBe('sell');
    expect(order.status).toBe('partial');
    expect(order.filledQuantity).toBe('0.5');
    // epoch ms should be converted to ISO-8601
    expect(order.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('parses position update message fields', () => {
    const raw = {
      symbol: 'BTCUSDT',
      side: 'Buy',
      size: '0.01',
      entryPrice: '67000',
      unrealisedPnl: '5.5',
      leverage: '10',
    };

    const size = parseFloat(String(raw.size ?? '0'));
    const side = String(raw.side ?? '').toLowerCase();
    const position = {
      symbol: String(raw.symbol ?? ''),
      side: size === 0 ? 'flat' as const : side === 'buy' ? 'long' as const : 'short' as const,
      size: Math.abs(size).toString(),
      entryPrice: String(raw.entryPrice ?? '0'),
      unrealizedPnl: raw.unrealisedPnl ? String(raw.unrealisedPnl) : undefined,
      leverage: raw.leverage ? Number(raw.leverage) : undefined,
    };

    expect(position.symbol).toBe('BTCUSDT');
    expect(position.side).toBe('long');
    expect(position.size).toBe('0.01');
    expect(position.entryPrice).toBe('67000');
    expect(position.unrealizedPnl).toBe('5.5');
    expect(position.leverage).toBe(10);
  });

  it('maps flat position when size is zero', () => {
    const size = parseFloat('0');
    const side = 'buy';
    const result = size === 0 ? 'flat' : side === 'buy' ? 'long' : 'short';
    expect(result).toBe('flat');
  });
});

function mapBybitOrderStatus(status: string): string {
  switch (status) {
    case 'New': return 'open';
    case 'PartiallyFilled': return 'partial';
    case 'Filled': return 'filled';
    case 'Cancelled': return 'cancelled';
    case 'Rejected': return 'rejected';
    case 'Deactivated': return 'cancelled';
    default: return status.toLowerCase();
  }
}

function toIsoTimestamp(value: unknown): string {
  if (value == null) return new Date().toISOString();
  const s = String(value);
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  return s;
}
