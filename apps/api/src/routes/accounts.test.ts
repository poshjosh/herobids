import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { venueAccountRoutes } from './accounts.js';

/**
 * Route-level tests for venue-account credential linkage validation.
 * Verifies that POST /venue-accounts rejects invalid credential references.
 */

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
}));

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

  it('rejects when credentialId references a nonexistent credential', async () => {
    credentialLookupResult = []; // credential not found
    const app = Fastify();
    const db = buildMockDb();
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        userId: 'user-1',
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
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-other', venue: 'hyperliquid' }];
    const app = Fastify();
    const db = buildMockDb();
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        userId: 'user-1',
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('credential.user_mismatch');
  });

  it('rejects when credential is for a different venue', async () => {
    credentialLookupResult = [{ id: 'cred-1', userId: 'user-1', venue: 'jupiter' }];
    const app = Fastify();
    const db = buildMockDb();
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        userId: 'user-1',
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
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        userId: 'user-1',
        venue: 'hyperliquid',
        label: 'Test Account',
        credentialId: 'cred-1',
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('succeeds when no credentialId is provided (wallet-only)', async () => {
    const app = Fastify();
    const db = buildMockDb();
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        userId: 'user-1',
        venue: 'jupiter',
        label: 'Swap Wallet',
      },
    });

    expect(res.statusCode).toBe(201);
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
    await venueAccountRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/venue-accounts',
      payload: {
        userId: 'user-1',
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
