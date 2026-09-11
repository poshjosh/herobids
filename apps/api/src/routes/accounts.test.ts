import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { venueAccountRoutes } from './accounts.js';
import type { AppConfig } from '@herobids/domain';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';
import { HyperliquidAdapter } from '@herobids/venues';

/**
 * L3-P1b: a stubbed TradertonClient. DELETE /venue-accounts/:id now routes to
 * the boundary (`deprovision_venue_account`) instead of a local venue_accounts
 * delete. The stub records invoke calls and returns a scripted client result.
 */
function makeTradertonClient(
  result: TradertonClientResult = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { venueAccountId: 'va-1', deleted: true } },
): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/**
 * Route-level tests for venue-account credential linkage validation.
 * Verifies that POST /venue-accounts rejects invalid credential references.
 */

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
  and: vi.fn((...args) => ({ _and: args })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: strings.join('') })),
}));

const TEST_USER_ID = 'user-1';

/** Decorate Fastify app with a fake authenticated userId and planId (simulates auth plugin) */
function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

let credentialLookupResult: Record<string, unknown>[] = [];
let insertedRow: Record<string, unknown> | undefined;

function buildMockDb() {
  insertedRow = undefined;
  let selectCallCount = 0;

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v) => { insertedRow = v; return Promise.resolve(); }),
    }),
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockImplementation((_table) => {
        selectCallCount++;
        return {
          where: vi.fn().mockImplementation(() => {
            // First select call is credential validation lookup;
            // subsequent calls are the post-insert select
            if (selectCallCount === 1) {
              return credentialLookupResult;
            }
            // Post-insert read returns the created row
            return [{ id: 'va-new', ...insertedRow }];
          }),
        };
      }),
    })),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  } as any;
}

describe('POST /venue-accounts credential validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialLookupResult = [];
  });

  it('passes configured Hyperliquid baseUrl into the probe', async () => {
    const probeSpy = vi.spyOn(HyperliquidAdapter, 'probe').mockResolvedValue({
      venue: 'hyperliquid',
      venueType: 'orderbook',
      availableSymbols: [],
      supportedExecutionModes: ['paper'],
      authenticated: false,
      probedAt: '2026-06-09T00:00:00.000Z',
    });

    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db, undefined, {
      hyperliquid: {
        baseUrl: 'https://hyperliquid-custom.example',
      },
    } as AppConfig['venues']);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(probeSpy).toHaveBeenCalledWith(undefined, {
      baseUrl: 'https://hyperliquid-custom.example',
    });
  });

  it('rejects when credentialId references a nonexistent credential', async () => {
    credentialLookupResult = []; // credential not found
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'nonexistent-cred',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('credential.not_found');
  });

  it('rejects when credential belongs to a different user', async () => {
    // The ownership-scoped WHERE filters out foreign credentials, so the mock returns empty —
    // the same response as a missing credential (prevents probing foreign IDs).
    credentialLookupResult = [];
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('credential.not_found');
  });

  it('rejects when credential is for a different venue', async () => {
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', provider: 'jupiter' }];
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('credential.provider_mismatch');
  });

  it('succeeds when credential matches user and venue', async () => {
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', provider: 'hyperliquid' }];
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('keeps Hyperliquid venueProfile aligned with the unauthenticated probe even when a credential is linked', async () => {
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', provider: 'hyperliquid' }];
    const probeSpy = vi.spyOn(HyperliquidAdapter, 'probe').mockResolvedValue({
      venue: 'hyperliquid',
      venueType: 'orderbook',
      availableSymbols: ['BTC/USD:USD'],
      supportedExecutionModes: ['paper', 'shadow'],
      authenticated: false,
      probedAt: '2026-06-09T00:00:00.000Z',
    });

    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(probeSpy).toHaveBeenCalledWith(undefined, {
      baseUrl: undefined,
    });
    expect(body.venueProfile?.authenticated).toBe(false);
    expect(body.venueProfile?.supportedExecutionModes).toEqual(['paper', 'shadow']);
  });

  it('succeeds when no credentialId is provided (wallet-only, non-swap venue)', async () => {
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'My Account',
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('succeeds when jupiter account provides a valid Solana wallet address', async () => {
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'jupiter',
        label: 'Swap Wallet',
        venueAccountRef: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('rejects jupiter account without a wallet address', async () => {
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'jupiter',
        label: 'Swap Wallet',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('account.validation_error.missing_venue_account_ref');
    expect(body.message).toContain('Solana wallet address');
    expect(body.params).toEqual({ field: 'venueAccountRef', venue: 'jupiter' });
  });

  it('rejects jupiter account with an address that is not a valid 32-byte Solana public key', async () => {
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    // 'tooshort' decodes to fewer than 32 bytes — not a valid Ed25519 public key
    const resShort = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: { venue: 'jupiter', label: 'Swap Wallet', venueAccountRef: 'tooshort' },
    });
    expect(resShort.statusCode).toBe(400);
    expect(JSON.parse(resShort.body).error).toBe('account.validation_error.invalid_venue_account_ref');

    // '0x...' contains '0' and 'x' which are not in the base58 alphabet
    const resHex = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: { venue: 'jupiter', label: 'Swap Wallet', venueAccountRef: '0x3419aabbccdd112233445566778899aabb112233' },
    });
    expect(resHex.statusCode).toBe(400);
    expect(JSON.parse(resHex.body).error).toBe('account.validation_error.invalid_venue_account_ref');
  });

  it('rejects 1inch account without a credential', async () => {
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: '1inch',
        label: 'My 1inch Account',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('account.validation_error.missing_credential_id');
    expect(body.message).toContain('credentialId');
    expect(body.params).toEqual({ field: 'credentialId', venue: '1inch' });
  });

  it('creates 1inch account with venueProfile set to swap/authenticated when credential is linked', async () => {
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', provider: '1inch' }];
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: '1inch',
        label: 'My 1inch Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.venueProfile?.venueType).toBe('swap');
    expect(body.venueProfile?.authenticated).toBe(true);
  });

  it('returns 400 when credential is deleted between validation and insert (FK race)', async () => {
    // Credential lookup succeeds (not yet deleted)
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', provider: 'hyperliquid' }];
    const app = Fastify();
    const db = buildMockDb();
    // Override insert to throw FK violation
    const fkError = new Error('insert or update on table "venue_accounts" violates foreign key constraint') as Error & { code: string };
    fkError.code = '23503';
    db.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockRejectedValue(fkError),
    });
    decorateWithAuth(app);
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('credential.not_found');
  });
});

