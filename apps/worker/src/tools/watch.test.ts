import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';

// Import watch tools via dynamic import to test them isolated
// We must import the module's exported array after setting up mocks.
const { watchTools } = await import('./watch.js');

const watchTokenTool = watchTools.find((t) => t.name === 'watch_token')!;
const listWatchesTool = watchTools.find((t) => t.name === 'list_watches')!;
const removeWatchTool = watchTools.find((t) => t.name === 'remove_watch')!;
const checkWatchesTool = watchTools.find((t) => t.name === 'check_watches')!;

function okPrice(priceUsd: number, source: 'oracle' | 'execution' | 'cached' = 'oracle') {
  return {
    ok: true as const,
    data: {
      priceUsd,
      source,
      fetchedAt: new Date().toISOString(),
      stale: false,
    },
  };
}

function makeCtx(overrides: {
  redis?: Partial<ToolContext['redis']>;
  priceService?: ToolContext['priceService'];
} = {}): ToolContext {
  const hstore = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();

  const redis: ToolContext['redis'] = {
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hstore.has(key)) hstore.set(key, {});
      hstore.get(key)![field] = value;
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => hstore.get(key)?.[field] ?? null),
    hgetall: vi.fn(async (key: string) => hstore.get(key) ?? null),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const map = hstore.get(key);
      if (!map) return 0;
      let count = 0;
      for (const f of fields) {
        if (f in map) { delete map[f]; count++; }
      }
      return count;
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      let added = 0;
      for (const m of members) {
        if (!sets.get(key)!.has(m)) { sets.get(key)!.add(m); added++; }
      }
      return added;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    }),
    expire: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    ...overrides.redis,
  };

  return {
    agentId: 'agent-test-1',
    sessionId: 'session-test-1',
    phase: 'scout',
    executionMode: 'paper',
    redis,
    publishToInbound: vi.fn().mockResolvedValue(undefined),
    priceService: overrides.priceService,
  } as unknown as ToolContext;
}

describe('watch_token', () => {
  it('registers a watch and returns a watchId', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { ok: boolean; watchId: string };
    expect(data.ok).toBe(true);
    expect(typeof data.watchId).toBe('string');
    expect(ctx.redis.hset).toHaveBeenCalledTimes(2);
  });

  it('refreshes the cached active watch summary after registration', async () => {
    const ctx = makeCtx();

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(ctx.redis.hset).toHaveBeenCalledWith(
      'agent:watches:summary:agent-test-1',
      'summary',
      expect.stringContaining('SOL (solana) above $200 status=unknown'),
    );
  });

  it('stores watch as JSON in the agent watches hash', async () => {
    const ctx = makeCtx();
    await watchTokenTool.execute(
      { symbol: 'BTC', chain: 'hyperliquid', thresholdPrice: 100_000, condition: 'above', note: 'ath watch' },
      ctx,
    );

    const hsetMock = ctx.redis.hset as ReturnType<typeof vi.fn>;
    const storedValue = JSON.parse(hsetMock.mock.calls[0][2] as string) as Record<string, unknown>;

    expect(storedValue).toMatchObject({
      symbol: 'BTC',
      chain: 'hyperliquid',
      thresholdPrice: 100_000,
      condition: 'above',
      note: 'ath watch',
    });
    expect(typeof storedValue['watchId']).toBe('string');
    expect(typeof storedValue['createdAt']).toBe('string');
  });

  it('rejects invalid symbol formats for the requested chain', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'So11111111111111111111111111111111111111112', chain: 'ethereum', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ethereum');
  });

  it('rejects unsupported chain values before storing a watch', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'optimism', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('rejects chain "any" and tells the caller to discover the chain first', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'any', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('watch_token requires an explicit chain');
    expect(result.error).toContain('Call get_price first');
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('passes address-shaped symbol as address argument for identity-aware initial price', async () => {
    const evmAddress = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.00001));
    const ctx = makeCtx({ priceService: { getPrice } });

    await watchTokenTool.execute(
      { symbol: evmAddress, chain: 'ethereum', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    // Must pass address as 3rd arg so the price service resolves by identity
    expect(getPrice).toHaveBeenCalledWith(evmAddress, 'ethereum', evmAddress);
  });
});

describe('list_watches', () => {
  it('returns empty list when no watches exist', async () => {
    const ctx = makeCtx();
    const result = await listWatchesTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { watches: unknown[] }).watches).toHaveLength(0);
  });

  it('returns all registered watches sorted by createdAt', async () => {
    const ctx = makeCtx();
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    await watchTokenTool.execute({ symbol: 'BTC', chain: 'hyperliquid', thresholdPrice: 90_000, condition: 'below' }, ctx);

    const result = await listWatchesTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { watches: Array<{ symbol: string }> };
    expect(data.watches).toHaveLength(2);
    expect(data.watches.map((w) => w.symbol)).toContain('SOL');
    expect(data.watches.map((w) => w.symbol)).toContain('BTC');
  });
});

