import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { credentialRoutes } from './credentials.js';

/**
 * Route-level tests for credential lifecycle:
 * - Audit events (create/rotate/delete) without secret leaks
 * - Rotation restarts dependent running instances
 * - Delete is fail-closed (409 when credential is in use)
 */

// --- Mock wiring ---

const mockJournalAppend = vi.fn().mockResolvedValue(undefined);

vi.mock('@herobids/db', () => {
  const credentials = {
    id: 'credentials.id',
    userId: 'credentials.user_id',
    venue: 'credentials.venue',
    label: 'credentials.label',
    encryptedData: 'credentials.encrypted_data',
    encryptionMeta: 'credentials.encryption_meta',
    createdAt: 'credentials.created_at',
    updatedAt: 'credentials.updated_at',
  };
  return {
    credentials,
    PgJournal: vi.fn().mockImplementation(() => ({
      append: mockJournalAppend,
    })),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
}));

vi.mock('../crypto.js', () => ({
  encryptCredential: vi.fn().mockReturnValue({
    encryptedData: 'encrypted-blob',
    encryptionMeta: { algorithm: 'aes-256-gcm', keyVersion: 1 },
  }),
  getEncryptionKey: vi.fn().mockReturnValue('a'.repeat(64)),
}));

vi.mock('@herobids/engine', () => ({
  credentialCreatedEvent: vi.fn((payload) => ({ type: 'credential.created', payload })),
  credentialRotatedEvent: vi.fn((payload) => ({ type: 'credential.rotated', payload })),
  credentialDeletedEvent: vi.fn((payload) => ({ type: 'credential.deleted', payload })),
}));

const mockFindCredentialDependents = vi.fn().mockResolvedValue({ venueAccountIds: [], runningInstanceIds: [] });

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
  } as any;
}

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

function buildMockQueue() {
  return { add: mockQueueAdd } as any;
}

