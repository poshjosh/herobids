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
  const botId = res.json<{ id: string }>().id;
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

  // SKIP (boundary migration, pending decision): the whole suite depends on a
  // locally-created bot (the shared `beforeEach` calls `createBot`), but
  // create_bot is now an async boundary submit that writes NO local bots row
  // (Traderton owns bots; the row is written by Traderton's worker on the next
  // tick). So `botId` does not refer to a real local bot: DELETE/stop/start read
  // the LOCAL bots table → 404, and even the "rejects non-owned bot" cases would
  // be a FALSE GREEN (they 404 because no bot exists, not because the owner check
  // rejected them). Re-enabling these needs the bot-ownership / sync-vs-async
  // create-contract decision (tracked in traderton/docs/001-parity-ledger.md,
  // "herobids functional/E2E suites are boundary-unaware"). The "rejects live
  // mode when plan lacks liveEnabled" case stays ACTIVE — it is gated by the
  // plan-entitlement check BEFORE any bot lookup/boundary call.
  it.skip('DELETE /bots/:id — deletes stopped bot, returns 204', async () => {
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

  // SKIP (false green under the boundary migration — see the note on DELETE above):
  // botId is not a real local bot, so this 404s because no bot exists, not because
  // the owner check rejected the request. Re-enable with the bot-ownership decision.
  it.skip('DELETE /bots/:id — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /bots/:id/stop ────────────────────────────────────────────

  // SKIP (boundary migration, pending decision) — see the note on DELETE above.
  it.skip('POST /bots/:id/stop — idempotent on already-stopped bot, returns 200', async () => {
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

  // SKIP (false green — see the note on DELETE above): 404s because no local bot
  // exists, not because of the owner check. Re-enable with the bot-ownership decision.
  it.skip('POST /bots/:id/stop — rejects non-owned bot, returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/bots/${botId}/stop`,
      headers: { Authorization: `Bearer ${otherUserToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /bots/:id/start ───────────────────────────────────────────

  // SKIP (boundary migration, pending decision) — see the note on DELETE above.
  it.skip('POST /bots/:id/start — enqueues start job, returns 202', async () => {
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

  // SKIP (boundary migration, pending decision): this asserts POST /bots rejects
  // paper+swap with a 400 at the API level, but herobids DROPPED the local
  // execution-capability pre-check — that validation now lives BEHIND the boundary
  // (see bots.ts: "execution-capability + config-preflight validations MOVE behind
  // the boundary"). So create now returns 201 here; the rejection is Traderton's.
  // Re-enable against a live boundary / with the create-contract decision (tracked
  // in traderton/docs/001-parity-ledger.md).
  it.skip('POST /bots/:id/start — rejects invalid execution capability (paper+swap), returns 400', async () => {
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
    // Paper+swap is invalid, so bot creation should be rejected at the API level.
    expect(createRes.statusCode).toBe(400);
    const createBody = JSON.parse(createRes.body);
    expect(createBody.error).toBe('validation_error');
    // The error should target the execution mode field
    const issuePaths = createBody.details.map((d: { path: (string | number)[] }) => d.path.join('.'));
    expect(issuePaths).toContain('execution.mode');
  });

  // SKIP (false green — see the note on DELETE above): 404s because no local bot
  // exists, not because of the owner check. Re-enable with the bot-ownership decision.
  it.skip('POST /bots/:id/start — rejects non-owned bot, returns 404', async () => {
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
