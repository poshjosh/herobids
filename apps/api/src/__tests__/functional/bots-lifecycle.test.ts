/**
 * Functional tests for bot lifecycle endpoints:
 *   DELETE /bots/:id
 *   POST  /bots/:id/stop
 *   POST  /bots/:id/start
 *
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

/**
 * Create a stopped bot via the API, returning its ID and binding ID.
 */
async function createBot(token: string, overrides: Record<string, unknown> = {}): Promise<{ botId: string; connectionId: string }> {
  // First set up a connection via provider-link
  const linkRes = await ctx.app.inject({
    method: 'POST',
    url: '/setup/provider-link',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      provider: 'hyperliquid',
      label: 'test-hl',
      secrets: {
        apiKey: 'test-key',
        secret: 'test-secret',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      capability: 'trading',
      ...overrides,
    },
  });
  expect(linkRes.statusCode).toBe(201);
  const connectionId = linkRes.json<{ connection: { id: string } }>().connection.id;

  const res = await ctx.app.inject({
    method: 'POST',
    url: '/bots',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      connectionId,
      venue: 'hyperliquid',
      symbol: 'BTC-PERP',
      config: {
        strategy: { type: 'momentum', decisionMode: 'mechanical', params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 } },
        risk: {},
        execution: { mode: 'paper' },
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
      },
    },
  });
  expect(res.statusCode).toBe(201);
  // consume-traderton: create_bot over the boundary returns { botId }; the route
  // echoes both `id` and `botId` in the 201 body.
  const botId = res.json<{ id: string }>().id;
  expect(typeof botId).toBe('string');
  return { botId, connectionId };
}

