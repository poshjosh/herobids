/**
 * Functional tests for GET /agents/:agentId/capabilities/trading/positions.
 * Requires a live DATABASE_URL and REDIS_URL.
 * Automatically skipped when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  if (SKIP) return;
  ctx = await buildApp();
}, 30_000);

afterAll(async () => {
  if (SKIP) return;
  await truncateAll(ctx.db);
  await ctx.redisClient.quit();
  await ctx.lifecycleQueue.close();
  await ctx.app.close();
});

beforeEach(async () => {
  if (SKIP) return;
  await truncateAll(ctx.db);
});

describe.skipIf(SKIP)('GET /agents/:agentId/capabilities/trading/positions — functional', () => {
  async function createAgent(token: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents',
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: 'Trade History Agent', prompt: 'Run trading strategies.', skillIds: [] },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function setupTradingLink(token: string): Promise<{ connectionId: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        provider: 'hyperliquid',
        label: 'Test Hyperliquid binding',
        secrets: {
          apiKey: 'test-api-key',
          secret: 'test-secret',
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        capability: 'trading',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ connection: { id: string } }>();
    return { connectionId: body.connection.id };
  }

  async function bindAgent(token: string, agentId: string, connectionId: string): Promise<void> {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { connectionIds: [connectionId] },
    });
    expect([200, 201]).toContain(res.statusCode);
  }

  /**
   * Seed the stub boundary's agent-scoped evidence stores. Rows keep the exact
   * field values the previous local-table inserts used, with dates as ISO
   * strings and numerics as strings (the read path rehydrates dates via
   * toFillRow/toPositionRow). Fill identity fields (actorType/actorId/
   * venueAccountId/venue/symbol/filledAt) must match the position so the
   * in-app exitPrice correlation logic pairs them.
   */
  function seedPositions(opts: {
    agentId: string;
    botId: string;
    venueAccountId: string;
    positions: Array<Record<string, unknown>>;
    fills?: Array<Record<string, unknown>>;
  }): void {
    ctx.seedAgentPositions(
      opts.agentId,
      opts.positions.map((row) => ({ actorType: 'bot', actorId: opts.botId, ...row })),
    );
    if (opts.fills) {
      ctx.seedAgentFills(
        opts.agentId,
        opts.fills.map((row) => ({ actorType: 'bot', actorId: opts.botId, ...row })),
      );
    }
  }

  it('returns 404 for an agent belonging to another user', async () => {
    const ownerToken = await registerUser(ctx.app, ctx.db, 'owner@positions.test');
    const otherToken = await registerUser(ctx.app, ctx.db, 'other@positions.test');

    const agentId = await createAgent(ownerToken);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/positions`,
      headers: { Authorization: `Bearer ${otherToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('agent.not_found');
  });

  it('returns empty items when agent has no binding or bots', async () => {
    const token = await registerUser(ctx.app, ctx.db, 'empty@positions.test');
    const agentId = await createAgent(token);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/positions`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agentId: string; family: string; items: unknown[]; limit: number; offset: number }>();
    expect(body.agentId).toBe(agentId);
    expect(body.family).toBe('trading');
    expect(body.items).toEqual([]);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('returns positions with derived exitPrice for closed positions', async () => {
    const token = await registerUser(ctx.app, ctx.db, 'closed@positions.test');
    const agentId = await createAgent(token);
    const { connectionId } = await setupTradingLink(token);
    await bindAgent(token, agentId, connectionId);

    const botId = 'bot-01000000-0000-7000-8000-000000000001';
    const venueAccountId = 'va-01000000-0000-7000-8000-000000000001';

    const openedAt = '2026-06-01T10:00:00.000Z';
    const closedAt = '2026-06-01T14:30:00.000Z';

    seedPositions({
      agentId,
      botId,
      venueAccountId,
      positions: [
        {
          id: 'pos-01000000-0000-7000-8000-000000000001',
          venueAccountId,
          venue: 'hyperliquid',
          symbol: 'SOL-PERP',
          side: 'long',
          size: '1.5',
          entryPrice: '145.00',
          realizedPnl: '10.95',
          openedAt,
          closedAt,
          updatedAt: closedAt,
          createdAt: closedAt,
        },
      ],
      fills: [
        {
          id: 'fill-01000000-0000-7000-8000-000000000001',
          orderId: 'ord-01000000-0000-7000-8000-000000000001',
          venueAccountId,
          venue: 'hyperliquid',
          symbol: 'SOL-PERP',
          side: 'sell',
          quantity: '1.5',
          price: '152.30',
          filledAt: '2026-06-01T14:29:00.000Z',
          createdAt: '2026-06-01T14:29:00.000Z',
        },
      ],
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/positions`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<Record<string, unknown>> }>();
    expect(body.items).toHaveLength(1);

    const item = body.items[0]!;
    expect(item['symbol']).toBe('SOL-PERP');
    expect(item['venue']).toBe('hyperliquid');
    expect(item['side']).toBe('long');
    expect(item['status']).toBe('closed');
    expect(item['entryPrice']).toBe('145.00');
    expect(item['exitPrice']).toBe('152.30');
    expect(item['realizedPnl']).toBe('10.950000');
    expect(typeof item['holdMs']).toBe('number');
    expect(item['holdMs']).toBe(
      new Date(closedAt).getTime() - new Date(openedAt).getTime(),
    );
  });

  it('returns open positions without exitPrice or hold duration', async () => {
    const token = await registerUser(ctx.app, ctx.db, 'open@positions.test');
    const agentId = await createAgent(token);
    const { connectionId } = await setupTradingLink(token);
    await bindAgent(token, agentId, connectionId);

    const botId = 'bot-03000000-0000-7000-8000-000000000001';
    const venueAccountId = 'va-03000000-0000-7000-8000-000000000001';

    const openedAt = '2026-06-01T11:15:00.000Z';

    seedPositions({
      agentId,
      botId,
      venueAccountId,
      positions: [
        {
          id: 'pos-03000000-0000-7000-8000-000000000001',
          venueAccountId,
          venue: 'hyperliquid',
          symbol: 'ETH-PERP',
          side: 'short',
          size: '2',
          entryPrice: '3400.00',
          realizedPnl: '0',
          openedAt,
          updatedAt: openedAt,
          createdAt: openedAt,
        },
      ],
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/positions`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<Record<string, unknown>> }>();
    expect(body.items).toHaveLength(1);

    const item = body.items[0]!;
    expect(item['status']).toBe('open');
    expect(item['exitPrice']).toBeNull();
    expect(item['closedAt']).toBeNull();
    expect(item['holdMs']).toBeNull();
  });

  it('paginates correctly with limit and offset', async () => {
    const token = await registerUser(ctx.app, ctx.db, 'paginate@positions.test');
    const agentId = await createAgent(token);
    const { connectionId } = await setupTradingLink(token);
    await bindAgent(token, agentId, connectionId);

    const botId = 'bot-02000000-0000-7000-8000-000000000001';
    const venueAccountId = 'va-02000000-0000-7000-8000-000000000001';

    // 3 positions with different openedAt times (all still open — no fills needed)
    const positionData = [
      { id: 'pos-02000000-0000-7000-8000-000000000001', openedAt: '2026-06-01T08:00:00.000Z' },
      { id: 'pos-02000000-0000-7000-8000-000000000002', openedAt: '2026-06-01T09:00:00.000Z' },
      { id: 'pos-02000000-0000-7000-8000-000000000003', openedAt: '2026-06-01T10:00:00.000Z' },
    ];

    seedPositions({
      agentId,
      botId,
      venueAccountId,
      positions: positionData.map((pos) => ({
        id: pos.id,
        venueAccountId,
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        side: 'long',
        size: '0.1',
        entryPrice: '60000.00',
        realizedPnl: '0',
        openedAt: pos.openedAt,
        updatedAt: pos.openedAt,
        createdAt: pos.openedAt,
      })),
    });

    // limit=2 should return the 2 most recent
    const page1 = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/positions?limit=2&offset=0`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json<{ items: Array<Record<string, unknown>>; limit: number; offset: number }>();
    expect(page1Body.items).toHaveLength(2);
    expect(page1Body.limit).toBe(2);
    expect(page1Body.offset).toBe(0);
    // Most recent first
    expect(page1Body.items[0]!['id']).toBe('pos-02000000-0000-7000-8000-000000000003');
    expect(page1Body.items[1]!['id']).toBe('pos-02000000-0000-7000-8000-000000000002');

    // offset=2 should return the oldest
    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/positions?limit=2&offset=2`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json<{ items: Array<Record<string, unknown>>; limit: number; offset: number }>();
    expect(page2Body.items).toHaveLength(1);
    expect(page2Body.items[0]!['id']).toBe('pos-02000000-0000-7000-8000-000000000001');
  });
});