describe('remove_watch', () => {
  it('removes a watch by ID', async () => {
    const ctx = makeCtx();
    const createResult = await watchTokenTool.execute(
      { symbol: 'WIF', chain: 'solana', thresholdPrice: 5, condition: 'above' },
      ctx,
    );
    const { watchId } = createResult.data as { watchId: string };

    const removeResult = await removeWatchTool.execute({ watchId }, ctx);

    expect(removeResult.success).toBe(true);
    expect((removeResult.data as { removed: boolean }).removed).toBe(true);

    const listResult = await listWatchesTool.execute({}, ctx);
    expect((listResult.data as { watches: unknown[] }).watches).toHaveLength(0);
  });

  it('refreshes the cached active watch summary after removal', async () => {
    const ctx = makeCtx();
    const createResult = await watchTokenTool.execute(
      { symbol: 'WIF', chain: 'solana', thresholdPrice: 5, condition: 'above' },
      ctx,
    );
    const { watchId } = createResult.data as { watchId: string };

    await removeWatchTool.execute({ watchId }, ctx);

    expect(ctx.redis.hdel).toHaveBeenCalledWith('agent:watches:summary:agent-test-1', 'summary');
  });

  it('returns failure for non-existent watch ID', async () => {
    const ctx = makeCtx();
    const result = await removeWatchTool.execute({ watchId: '00000000-0000-4000-8000-000000000000' }, ctx);

    expect(result.success).toBe(false);
  });
});

describe('check_watches', () => {
  it('returns error when price service is not configured', async () => {
    const ctx = makeCtx(); // no priceService
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('price_service_not_configured');
  });

  it('returns empty triggered list when no watches exist', async () => {
    const ctx = makeCtx({
      priceService: { getPrice: vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } }) },
    });

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { triggered: unknown[] }).triggered).toHaveLength(0);
  });

  it('detects "above" threshold crossing', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250));
    const ctx = makeCtx({
      priceService: {
        getPrice,
      },
    });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { triggered: Array<{ symbol: string; currentPrice: number }> };
    expect(data.triggered).toHaveLength(1);
    expect(data.triggered[0]!.symbol).toBe('SOL');
    expect(data.triggered[0]!.currentPrice).toBe(250);
  });

  it('does not trigger immediately when a watch starts already above the threshold', async () => {
    const ctx = makeCtx({
      priceService: {
        getPrice: vi.fn()
          .mockResolvedValueOnce(okPrice(250))
          .mockResolvedValueOnce(okPrice(250)),
      },
    });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { triggered: unknown[] };
    expect(data.triggered).toHaveLength(0);
  });

  it('does not trigger "above" when price is at or below threshold', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(150));
    const ctx = makeCtx({
      priceService: {
        getPrice,
      },
    });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { triggered: unknown[] };
    expect(data.triggered).toHaveLength(0);
  });

  it('detects "below" threshold crossing', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(70_000, 'execution'))
      .mockResolvedValueOnce(okPrice(50_000, 'execution'));
    const ctx = makeCtx({
      priceService: {
        getPrice,
      },
    });

    await watchTokenTool.execute({ symbol: 'BTC', chain: 'hyperliquid', thresholdPrice: 60_000, condition: 'below' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { triggered: Array<{ symbol: string }> };
    expect(data.triggered).toHaveLength(1);
    expect(data.triggered[0]!.symbol).toBe('BTC');
  });

  it('removes triggered watches when removeTriggered is true', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250));
    const ctx = makeCtx({
      priceService: {
        getPrice,
      },
    });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    await checkWatchesTool.execute({ removeTriggered: true }, ctx);

    const listResult = await listWatchesTool.execute({}, ctx);
    expect((listResult.data as { watches: unknown[] }).watches).toHaveLength(0);
  });

  it('does not remove triggered watches when removeTriggered is false', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250))
      .mockResolvedValueOnce(okPrice(250));
    const ctx = makeCtx({
      priceService: {
        getPrice,
      },
    });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const firstResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const listResult = await listWatchesTool.execute({}, ctx);
    expect((listResult.data as { watches: unknown[] }).watches).toHaveLength(1);

    const secondResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);
    expect((firstResult.data as { triggered: unknown[] }).triggered).toHaveLength(1);
    expect((secondResult.data as { triggered: unknown[] }).triggered).toHaveLength(0);
  });

  it('deduplicates price lookups for watches on the same symbol and chain', async () => {
    const getPriceMock = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(350));
    const ctx = makeCtx({ priceService: { getPrice: getPriceMock } });

    // Two watches on the same symbol+chain
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 300, condition: 'above' }, ctx);

    getPriceMock.mockClear();

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Should only fetch once for the same symbol+chain pair
    expect(getPriceMock).toHaveBeenCalledTimes(1);
  });

  it('preserves Solana mint casing when evaluating watches', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    let lookupCount = 0;
    const getPriceMock = vi.fn(async (symbol: string, chain: string) => {
      expect(symbol).toBe(mint);
      expect(chain).toBe('solana');
      lookupCount += 1;
      return lookupCount === 1 ? okPrice(150) : okPrice(250);
    });
    const ctx = makeCtx({ priceService: { getPrice: getPriceMock } });

    await watchTokenTool.execute({ symbol: mint, chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    expect(getPriceMock).toHaveBeenNthCalledWith(1, mint, 'solana', mint);
    expect(getPriceMock).toHaveBeenNthCalledWith(2, mint, 'solana', mint);
    expect((result.data as { triggered: Array<{ symbol: string }> }).triggered).toHaveLength(1);
  });

  it('places watches with unavailable prices in unchecked list', async () => {
    const ctx = makeCtx({
      priceService: {
        getPrice: vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } }),
      },
    });

    await watchTokenTool.execute({ symbol: 'UNKNOWN', chain: 'solana', thresholdPrice: 1, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { unchecked: Array<{ symbol: string; reason: string }> };
    expect(data.unchecked).toHaveLength(1);
    expect(data.unchecked[0]!.symbol).toBe('UNKNOWN');
  });
});