describe.skipIf(SKIP)('Bot lifecycle endpoints — functional', () => {
  let token: string;
  let otherUserToken: string;
  let botId: string;
  let connectionId: string;

  beforeEach(async () => {
    if (SKIP) return;
    token = await registerUser(ctx.app, ctx.db, 'lifecycle@test.test', 'testpassword123', 'Lifecycle User');
    otherUserToken = await registerUser(ctx.app, ctx.db, 'other@test.test', 'testpassword456', 'Other User');
    const created = await createBot(token);
    botId = created.botId;
    connectionId = created.connectionId;
  });

  // ── DELETE /bots/:id ───────────────────────────────────────────────

  // Wave A1 (ratified): DELETE now routes over the authoritative `delete_bot`
  // boundary tool (the stub records/removes the bot owner-scoped). DELETE/stop/
  // start resolve existence/ownership/status over the (stubbed) boundary
  // (`get_owner_bot_status`), so these are TRUE reds — the "rejects non-owned
  // bot" cases 404 from the owner check (the bot exists but is owned by another
  // user), not from an empty table.
  it('DELETE /bots/:id — deletes stopped bot, returns 204', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    // Wave A1: the boundary delete is authoritative, so the bot is GONE — a
    // subsequent boundary read (GET) resolves not-found → 404.
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it('DELETE /bots/:id — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /bots/:id — refuses to delete a running bot, returns 409', async () => {
    // Start the bot first so the boundary reports it running.
    const startRes = await ctx.app.inject({
      method: 'POST',
      url: `/bots/${botId}/start`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(startRes.statusCode).toBe(202);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── POST /bots/:id/stop ────────────────────────────────────────────

  it('POST /bots/:id/stop — idempotent on already-stopped bot, returns 200', async () => {
    // Bot is stopped by default
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/bots/${botId}/stop`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; botId: string }>();
    expect(body.status).toBe('already_stopped');
    expect(body.botId).toBe(botId);
  });

  it('POST /bots/:id/stop — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/bots/${botId}/stop`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /bots/:id/start ───────────────────────────────────────────

  it('POST /bots/:id/start — enqueues start job, returns 202', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/bots/${botId}/start`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ status: string; botId: string }>();
    expect(body.status).toBe('starting');
    expect(body.botId).toBe(botId);
  });

  // consume-traderton (ratified B1): the local execution-capability pre-check is
  // DROPPED — that validation lives BEHIND the boundary. create_bot returns a
  // `validation.invalid_payload` failure with
  // details.errorCode:'execution_capability.paper_swap_not_supported' for a
  // paper+swap config; the route maps it to a 400 that PRESERVES the paper_swap
  // identity (error code, not a generic validation_error).
  it('POST /bots — rejects invalid execution capability (paper+swap), returns 400', async () => {
    // Create a bot with swap venue; paper+swap is not valid
    token = await registerUser(ctx.app, ctx.db, 'swap-test@test.test', 'testpassword789', 'Swap Tester');

    // Create 1inch binding
    const linkRes = await ctx.app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        provider: '1inch',
        label: 'test-1inch',
        secrets: {
          apiKey: 'test-key',
          privateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        capability: 'trading',
      },
    });
    expect(linkRes.statusCode).toBe(201);
    const connectionId = linkRes.json<{ connection: { id: string } }>().connection.id;

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/bots',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        connectionId,
        venue: '1inch',
        symbol: 'ETH-USDC',
        config: {
          strategy: { type: 'momentum', decisionMode: 'mechanical', params: { symbol: 'ETH-USDC' } },
          risk: {},
          execution: { mode: 'paper' },
          venue: '1inch',
          symbol: 'ETH-USDC',
          swapAssets: { baseAsset: 'ETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        },
      },
    });
    // Paper+swap is invalid; the boundary rejects create_bot and the route maps
    // it to a 400 that surfaces the paper_swap identity.
    expect(createRes.statusCode).toBe(400);
    const createBody = JSON.parse(createRes.body) as { error: string; message: string };
    expect(createBody.error).toBe('execution_capability.paper_swap_not_supported');
  });

  it('POST /bots/:id/start — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/bots/${botId}/start`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /bots/:id/start — rejects live mode when plan lacks liveEnabled, returns 403', async () => {
    // Create a bot with live execution mode
    const liveRes = await ctx.app.inject({
      method: 'POST',
      url: '/bots',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        connectionId,
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: {
          strategy: { type: 'momentum', decisionMode: 'mechanical', params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 } },
          risk: {},
          execution: { mode: 'live' },
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
        },
      },
    });
    // Bot creation with live execution should be rejected because the 'free' plan lacks liveEnabled
    expect(liveRes.statusCode).toBe(403);
    expect(JSON.parse(liveRes.body).error).toContain('live');
  });
});

// ── Wave A2: owner-scoped bot read endpoints ─────────────────────────────────
//
// GET /bots/:id/costs | /sessions | /events | /journal | /journal/summary now
// route over the owner-scoped boundary read tools (get_owner_bot_costs /
// get_owner_bot_sessions / get_owner_bot_journal / get_owner_bot_journal_summary).
// Light assertions over the stubbed boundary: the endpoint returns 200 with the
// preserved response shape, and a bot owned by another user resolves not-found
// → 404 (the owner check is NOT weakened).
describe.skipIf(SKIP)('Bot read endpoints (Wave A2) — functional', () => {
  let token: string;
  let otherUserToken: string;
  let botId: string;

  beforeEach(async () => {
    if (SKIP) return;
    token = await registerUser(ctx.app, ctx.db, 'reads@test.test', 'testpassword123', 'Reads User');
    otherUserToken = await registerUser(ctx.app, ctx.db, 'reads-other@test.test', 'testpassword456', 'Reads Other');
    const created = await createBot(token);
    botId = created.botId;
  });

  it('GET /bots/:id/costs — returns 200 with { botId, feesByCurrency }', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/costs`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; feesByCurrency: Record<string, string> }>();
    expect(body.botId).toBe(botId);
    expect(typeof body.feesByCurrency).toBe('object');
  });

  it('GET /bots/:id/costs — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/costs`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /bots/:id/sessions — returns 200 with { botId, sessions, limit, offset }', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/sessions`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; sessions: unknown[]; limit: number; offset: number }>();
    expect(body.botId).toBe(botId);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('GET /bots/:id/events — returns 200 with { botId, events }', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/events`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; events: unknown[] }>();
    expect(body.botId).toBe(botId);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /bots/:id/journal — returns 200 with { botId, events, limit, offset }', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/journal`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; events: unknown[]; limit: number; offset: number }>();
    expect(body.botId).toBe(botId);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('GET /bots/:id/journal/summary — returns 200 with { botId, tradeCount, feesByCurrency }', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/journal/summary`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; tradeCount: number; feesByCurrency: Record<string, string> }>();
    expect(body.botId).toBe(botId);
    expect(typeof body.tradeCount).toBe('number');
    expect(typeof body.feesByCurrency).toBe('object');
  });

  it('GET /bots/:id/journal/summary — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bots/${botId}/journal/summary`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
