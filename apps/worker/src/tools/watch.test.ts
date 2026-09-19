import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';

// Import watch tools via dynamic import to test them isolated
// We must import the module's exported array after setting up mocks.
const { watchTools } = await import('./watch.js');

const watchTokenTool = watchTools.find((t) => t.name === 'watch_token')!;
const listWatchesTool = watchTools.find((t) => t.name === 'list_watches')!;
const removeWatchTool = watchTools.find((t) => t.name === 'remove_watch')!;
const checkWatchesTool = watchTools.find((t) => t.name === 'check_watches')!;

function makeCtx(overrides: {
  redis?: Partial<ToolContext['redis']>;
  priceService?: ToolContext['priceService'] | null;
  instrumentRepo?: ToolContext['instrumentRepo'] | null;
  tradertonBoundary?: ToolContext['tradertonBoundary'];
  tradertonWriteBoundary?: ToolContext['tradertonWriteBoundary'];
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
    priceService: overrides.priceService === null ? undefined : overrides.priceService,
    instrumentRepo: overrides.instrumentRepo === null ? undefined : overrides.instrumentRepo,
    tradertonBoundary: overrides.tradertonBoundary,
    tradertonWriteBoundary: overrides.tradertonWriteBoundary,
  } as unknown as ToolContext;
}

/** Seed a watch record directly into the local redis hash for read-path tests. */
async function seedWatch(ctx: ToolContext, watch: Record<string, unknown>): Promise<void> {
  await ctx.redis.hset(
    `agent:watches:${ctx.agentId}`,
    watch['watchId'] as string,
    JSON.stringify({ schemaVersion: 2, purpose: 'alert', lastConditionMet: null, ...watch }),
  );
}

// ── Fail-closed writes (B3) ───────────────────────────────────────────────
// Watch state lives Traderton-side. The three WRITE tools must FAIL CLOSED —
// return a typed precondition.not_ready (non-fault) — when the Traderton write
// boundary is absent. They must NOT touch the local redis hash or price service.

describe('watch write tools — fail closed without a write boundary', () => {
  it('watch_token fails closed with precondition.not_ready', async () => {
    const resolvePriceTarget = vi.fn();
    const getPrice = vi.fn();
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } }); // no tradertonWriteBoundary

    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
    // No in-process work when the boundary is absent.
    expect(resolvePriceTarget).not.toHaveBeenCalled();
    expect(getPrice).not.toHaveBeenCalled();
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('remove_watch fails closed with precondition.not_ready', async () => {
    const ctx = makeCtx(); // no tradertonWriteBoundary

    const result = await removeWatchTool.execute(
      { watchId: '00000000-0000-4000-8000-000000000000' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
    expect(ctx.redis.hdel).not.toHaveBeenCalled();
  });

  it('check_watches fails closed with precondition.not_ready', async () => {
    const getPrice = vi.fn();
    const resolvePriceTarget = vi.fn();
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } }); // no tradertonWriteBoundary

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
    expect(getPrice).not.toHaveBeenCalled();
    expect(ctx.redis.hgetall).not.toHaveBeenCalled();
  });
});

// ── list_watches read — fail closed (A6) ─────────────────────────────
// The READ path is boundary-first and FAILS CLOSED when the read boundary is
// absent — the legacy local Redis hash no longer receives writes (stale-data
// trap). No local fallback.

describe('list_watches — fail closed without a read boundary (A6)', () => {
  it('fails closed with precondition.not_ready and does NOT read local redis', async () => {
    const ctx = makeCtx();

    const result = await listWatchesTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
    // No local fallback read — the legacy hash is never consulted.
    expect(ctx.redis.hgetall).not.toHaveBeenCalled();
  });
});

// ── Traderton boundary routing (B3) ──────────────────────────────────────
// After B3 the watch tools route over the Traderton boundary when it is
// configured: list_watches is a READ (ctx.tradertonBoundary.invoke), and
// watch_token / remove_watch / check_watches are WRITES
// (ctx.tradertonWriteBoundary.invokeAndAwait). The boundary branch returns
// before any in-process priceService/instrumentRepo/botRepo/redis logic.

