import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';
import { credentialRoutes } from './credentials.js';
import { encryptCredential } from '../crypto.js';

/**
 * Route-level tests for credential lifecycle:
 * - Audit events (create/rotate/delete) without secret leaks
 * - Rotation surfaces dependent running instances (informational) but does NOT
 *   restart them — bot lifecycle is Traderton-owned (L3d-1; 004-l3d-plan.md §F)
 * - Delete is fail-closed (409 when credential is in use)
 */

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

// --- Mock wiring ---

const mockJournalAppend = vi.fn().mockResolvedValue(undefined);

vi.mock('@herobids/db', () => {
  const userCredentials = {
    id: 'credentials.id',
    userId: 'credentials.user_id',
    provider: 'credentials.provider',
    label: 'credentials.label',
    encryptedData: 'credentials.encrypted_data',
    encryptionMeta: 'credentials.encryption_meta',
    createdAt: 'credentials.created_at',
    updatedAt: 'credentials.updated_at',
  };
  const users = {
    id: 'users.id',
    planId: 'users.plan_id',
  };
  return {
    userCredentials,
    users,
    PgJournal: vi.fn().mockImplementation(() => ({
      append: mockJournalAppend,
    })),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
  and: vi.fn((...args) => ({ _and: args })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray) => ({ _sql: strings.join('') })),
}));

vi.mock('../crypto.js', () => ({
  encryptCredential: vi.fn().mockReturnValue({
    encryptedData: 'encrypted-blob',
    encryptionMeta: { algorithm: 'aes-256-gcm', keyVersion: 1 },
  }),
  getEncryptionKey: vi.fn().mockReturnValue('a'.repeat(64)),
}));

// L3d-1: the credential audit-event builders were relocated to @herobids/domain
// (from @herobids/engine). They are pure functions with no side effects, so the
// real implementations are used here — the route emits real audit entries that
// these tests assert against. No module mock is needed.

const mockFindCredentialDependents = vi.fn().mockResolvedValue({ venueAccountIds: [], runningInstanceIds: [], activeConnectionIds: [], blockingAgentCredentials: [] });

vi.mock('../credential-dependents.js', () => ({
  findCredentialDependents: (...args: unknown[]) => mockFindCredentialDependents(...args),
}));

let mockDbRows: Record<string, unknown>[] = [];
let lastInsertValues: Record<string, unknown> | undefined;
let lastUpdateSet: Record<string, unknown> | undefined;
let deleteWasCalled = false;

function buildMockDb() {
  lastInsertValues = undefined;
  lastUpdateSet = undefined;
  deleteWasCalled = false;

  const tx = {
    execute: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v) => { lastInsertValues = v; return Promise.resolve(); }),
    }),
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(mockDbRows),
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s) => {
        lastUpdateSet = s;
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => { deleteWasCalled = true; return Promise.resolve(); }),
    }),
  };

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v) => { lastInsertValues = v; return Promise.resolve(); }),
    }),
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(mockDbRows),
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s) => {
        lastUpdateSet = s;
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => { deleteWasCalled = true; return Promise.resolve(); }),
    }),
    transaction: vi.fn().mockImplementation(async (fn: (innerTx: typeof tx) => Promise<unknown>) => fn(tx)),
  } as any;
}

// L3d-1: the rotate route no longer enqueues restarts, but we keep a queue-add
// spy to assert it is NEVER called (no in-process lifecycle enqueue on rotation).
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

function makePlansConfig(): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: {
            canViewOwnPrompts: true,
          },
          limits: {
            maxAgents: 5,
            maxBots: 5,
            maxConnections: 5,
            maxCredentials: 1,
            maxBindings: 5,
            maxVenueAccounts: 5,
            maxConcurrentBacktests: 3,
            liveEnabled: false,
          },
        },
        usage: {},
      },
    },
  };
}

