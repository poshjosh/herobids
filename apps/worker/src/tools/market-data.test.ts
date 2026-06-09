import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { marketDataTools } from './market-data.js';

const discoverTokensTool = marketDataTools.find((tool) => tool.name === 'discover_tokens');

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-market-data-test',
    sessionId: 'session-market-data-test',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

describe('discover_tokens tool', () => {
  it('reuses the shared price service to enrich returned discovery tokens', async () => {
    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [{ symbol: 'BONK', network: 'solana', priceUsd: 0.00001, discoveryVectors: ['trending'] }],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: {
          getPrice: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              priceUsd: 0.00002,
              source: 'oracle',
              fetchedAt: '2026-06-09T00:00:00.000Z',
              stale: false,
            },
          }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [
        expect.objectContaining({
          symbol: 'BONK',
          network: 'solana',
          priceUsd: 0.00002,
          priceSource: 'oracle',
          priceStale: false,
        }),
      ],
    });
  });

  it('keeps discovery prices when the shared price lookup fails', async () => {
    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [{ symbol: 'WIF', network: 'solana', priceUsd: 2.5, discoveryVectors: ['boosted'] }],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: {
          getPrice: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: 'price.unavailable', message: 'missing' },
          }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [expect.objectContaining({ symbol: 'WIF', priceUsd: 2.5 })],
    });
  });

  it('does not overwrite prices when multiple discovery tokens share the same symbol on one network', async () => {
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        priceUsd: 1.23,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [
                { address: 'token-a', symbol: 'PEPE', network: 'solana', priceUsd: 0.1, discoveryVectors: ['trending'] },
                { address: 'token-b', symbol: 'PEPE', network: 'solana', priceUsd: 0.2, discoveryVectors: ['boosted'] },
              ],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [
        expect.objectContaining({ address: 'token-a', priceUsd: 0.1 }),
        expect.objectContaining({ address: 'token-b', priceUsd: 0.2 }),
      ],
    });
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('passes token address to price service so address-aware lookup prevents repricing with a different same-symbol token', async () => {
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        priceUsd: 0.00005,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await discoverTokensTool!.execute(
      { network: 'solana', limit: 5 },
      makeContext({
        marketDataRegistry: {
          discovery: {
            discover: vi.fn().mockResolvedValue({
              data: [
                { address: '0xdiscovered', symbol: 'PEPE', network: 'solana', priceUsd: 0.00003, discoveryVectors: ['trending'] },
              ],
              meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
            }),
          },
        } as ToolContext['marketDataRegistry'],
        priceService: { getPrice },
      }),
    );

    expect(result.success).toBe(true);
    // Price service must have been called with the token address so it can
    // distinguish the discovered token from other same-symbol tokens.
    expect(getPrice).toHaveBeenCalledWith('PEPE', 'solana', '0xdiscovered');
    expect(result.data).toMatchObject({
      ok: true,
      tokens: [
        expect.objectContaining({
          symbol: 'PEPE',
          priceUsd: 0.00005,
          priceSource: 'oracle',
        }),
      ],
    });
  });
});