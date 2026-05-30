import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { credentialRoutes } from './credentials.js';

/**
 * Route-level tests for credential audit events.
 * Verifies that create/rotate/delete operations emit journal events
 * without leaking secrets.
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

describe('credential audit events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [];
  });

  describe('POST /credentials (create)', () => {
    it('emits credential.created event with metadata only', async () => {
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'secret-key', secret: 'secret-value' },
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
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials',
        payload: {
          userId: 'user-1',
          venue: 'hyperliquid',
          label: 'prod-key',
          secrets: { apiKey: 'k', secret: 's' },
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /credentials/:id/rotate', () => {
    it('emits credential.rotated event with metadata only', async () => {
      mockDbRows = [{ id: 'cred-1', venue: 'hyperliquid', userId: 'user-1' }];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/cred-1/rotate',
        payload: {
          secrets: { apiKey: 'new-secret-key', secret: 'new-secret-value' },
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

    it('does not emit event when credential not found', async () => {
      mockDbRows = [];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/credentials/missing-id/rotate',
        payload: { secrets: { apiKey: 'x', secret: 'y' } },
      });

      expect(res.statusCode).toBe(404);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /credentials/:id', () => {
    it('emits credential.deleted event with metadata only', async () => {
      mockDbRows = [{ id: 'cred-2', venue: 'hyperliquid', userId: 'user-2' }];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/cred-2',
      });

      expect(res.statusCode).toBe(200);
      expect(mockJournalAppend).toHaveBeenCalledTimes(1);

      const journalCall = mockJournalAppend.mock.calls[0]![0];
      expect(journalCall.type).toBe('credential.deleted');
      expect(journalCall.payload.credentialId).toBe('cred-2');
      expect(journalCall.payload.venue).toBe('hyperliquid');
      expect(journalCall.payload.userId).toBe('user-2');
    });

    it('does not emit event when credential not found', async () => {
      mockDbRows = [];
      const app = Fastify();
      const db = buildMockDb();
      await credentialRoutes(app, db);

      const res = await app.inject({
        method: 'DELETE',
        url: '/credentials/missing-id',
      });

      expect(res.statusCode).toBe(404);
      expect(mockJournalAppend).not.toHaveBeenCalled();
    });
  });
});