describe('DELETE /venue-accounts/:id (L3-P1b — boundary-owned)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialLookupResult = [];
  });

  it('returns 404 when the boundary reports the venue account is not found', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'Venue account not found: missing-id',
      retryable: false,
      details: { errorCode: 'not_found.resource' },
    });
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/venue-accounts/missing-id',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('not_found');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].toolName).toBe('deprovision_venue_account');
    expect(invoke.mock.calls[0]![0].payload).toEqual({ venueAccountId: 'missing-id' });
    expect(invoke.mock.calls[0]![0].subject).toEqual({ ownerId: 'user-1', actor: { type: 'user', id: 'user-1' } });
  });

  it('deletes the venue account over the boundary on success', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: { venueAccountId: 'va-1', deleted: true },
    });
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/venue-accounts/va-1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('deleted');
    expect(body.venueAccountId).toBe('va-1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('returns 409 venue_account_in_use when the boundary reports in-use (with derivable botIds)', async () => {
    const { client } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'Venue account va-1 is in use by bot(s): bot-1',
      retryable: false,
      details: { errorCode: 'provision.in_use', botIds: ['bot-1'] },
    });
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/venue-accounts/va-1',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('venue_account_in_use');
    expect(body.venueAccountId).toBe('va-1');
    expect(body.blockingBotIds).toEqual(['bot-1']);
  });

  it('returns 409 venue_account_in_use without botIds when the boundary omits them', async () => {
    const { client } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'Venue account va-1 is in use',
      retryable: false,
      details: { errorCode: 'provision.in_use' },
    });
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/venue-accounts/va-1',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('venue_account_in_use');
    expect(body.venueAccountId).toBe('va-1');
    expect(body.blockingBotIds).toBeUndefined();
  });

  it('returns 503 when the trading boundary is unavailable', async () => {
    const { client } = makeTradertonClient({
      kind: 'transport_error',
      requestId: 'r',
      retryable: true,
      message: 'boundary down',
    });
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/venue-accounts/va-1',
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('precondition.not_ready');
  });

  it('returns 503 when no boundary client is configured', async () => {
    const app = Fastify();
    const db = buildMockDb();
    decorateWithAuth(app);
    await venueAccountRoutes(app, db); // no client

    const res = await app.inject({
      method: 'DELETE',
      url: '/venue-accounts/va-1',
    });

    expect(res.statusCode).toBe(503);
  });
});
