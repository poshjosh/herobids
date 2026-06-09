import { describe, expect, it, vi } from 'vitest';
import type { PublicStreamHandlers } from '@herobids/domain';
import type { StreamPoolHandle } from '@herobids/engine';
import { buildPublicStreamConnectors, createScopedStreamPoolHandle, publicStreamVenueKey } from './public-stream-routing.js';

describe('publicStreamVenueKey', () => {
  it('keys connectors by venue and environment', () => {
    expect(publicStreamVenueKey('hyperliquid', false)).toBe('hyperliquid:mainnet');
    expect(publicStreamVenueKey('hyperliquid', true)).toBe('hyperliquid:testnet');
  });
});

describe('buildPublicStreamConnectors', () => {
  it('registers environment-specific connectors for configured venues', () => {
    const connectors = buildPublicStreamConnectors({
      hyperliquid: {
        baseUrl: 'https://api.hyperliquid.xyz',
        wsUrl: 'wss://api.hyperliquid.xyz/ws',
        testnetWsUrl: 'wss://api.hyperliquid-testnet.xyz/ws',
        rateLimitPerSec: 10,
        timeoutMs: 30_000,
        confirmationTimeoutMs: 60_000,
      },
      bybit: {
        baseUrl: 'https://api.bybit.com',
        wsPublicUrl: 'wss://stream.bybit.com/v5/public/linear',
        wsTestnetPublicUrl: 'wss://stream-testnet.bybit.com/v5/public/linear',
        rateLimitPerSec: 10,
        timeoutMs: 30_000,
        confirmationTimeoutMs: 60_000,
      },
    });

    expect(Array.from(connectors.keys()).sort()).toEqual([
      'bybit:mainnet',
      'bybit:testnet',
      'hyperliquid:mainnet',
      'hyperliquid:testnet',
    ]);
  });
});

describe('createScopedStreamPoolHandle', () => {
  it('routes subscriptions through the environment-specific venue key', async () => {
    const subscribe = vi.fn<StreamPoolHandle['subscribe']>().mockResolvedValue({
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });
    const pool: StreamPoolHandle = { subscribe };
    const scopedHandle = createScopedStreamPoolHandle(pool, 'bybit', true);
    const handlers: PublicStreamHandlers = { onTicker: vi.fn() };

    await scopedHandle!.subscribe('bybit', ['BTC/USD:USD'], handlers);

    expect(subscribe).toHaveBeenCalledWith('bybit:testnet', ['BTC/USD:USD'], handlers);
  });
});