describe('list_watches — boundary routing', () => {
  it('routes the read over the boundary and does not touch local redis', async () => {
    const boundaryWatches = [
      { watchId: '00000000-0000-4000-8000-000000000001', symbol: 'SOL', chain: 'solana' },
    ];
    const invoke = vi.fn().mockResolvedValue({ kind: 'success', data: { ok: true, watches: boundaryWatches } });
    const ctx = makeCtx({ tradertonBoundary: { invoke } });

    const result = await listWatchesTool.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_watches', payload: {} });
    expect(result.success).toBe(true);
    expect((result.data as { watches: unknown[] }).watches).toEqual(boundaryWatches);
    // Boundary-sourced — the local redis hash is never read.
    expect(ctx.redis.hgetall).not.toHaveBeenCalled();
  });

  it('maps a boundary failure to a typed non-fault failure preserving code', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'failure',
      code: 'validation.invalid_payload',
      message: 'bad payload',
      retryable: false,
    });
    const ctx = makeCtx({ tradertonBoundary: { invoke } });

    const result = await listWatchesTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_payload');
    expect(result.fault).toBe(false);
  });
});

describe('watch_token — boundary routing', () => {
  it('forwards raw params over the write boundary (coverage.positionKey NOT pre-stripped) and skips in-process logic', async () => {
    const successPayload = { ok: true, watchId: 'w-1', symbol: 'SOL', chain: 'solana' };
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'success', requestId: 'req-1', correlationId: 'corr-1', payload: successPayload,
    });
    const resolvePriceTarget = vi.fn();
    const getPrice = vi.fn();
    const search = vi.fn();
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: { search },
    });

    const coverage = {
      actorType: 'agent' as const,
      // A caller-supplied positionKey must be forwarded VERBATIM — the
      // Traderton-side copied tool owns the strip, not the platform.
      positionKey: 'caller-supplied-key',
    };
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above', note: 'n', purpose: 'monitor', coverage },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(successPayload);

    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    const call = invokeAndAwait.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown>; deadlineMs: number };
    expect(call.toolName).toBe('watch_token');
    expect(call.deadlineMs).toBeGreaterThan(0);
    expect(call.payload).toEqual({
      symbol: 'SOL',
      chain: 'solana',
      thresholdPrice: 200,
      condition: 'above',
      note: 'n',
      purpose: 'monitor',
      coverage,
    });
    // The raw coverage.positionKey survives to the boundary un-stripped.
    expect((call.payload.coverage as { positionKey?: string }).positionKey).toBe('caller-supplied-key');

    // In-process work never runs when routed over the boundary.
    expect(resolvePriceTarget).not.toHaveBeenCalled();
    expect(getPrice).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('maps a boundary failure to a typed failure preserving code', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'failure', requestId: 'req-1', code: 'validation.invalid_payload', message: 'nope', retryable: false,
    });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_payload');
    expect(result.fault).toBe(false);
  });
});

describe('remove_watch — boundary routing', () => {
  it('forwards the watchId over the write boundary and does not touch local redis', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'success', requestId: 'req-1', correlationId: 'corr-1', payload: { ok: true, watchId: 'w-1', removed: true },
    });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const watchId = '00000000-0000-4000-8000-000000000009';
    const result = await removeWatchTool.execute({ watchId }, ctx);

    expect(result.success).toBe(true);
    const call = invokeAndAwait.mock.calls[0]![0] as { toolName: string; payload: unknown; deadlineMs: number };
    expect(call.toolName).toBe('remove_watch');
    expect(call.payload).toEqual({ watchId });
    expect(call.deadlineMs).toBeGreaterThan(0);
    // Boundary-routed — never mutates the local redis hash.
    expect(ctx.redis.hdel).not.toHaveBeenCalled();
  });
});

describe('check_watches — boundary routing', () => {
  it('forwards removeTriggered over the write boundary and skips in-process price evaluation', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'success', requestId: 'req-1', correlationId: 'corr-1', payload: { ok: true, triggered: [], unchecked: [] },
    });
    const getPrice = vi.fn();
    const resolvePriceTarget = vi.fn();
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      priceService: { getPrice, resolvePriceTarget },
    });

    const result = await checkWatchesTool.execute({ removeTriggered: true }, ctx);

    expect(result.success).toBe(true);
    const call = invokeAndAwait.mock.calls[0]![0] as { toolName: string; payload: unknown; deadlineMs: number };
    expect(call.toolName).toBe('check_watches');
    expect(call.payload).toEqual({ removeTriggered: true });
    expect(call.deadlineMs).toBeGreaterThan(0);
    // The in-process price service is not consulted when routed over the boundary.
    expect(getPrice).not.toHaveBeenCalled();
    expect(ctx.redis.hgetall).not.toHaveBeenCalled();
  });

  it('maps a boundary transport_error to a retryable fault', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({ kind: 'transport_error', requestId: 'req-1', retryable: true, message: 'down' });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('boundary.transport_error');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(true);
  });
});