describe('credential audit events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [];
  });

  describe('POST /credentials (create)', () => {
    it('returns 403 when credential limit is reached', async () => {
      mockDbRows = [{ id: 'cred-existing' }];
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'secret-key', secret: 'secret-value', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('plan.limit_exceeded');
      expect(lastInsertValues).toBeUndefined();
    });

    it('emits credential.created event with metadata only', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'secret-key', secret: 'secret-value', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
      });

      expect(res.statusCode).toBe(201);
      expect(mockJournalAppend).toHaveBeenCalledTimes(1);

      const journalCall = mockJournalAppend.mock.calls[0]![0];
      expect(journalCall.type).toBe('credential.created');
      expect(journalCall.payload.venue).toBe('hyperliquid');
      expect(journalCall.payload.userId).toBe('user-1');
      expect(journalCall.payload.label).toBe('prod-key');
      expect(journalCall.payload.credentialId).toBeDefined();

      // Never persists secrets in journal
      expect(JSON.stringify(journalCall)).not.toContain('secret-key');
      expect(JSON.stringify(journalCall)).not.toContain('secret-value');
    });

    it('returns success even when journal append fails (best-effort audit)', async () => {
      mockJournalAppend.mockRejectedValueOnce(new Error('journal unavailable'));
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'k', secret: 's', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('normalizes aliased Hyperliquid secret names before validation and storage', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: {
            'api-key': 'secret-key',
            secret: 'secret-value',
            'account-address': '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      });

      expect(res.statusCode).toBe(201);
      expect(encryptCredential).toHaveBeenCalledWith(
        JSON.stringify({
          apiKey: 'secret-key',
          secret: 'secret-value',
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
        expect.any(String),
      );
    });

    it('rejects Hyperliquid credential with empty walletAddress', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'key', secret: 'sec', walletAddress: '' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential.validation_error.required');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.walletAddress' }));
      expect(body.params).toEqual({ field: 'walletAddress', venue: 'hyperliquid' });
    });

    it('rejects Hyperliquid credential with malformed walletAddress', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'key', secret: 'sec', walletAddress: 'not-an-address' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.walletAddress' }));
    });

    it('creates Bybit credential successfully', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'bybit',
          label: 'bybit-main',
          secrets: { apiKey: 'bybit-key-123', secret: 'bybit-secret-456' },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('rejects Bybit credential with empty apiKey', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'bybit',
          label: 'bybit-main',
          secrets: { apiKey: '', secret: 'valid-secret' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential.validation_error.required');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.apiKey' }));
    });

    it('rejects Bybit credential with empty secret', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: 'bybit',
          label: 'bybit-main',
          secrets: { apiKey: 'valid-key', secret: '' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential.validation_error.required');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.secret' }));
    });

    it('creates 1inch credential successfully', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('rejects 1inch credential with malformed privateKey', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: 'not-a-private-key',
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential.validation_error.invalid_private_key');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.privateKey' }));
    });

    it('creates 1inch credential without an operator apiKey', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('discards a legacy user-supplied 1inch apiKey before encryption', async () => {
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            apiKey: 'legacy-user-api-key',
          },
        },
      });

      expect(res.statusCode).toBe(201);
      expect(encryptCredential).toHaveBeenCalledWith(
        JSON.stringify({ privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' }),
        expect.any(String),
      );
    });
  });

  describe('POST /credentials/:id/rotate', () => {
    it('emits credential.rotated event with metadata only', async () => {
      mockDbRows = [{ id: 'cred-2', provider: 'hyperliquid', userId: 'user-1' }];
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: {
          secrets: { apiKey: 'secret-key', secret: 'secret-value', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockJournalAppend).toHaveBeenCalledTimes(1);

      const journalCall = mockJournalAppend.mock.calls[0]![0];
      expect(journalCall.type).toBe('credential.rotated');
      expect(journalCall.payload.credentialId).toBe('cred-1');
      expect(journalCall.payload.venue).toBe('hyperliquid');

      // Never persists secrets in journal
      expect(JSON.stringify(journalCall)).not.toContain('new-secret-key');
      expect(JSON.stringify(journalCall)).not.toContain('new-secret-value');
    });

    // L3d-1: herobids no longer force-restarts running bots on rotation
    // (Traderton owns bot lifecycle; the in-process lifecycle queue is being
    // removed and no boundary restart surface exists). The route still surfaces
    // the dependent instance IDs (informational) but never enqueues a restart.
    it('reports dependent running instances but does NOT enqueue any restart', async () => {
      mockDbRows = [{ id: 'cred-1', provider: 'hyperliquid', userId: 'user-1' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1', 'va-2'],
        runningInstanceIds: ['inst-1', 'inst-2'],
        activeConnectionIds: [],
        blockingAgentCredentials: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: { secrets: { apiKey: 'new-key', secret: 'new-secret', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('rotated');
      expect(body.dependentBotIds).toEqual(['inst-1', 'inst-2']);
      // Restart is no longer driven from herobids — no restartedBotIds field.
      expect(body.restartedBotIds).toBeUndefined();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('reports an empty dependent set when no running instances depend on the credential', async () => {
      mockDbRows = [{ id: 'cred-1', provider: 'hyperliquid', userId: 'user-1' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1'],
        runningInstanceIds: [],
        activeConnectionIds: [],
        blockingAgentCredentials: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dependentBotIds).toEqual([]);
      expect(body.restartedBotIds).toBeUndefined();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('does not emit event when credential not found', async () => {
      mockDbRows = [];
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/missing-id/rotate',
        payload: { secrets: { apiKey: 'x', secret: 'y' } },
      });

      expect(res.statusCode).toBe(404);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('rejects rotation with empty walletAddress for Hyperliquid', async () => {
      mockDbRows = [{ id: 'cred-1', provider: 'hyperliquid', userId: 'user-1' }];
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '' } },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential.validation_error.required');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.walletAddress' }));
      // Must not persist or rotate
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('normalizes aliased Hyperliquid secret names during rotation', async () => {
      mockDbRows = [{ id: 'cred-1', provider: 'hyperliquid', userId: 'user-1' }];
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: {
          secrets: {
            'api-key': 'k',
            secret: 's',
            'account-address': '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(encryptCredential).toHaveBeenCalledWith(
        JSON.stringify({
          apiKey: 'k',
          secret: 's',
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
        expect.any(String),
      );
    });
  });

  describe('DELETE /credentials/:id', () => {
    it('succeeds and emits credential.deleted when no dependents', async () => {
      mockDbRows = [{ id: 'cred-2', provider: 'hyperliquid', userId: TEST_USER_ID }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: [],
        runningInstanceIds: [],
        activeConnectionIds: [],
        blockingAgentCredentials: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/cred-2',
      });

      expect(res.statusCode).toBe(200);
      expect(deleteWasCalled).toBe(true);
      expect(mockJournalAppend).toHaveBeenCalledTimes(1);

      const journalCall = mockJournalAppend.mock.calls[0]![0];
      expect(journalCall.type).toBe('credential.deleted');
      expect(journalCall.payload.credentialId).toBe('cred-2');
      expect(journalCall.payload.venue).toBe('hyperliquid');
      expect(journalCall.payload.userId).toBe(TEST_USER_ID);
    });

    it('returns 409 when venue accounts still reference the credential', async () => {
      mockDbRows = [{ id: 'cred-3', provider: 'hyperliquid', userId: TEST_USER_ID }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1', 'va-2'],
        runningInstanceIds: ['inst-1'],
        activeConnectionIds: [],
        blockingAgentCredentials: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/cred-3',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential_in_use');
      expect(body.credentialId).toBe('cred-3');
      expect(body.blockingVenueAccountIds).toEqual(['va-1', 'va-2']);
      expect(body.blockingBotIds).toEqual(['inst-1']);

      // Must not delete the row
      expect(deleteWasCalled).toBe(false);
      // Must not emit audit event
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('returns 409 when agent credentials still reference the credential', async () => {
      mockDbRows = [{ id: 'cred-ac', provider: 'hyperliquid', userId: TEST_USER_ID }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: [],
        runningInstanceIds: [],
        activeConnectionIds: [],
        blockingAgentCredentials: [{ id: 'ac-1', label: 'My Trading Agent' }, { id: 'ac-2', label: null }],
      });

      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/cred-ac',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential_in_use');
      expect(body.credentialId).toBe('cred-ac');
      expect(body.blockingAgentCredentials).toEqual([
        { id: 'ac-1', label: 'My Trading Agent' },
        { id: 'ac-2', label: null },
      ]);

      // Must not delete the row
      expect(deleteWasCalled).toBe(false);
      // Must not emit audit event
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('does not emit event when credential not found', async () => {
      mockDbRows = [];
      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/missing-id',
      });

      expect(res.statusCode).toBe(404);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('returns 409 on FK violation during concurrent link (race condition)', async () => {
      mockDbRows = [{ id: 'cred-4', provider: 'hyperliquid', userId: 'user-4' }];
      // Pre-check passes (no dependents)
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: [],
        runningInstanceIds: [],
        activeConnectionIds: [],
        blockingAgentCredentials: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      // Override delete to throw FK violation (concurrent link raced in)
      const fkError = new Error('update or delete on table "credentials" violates foreign key constraint') as Error & { code: string };
      fkError.code = '23503';
      db.delete = vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(fkError),
      });
      // Second call to findCredentialDependents (inside catch) returns the new link
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-raced'],
        runningInstanceIds: [],
        activeConnectionIds: [],
        blockingAgentCredentials: [],
      });
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/cred-4',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential_in_use');
      expect(body.blockingVenueAccountIds).toEqual(['va-raced']);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });
  });

  describe('POST /credentials/:id/rotate (dependent lookup failure)', () => {
    // L3d-1: the enqueue path is gone, so there is no restart-enqueue failure to
    // surface. A dependent-lookup failure is still reported (non-fatal) via
    // dependentLookupError so the rotation still succeeds.
    it('surfaces dependentLookupError when the dependent lookup fails but still succeeds', async () => {
      mockDbRows = [{ id: 'cred-6', provider: 'hyperliquid', userId: 'user-6' }];
      mockFindCredentialDependents.mockRejectedValueOnce(new Error('connection timeout'));

      const app = Fastify();
      const db = buildMockDb();
      decorateWithAuth(app);
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-6/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('rotated');
      // Dependent set is unknown — reported as empty.
      expect(body.dependentBotIds).toEqual([]);
      // No restart is attempted, so no restartError / restartedBotIds fields.
      expect(body.restartedBotIds).toBeUndefined();
      expect(body.restartErrorCode).toBeUndefined();
      // The lookup failure is surfaced so the operator knows the set is unknown.
      expect(body.dependentLookupError).toContain('Failed to determine dependent instances');
      // Rotation itself succeeded — the audit event was still emitted.
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });
});
