import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { venueAccountRoutes } from './accounts.js';
import type { AppConfig } from '@herobids/domain';
import { HyperliquidAdapter } from '@herobids/venues';

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
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', venue: 'jupiter' }];
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
    expect(body.error).toBe('credential.venue_mismatch');
  });

  it('succeeds when credential matches user and venue', async () => {
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', venue: 'hyperliquid' }];
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
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', venue: 'hyperliquid' }];
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
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', venue: '1inch' }];
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
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', venue: 'hyperliquid' }];
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