describe('credential audit events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [];
  });

  describe('POST /credentials (create)', () => {
    it('emits credential.created event with metadata only', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
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
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'k', secret: 's', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('rejects Hyperliquid credential with empty walletAddress', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'key', secret: 'sec', walletAddress: '' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('validation_error');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.walletAddress' }));
    });

    it('rejects Hyperliquid credential with malformed walletAddress', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
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
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
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
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: 'bybit',
          label: 'bybit-main',
          secrets: { apiKey: '', secret: 'valid-secret' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('validation_error');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.apiKey' }));
    });

    it('rejects Bybit credential with empty secret', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: 'bybit',
          label: 'bybit-main',
          secrets: { apiKey: 'valid-key', secret: '' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('validation_error');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.secret' }));
    });

    it('creates 1inch credential successfully', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            apiKey: 'oneinch-api-key',
          },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('rejects 1inch credential with malformed privateKey', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: 'not-a-private-key',
            apiKey: 'oneinch-api-key',
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('validation_error');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.privateKey' }));
    });

    it('rejects 1inch credential with missing apiKey', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: '1inch',
          label: 'base-wallet',
          secrets: {
            privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            apiKey: '',
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('validation_error');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.apiKey' }));
    });
  });

  describe('POST /credentials/:id/rotate', () => {
    it('emits credential.rotated event with metadata only', async () => {
      mockDbRows = [{ id: 'cred-1', venue: 'hyperliquid', userId: 'user-1' }];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

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

    it('restarts dependent running instances after rotation', async () => {
      mockDbRows = [{ id: 'cred-1', venue: 'hyperliquid', userId: 'user-1' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1', 'va-2'],
        runningInstanceIds: ['inst-1', 'inst-2'],
      });

      const app = Fastify();
      const db = buildMockDb();
      const queue = buildMockQueue();
      await credentialRoutes(app, queue, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: { secrets: { apiKey: 'new-key', secret: 'new-secret', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('rotated');
      expect(body.dependentTradingInstanceIds).toEqual(['inst-1', 'inst-2']);
      expect(body.restartedTradingInstanceIds).toEqual(['inst-1', 'inst-2']);

      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      expect(mockQueueAdd).toHaveBeenCalledWith('restart-instance', {
        command: 'restart',
        tradingInstanceId: 'inst-1',
      });
      expect(mockQueueAdd).toHaveBeenCalledWith('restart-instance', {
        command: 'restart',
        tradingInstanceId: 'inst-2',
      });
    });

    it('does not restart when no running instances depend on credential', async () => {
      mockDbRows = [{ id: 'cred-1', venue: 'hyperliquid', userId: 'user-1' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1'],
        runningInstanceIds: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      const queue = buildMockQueue();
      await credentialRoutes(app, queue, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dependentTradingInstanceIds).toEqual([]);
      expect(body.restartedTradingInstanceIds).toEqual([]);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('does not emit event when credential not found', async () => {
      mockDbRows = [];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/missing-id/rotate',
        payload: { secrets: { apiKey: 'x', secret: 'y' } },
      });

      expect(res.statusCode).toBe(404);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('rejects rotation with empty walletAddress for Hyperliquid', async () => {
      mockDbRows = [{ id: 'cred-1', venue: 'hyperliquid', userId: 'user-1' }];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '' } },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('validation_error');
      expect(body.details).toContainEqual(expect.objectContaining({ field: 'secrets.walletAddress' }));
      // Must not persist or rotate
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /credentials/:id', () => {
    it('succeeds and emits credential.deleted when no dependents', async () => {
      mockDbRows = [{ id: 'cred-2', venue: 'hyperliquid', userId: 'user-2' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: [],
        runningInstanceIds: [],
      });

      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

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
      expect(journalCall.payload.userId).toBe('user-2');
    });

    it('returns 409 when venue accounts still reference the credential', async () => {
      mockDbRows = [{ id: 'cred-3', venue: 'hyperliquid', userId: 'user-3' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1', 'va-2'],
        runningInstanceIds: ['inst-1'],
      });

      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/cred-3',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('credential_in_use');
      expect(body.credentialId).toBe('cred-3');
      expect(body.blockingVenueAccountIds).toEqual(['va-1', 'va-2']);
      expect(body.blockingTradingInstanceIds).toEqual(['inst-1']);

      // Must not delete the row
      expect(deleteWasCalled).toBe(false);
      // Must not emit audit event
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('does not emit event when credential not found', async () => {
      mockDbRows = [];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, buildMockQueue(), db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/missing-id',
      });

      expect(res.statusCode).toBe(404);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });

    it('returns 409 on FK violation during concurrent link (race condition)', async () => {
      mockDbRows = [{ id: 'cred-4', venue: 'hyperliquid', userId: 'user-4' }];
      // Pre-check passes (no dependents)
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: [],
        runningInstanceIds: [],
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
      });
      await credentialRoutes(app, buildMockQueue(), db);

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

  describe('POST /credentials/:id/rotate (restart failure)', () => {
    it('returns restartError when queue enqueue fails', async () => {
      mockDbRows = [{ id: 'cred-5', venue: 'hyperliquid', userId: 'user-5' }];
      mockFindCredentialDependents.mockResolvedValueOnce({
        venueAccountIds: ['va-1'],
        runningInstanceIds: ['inst-1', 'inst-2'],
      });

      const app = Fastify();
      const db = buildMockDb();
      const queue = buildMockQueue();
      // First queue.add succeeds, second fails
      mockQueueAdd
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Redis connection refused'));
      await credentialRoutes(app, queue, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-5/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('rotated');
      // Full dependent set is always visible
      expect(body.dependentTradingInstanceIds).toEqual(['inst-1', 'inst-2']);
      // Only the first instance was successfully queued
      expect(body.restartedTradingInstanceIds).toEqual(['inst-1']);
      // Error is surfaced to the caller
      expect(body.restartErrorCode).toBe('enqueue_failed');
      expect(body.restartError).toContain('Failed to enqueue all restart jobs');
    });

    it('returns restartError when dependent lookup itself fails', async () => {
      mockDbRows = [{ id: 'cred-6', venue: 'hyperliquid', userId: 'user-6' }];
      mockFindCredentialDependents.mockRejectedValueOnce(new Error('connection timeout'));

      const app = Fastify();
      const db = buildMockDb();
      const queue = buildMockQueue();
      await credentialRoutes(app, queue, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-6/rotate',
        payload: { secrets: { apiKey: 'k', secret: 's', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('rotated');
      // Dependent set is unknown — reported as empty
      expect(body.dependentTradingInstanceIds).toEqual([]);
      expect(body.restartedTradingInstanceIds).toEqual([]);
      // Error is surfaced so operator knows lookup failed
      expect(body.restartErrorCode).toBe('lookup_failed');
      expect(body.restartError).toContain('Failed to determine dependent instances');
    });
  });
});
