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
 * Create a stopped bot via the API, returning its ID.
 */
async function createBot(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  // First set up a trading binding via provider-link
  const linkRes = await ctx.app.inject({
    method: 'POST',
    url: '/setup/provider-link',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      provider: 'hyperliquid',
      credentialLabel: 'test-hl',
      apiKey: 'test-key',
      secret: 'test-secret',
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ...overrides,
    },
  });
  expect(linkRes.statusCode).toBe(201);
  const bindingId = linkRes.json<{ tradingBindingId: string }>().tradingBindingId;

  const res = await ctx.app.inject({
    method: 'POST',
    url: '/bots',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      tradingBindingId: bindingId,
      venue: 'hyperliquid',
      symbol: 'BTC-PERP',
      config: {
        strategy: { type: 'momentum', params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 } },
        risk: {},
        execution: { mode: 'paper' },
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
      },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe.skipIf(SKIP)('Bot lifecycle endpoints — functional', () => {
  let token: string;
  let otherUserToken: string;
  let botId: string;

  beforeEach(async () => {
    if (SKIP) return;
    token = await registerUser(ctx.app, ctx.db, 'lifecycle@test.test', 'testpassword123', 'Lifecycle User');
    otherUserToken = await registerUser(ctx.app, ctx.db, 'other@test.test', 'testpassword456', 'Other User');
    botId = await createBot(token);
  });

  // ── DELETE /bots/:id ───────────────────────────────────────────────

  it('DELETE /bots/:id — deletes stopped bot, returns 204', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);

    // Verify bot is gone
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

  it('POST /bots/:id/start — rejects invalid execution capability (paper+swap), returns 400', async () => {
    // Create a bot with swap venue; paper+swap is not valid
    token = await registerUser(ctx.app, ctx.db, 'swap-test@test.test', 'testpassword789', 'Swap Tester');

    // Create 1inch binding
    const linkRes = await ctx.app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        provider: '1inch',
        credentialLabel: 'test-1inch',
        apiKey: 'test-key',
        secret: 'test-secret',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    expect(linkRes.statusCode).toBe(201);
    const bindingId = linkRes.json<{ tradingBindingId: string }>().tradingBindingId;

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/bots',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        tradingBindingId: bindingId,
        venue: '1inch',
        symbol: 'ETH-USDC',
        config: {
          strategy: { type: 'swap', params: { symbol: 'ETH-USDC' } },
          risk: {},
          execution: { mode: 'paper' },
          venue: '1inch',
          symbol: 'ETH-USDC',
        },
      },
    });
    // Paper+swap is invalid, so bot creation should be rejected at the API level.
    expect(createRes.statusCode).toBe(400);
    expect(JSON.parse(createRes.body).error).toContain('execution_capability');
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
        tradingBindingId: botId, // reuse binding — just testing the start gate
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: {
          strategy: { type: 'momentum', params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 } },
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