// ── Notified-set integration tests ───────────────────────────────────────
// The agent.ts scout gating uses a Redis SET (`agent:watches:notified:{agentId}`)
// to prevent a triggered watch from forcing escalation on every subsequent tick.
// check_watches clears the notified set when the condition resets (true → false),
// and remove_watch clears it on explicit removal.

describe('check_watches — notified set', () => {
  it('SREMs the notified set when a triggered watch condition resets (true → false)', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))  // watch_token initial: below, not triggered
      .mockResolvedValueOnce(okPrice(250))  // check_watches: crosses above → triggered
      .mockResolvedValueOnce(okPrice(150)); // check_watches: falls back → reset
    const ctx = makeCtx({ priceService: { getPrice } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Verify it triggered
    const listAfterTrigger = (await listWatchesTool.execute({}, ctx)).data as { watches: Array<{ lastConditionMet: boolean }> };
    expect(listAfterTrigger.watches[0]!.lastConditionMet).toBe(true);

    // Reset: price falls back below
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const listAfterReset = (await listWatchesTool.execute({}, ctx)).data as { watches: Array<{ lastConditionMet: boolean }> };
    expect(listAfterReset.watches[0]!.lastConditionMet).toBe(false);

    // Should have SREM'd from the notified set
    const sremCalls = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const notifiedCall = sremCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:'),
    );
    expect(notifiedCall).toBeDefined();
  });

  it('does NOT SREM the notified set when condition stays met (true → true)', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250))
      .mockResolvedValueOnce(okPrice(260)); // still above
    const ctx = makeCtx({ priceService: { getPrice } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const sremCallsBefore = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls.length;
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // No new SREM calls against the notified set
    const sremCallsAfter = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const newNotifiedSremCalls = sremCallsAfter.slice(sremCallsBefore).filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:'),
    );
    expect(newNotifiedSremCalls).toHaveLength(0);
  });

  it('does NOT SREM the notified set when condition stays unmet (false → false)', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(140)) // still below
      .mockResolvedValueOnce(okPrice(130)); // still below
    const ctx = makeCtx({ priceService: { getPrice } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const sremCallsBefore = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls.length;
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const sremCallsAfter = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const newNotifiedSremCalls = sremCallsAfter.slice(sremCallsBefore).filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:'),
    );
    expect(newNotifiedSremCalls).toHaveLength(0);
  });
});

describe('remove_watch — notified set', () => {
  it('SREMs the watch ID from the notified set on removal', async () => {
    const ctx = makeCtx();
    const createResult = await watchTokenTool.execute(
      { symbol: 'WIF', chain: 'solana', thresholdPrice: 5, condition: 'above' },
      ctx,
    );
    const { watchId } = createResult.data as { watchId: string };

    await removeWatchTool.execute({ watchId }, ctx);

    // Should have called SREM on the notified set key with the watch ID
    const sremCalls = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const notifiedCall = sremCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:') && call[1] === watchId,
    );
    expect(notifiedCall).toBeDefined();
  });
});
