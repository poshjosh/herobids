import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { VenueAdapterFactory, CredentialResolutionError } from './venue-adapter-factory.js';
import type { VenueAdapterFactoryDeps } from './venue-adapter-factory.js';

/** Mirrors the AES-256-GCM encryption used by the API's encryptCredential(). */
function encryptForTest(data: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes (valid AES-256 key)

const STREAM_CONFIG = {
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  maxReconnectAttempts: 5,
};

/**
 * Build a minimal DB stub that returns the provided rows for venue account and credential lookups.
 */
function makeDb(rows: { venueAccount?: object | null; credential?: object | null } = {}) {
  const venueAccountRow = rows.venueAccount ?? null;
  const credentialRow = rows.credential ?? null;

  // drizzle's query builder is fluent: db.select().from(...).where(...).limit(n) → rows
  const db: any = {};
  db.select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation((n: number) => {
          // First call → venueAccounts, second call → userCredentials (or swap account)
          if ((db.select as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
            return Promise.resolve(venueAccountRow ? [venueAccountRow] : []);
          }
          return Promise.resolve(credentialRow ? [credentialRow] : []);
        }),
      }),
    }),
  });
  return db;
}

function makeJournal() {
  return { append: vi.fn().mockResolvedValue(undefined) };
}

function makeFactory(dbOverride?: any, venues?: Record<string, object>) {
  return new VenueAdapterFactory({
    db: dbOverride ?? makeDb(),
    journal: makeJournal() as any,
    venues: venues ?? {
      hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz' },
      bybit: { baseUrl: 'https://api.bybit.com' },
      jupiter: { baseUrl: 'https://quote-api.jup.ag', rpcUrl: 'https://api.mainnet-beta.solana.com' },
      '1inch': { baseUrl: 'https://api.1inch.dev/swap/v6.0/8453', rpcUrl: 'https://mainnet.base.org', chainId: 8453, apiKey: 'operator-1inch-key' },
    },
    streamConfig: STREAM_CONFIG,
  });
}

describe('VenueAdapterFactory', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['CREDENTIAL_ENCRYPTION_KEY'];
    } else {
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  describe('buildOrderbookAdapter', () => {
    it('proceeds without credentials in paper mode when no credentialId on account', async () => {
      const db = makeDb({ venueAccount: { id: 'va-1', credentialId: null } });
      const factory = makeFactory(db);

      delete process.env['CREDENTIAL_ENCRYPTION_KEY'];

      const result = await factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'paper',
      });

      expect(result.venuePort).toBeDefined();
      expect(result.credentialId).toBeUndefined();
      expect(result.credentials.apiKey).toBe('');
    });

    it('throws CredentialResolutionError when no credential and mode is shadow', async () => {
      const db = makeDb({ venueAccount: { id: 'va-1', credentialId: null } });
      const factory = makeFactory(db);

      await expect(factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'shadow',
      })).rejects.toThrow(CredentialResolutionError);
    });

    it('throws CredentialResolutionError when no credential and mode is live', async () => {
      const db = makeDb({ venueAccount: { id: 'va-1', credentialId: null } });
      const factory = makeFactory(db);

      await expect(factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      })).rejects.toThrow('has no linked credential');
    });

    it('throws CredentialResolutionError when credential record is missing (dangling ref)', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-1', credentialId: 'cred-gone' },
        credential: null, // credential was deleted
      });
      const factory = makeFactory(db);
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = 'key';

      await expect(factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      })).rejects.toThrow('Credential record not found');
    });

    it('throws CredentialResolutionError when CREDENTIAL_ENCRYPTION_KEY is not set', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-1', credentialId: 'cred-1' },
        credential: { id: 'cred-1', encryptedData: 'encrypted' },
      });
      const factory = makeFactory(db);
      delete process.env['CREDENTIAL_ENCRYPTION_KEY'];

      await expect(factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      })).rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY not set');
    });

    it('emits success audit event on successful credential decryption', async () => {
      const credData = JSON.stringify({ apiKey: 'ak', secret: 'sk', testnet: false });
      const encryptedData = encryptForTest(credData, TEST_KEY);

      const db = makeDb({
        venueAccount: { id: 'va-1', credentialId: 'cred-1' },
        credential: { id: 'cred-1', encryptedData },
      });
      const journal = makeJournal();
      const factory = new VenueAdapterFactory({
        db,
        journal: journal as any,
        venues: { hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz' } },
        streamConfig: STREAM_CONFIG,
      });

      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const result = await factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      });

      expect(result.credentialId).toBe('cred-1');
      expect(result.credentials.apiKey).toBe('ak');
      expect(result.credentials.secret).toBe('sk');

      await new Promise((r) => setTimeout(r, 5));
      expect(journal.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'credential.decrypted' }),
      );
      const auditPayload = (journal.append as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
      expect(auditPayload.outcome).toBe('success');
    });

    it('emits failure audit event and throws when decryption fails', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-1', credentialId: 'cred-1' },
        credential: { id: 'cred-1', encryptedData: 'corrupted-data' },
      });
      const journal = makeJournal();
      const factory = new VenueAdapterFactory({
        db,
        journal: journal as any,
        venues: { hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz' } },
        streamConfig: STREAM_CONFIG,
      });

      process.env['CREDENTIAL_ENCRYPTION_KEY'] = 'some-key';

      await expect(factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      })).rejects.toThrow(CredentialResolutionError);

      await new Promise((r) => setTimeout(r, 5));
      const auditCalls = (journal.append as ReturnType<typeof vi.fn>).mock.calls;
      expect(auditCalls.some(([e]: [{ payload: { outcome: string } }]) => e.payload?.outcome === 'failure')).toBe(true);
    });

    it('returns a HyperliquidAdapter for hyperliquid venue', async () => {
      const encrypted = encryptForTest(JSON.stringify({ apiKey: 'ak', secret: 'sk' }), TEST_KEY);

      const db = makeDb({
        venueAccount: { id: 'va-1', credentialId: 'cred-1' },
        credential: { id: 'cred-1', encryptedData: encrypted },
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      const result = await factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      });

      expect(result.venuePort).toBeDefined();
      // Verify it's HyperliquidAdapter by checking constructor name
      expect(result.venuePort.constructor.name).toBe('HyperliquidAdapter');
    });

    it('returns a BybitAdapter for bybit venue', async () => {
      const encrypted = encryptForTest(JSON.stringify({ apiKey: 'bk', secret: 'bs' }), TEST_KEY);

      const db = makeDb({
        venueAccount: { id: 'va-bybit', credentialId: 'cred-bybit' },
        credential: { id: 'cred-bybit', encryptedData: encrypted },
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      const result = await factory.buildOrderbookAdapter({
        venueAccountId: 'va-bybit',
        venue: 'bybit',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      });

      expect(result.venuePort.constructor.name).toBe('BybitAdapter');
    });

    it('throws for unsupported orderbook venues instead of defaulting to Hyperliquid', async () => {
      const encrypted = encryptForTest(JSON.stringify({ apiKey: 'ak', secret: 'sk' }), TEST_KEY);
      const db = makeDb({
        venueAccount: { id: 'va-1', credentialId: 'cred-1' },
        credential: { id: 'cred-1', encryptedData: encrypted },
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;
      const factory = makeFactory(db, {
        hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz' },
        driftx: { baseUrl: 'https://api.driftx.example' },
      });

      await expect(factory.buildOrderbookAdapter({
        venueAccountId: 'va-1',
        venue: 'driftx',
        actorType: 'agent',
        actorId: 'agent-1',
        executionMode: 'live',
      })).rejects.toThrow('Unsupported orderbook venue driftx');
    });
  });

  describe('buildSwapAdapter', () => {
    it('derives Jupiter wallet address from credential when venueAccountRef is null', async () => {
      // Valid base58-encoded 64-byte Solana keypair (all 0xAB bytes — test-only)
      const credData = JSON.stringify({ privateKey: '4S55ApgNWn8YKQL5J2uuxtfZrYXQZqBs8BUJTqGv3us4cAefggxxMLavbor7u47x4BfUhDRkfFBpW2rJTU6YMxux' });
      const encryptedData = encryptForTest(credData, TEST_KEY);

      const db: any = {};
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              const callCount = (db.select as ReturnType<typeof vi.fn>).mock.calls.length;
              if (callCount === 1) {
                return Promise.resolve([{ id: 'va-jup', venueAccountRef: null, credentialId: 'cred-jup' }]);
              }
              return Promise.resolve([{ id: 'cred-jup', encryptedData }]);
            }),
          }),
        }),
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      const result = await factory.buildSwapAdapter({
        venueAccountId: 'va-jup',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      });

      // Derived address from the 64-byte all-0xAB keypair (last 32 bytes = public key)
      const expectedAddress = 'CZ8YUVdk7znjrUmnb5n7kgySk9yRAsQDYmyCxzfSky9t';
      expect(result.walletAddress).toBe(expectedAddress);
      expect(result.swapVenue).toBeDefined();
      expect(result.swapVenue.constructor.name).toBe('JupiterSwapAdapter');
      expect(result.signerPresent).toBe(true);
      expect(result.credentialId).toBe('cred-jup');
    });

    it('throws when Jupiter venueAccountRef is null and no credential exists', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-jup', venueAccountRef: null, credentialId: null },
      });
      const factory = makeFactory(db);

      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-jup',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('has no venueAccountRef and no derivable wallet address');
    });

    it('returns JupiterSwapAdapter with wallet address for jupiter venue', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-jup', venueAccountRef: 'wallet-addr-123' },
      });
      const factory = makeFactory(db);

      const result = await factory.buildSwapAdapter({
        venueAccountId: 'va-jup',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      });

      expect(result.swapVenue).toBeDefined();
      expect(result.swapVenue.constructor.name).toBe('JupiterSwapAdapter');
      expect(result.walletAddress).toBe('wallet-addr-123');
    });

    it('throws for 1inch when venue account has no credential', async () => {
      const db = makeDb({ venueAccount: { id: 'va-1inch', credentialId: null } });
      const factory = makeFactory(db);

      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-1inch',
        venue: '1inch',
        swapAssets: { baseAsset: 'WETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('has no linked credential');
    });

    it('throws for 1inch when CREDENTIAL_ENCRYPTION_KEY is not set', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-1inch', credentialId: 'cred-1' },
        credential: { id: 'cred-1', encryptedData: 'encrypted' },
      });
      delete process.env['CREDENTIAL_ENCRYPTION_KEY'];
      const factory = makeFactory(db);

      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-1inch',
        venue: '1inch',
        swapAssets: { baseAsset: 'WETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY not set');
    });

    it('throws for unsupported swap venues instead of defaulting to Jupiter', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-unknown', venueAccountRef: 'wallet-1' },
      });
      const factory = makeFactory(db, {
        jupiter: { baseUrl: 'https://quote-api.jup.ag', rpcUrl: 'https://api.mainnet-beta.solana.com' },
        meteora: { baseUrl: 'https://api.meteora.example' },
      });

      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-unknown',
        venue: 'meteora',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('Unsupported swap venue meteora');
    });

    it('returns signerPresent: true for Jupiter when private key is resolved from credential', async () => {
      // Valid base58-encoded 64-byte Solana keypair (all 0xAB bytes — test-only)
      const credData = JSON.stringify({ privateKey: '4S55ApgNWn8YKQL5J2uuxtfZrYXQZqBs8BUJTqGv3us4cAefggxxMLavbor7u47x4BfUhDRkfFBpW2rJTU6YMxux' });
      const encryptedData = encryptForTest(credData, TEST_KEY);

      const db: any = {};
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              const callCount = (db.select as ReturnType<typeof vi.fn>).mock.calls.length;
              if (callCount === 1) {
                return Promise.resolve([{ id: 'va-jup', venueAccountRef: 'wallet-addr-live', credentialId: 'cred-jup' }]);
              }
              return Promise.resolve([{ id: 'cred-jup', encryptedData }]);
            }),
          }),
        }),
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      const result = await factory.buildSwapAdapter({
        venueAccountId: 'va-jup',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      });

      expect(result.signerPresent).toBe(true);
      expect(result.walletAddress).toBe('wallet-addr-live');
      expect(result.credentialId).toBe('cred-jup');
      expect(result.confirmationPoller).toBeDefined();
    });

    it('returns signerPresent: false for Jupiter when no credential is linked', async () => {
      const db = makeDb({
        venueAccount: { id: 'va-jup', venueAccountRef: 'wallet-shadow', credentialId: null },
      });
      const factory = makeFactory(db);

      const result = await factory.buildSwapAdapter({
        venueAccountId: 'va-jup',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      });

      expect(result.signerPresent).toBe(false);
      expect(result.walletAddress).toBe('wallet-shadow');
    });

    it('returns OneInchSwapAdapter with signerPresent true and confirmation poller for 1inch', async () => {
      // Valid 32-byte hex private key for EVM signer
      const credData = JSON.stringify({ privateKey: 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
      const encryptedData = encryptForTest(credData, TEST_KEY);

      const db: any = {};
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              const callCount = (db.select as ReturnType<typeof vi.fn>).mock.calls.length;
              if (callCount === 1) {
                return Promise.resolve([{ id: 'va-1inch', credentialId: 'cred-1inch' }]);
              }
              return Promise.resolve([{ id: 'cred-1inch', encryptedData }]);
            }),
          }),
        }),
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      const result = await factory.buildSwapAdapter({
        venueAccountId: 'va-1inch',
        venue: '1inch',
        swapAssets: { baseAsset: 'WETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      });

      expect(result.signerPresent).toBe(true);
      expect(result.swapVenue.constructor.name).toBe('OneInchSwapAdapter');
      expect(result.confirmationPoller).toBeDefined();
      expect(result.credentialId).toBe('cred-1inch');
    });

    it('throws for 1inch when credential decryption fails', async () => {
      const db: any = {};
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              const callCount = (db.select as ReturnType<typeof vi.fn>).mock.calls.length;
              if (callCount === 1) {
                return Promise.resolve([{ id: 'va-1inch', credentialId: 'cred-bad' }]);
              }
              return Promise.resolve([{ id: 'cred-bad', encryptedData: 'corrupted-garbage' }]);
            }),
          }),
        }),
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-1inch',
        venue: '1inch',
        swapAssets: { baseAsset: 'WETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('Failed to decrypt 1inch credentials');
    });

    it('throws for 1inch when privateKey is missing from decrypted credential', async () => {
      const credData = JSON.stringify({}); // no privateKey
      const encryptedData = encryptForTest(credData, TEST_KEY);

      const db: any = {};
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              const callCount = (db.select as ReturnType<typeof vi.fn>).mock.calls.length;
              if (callCount === 1) {
                return Promise.resolve([{ id: 'va-1inch', credentialId: 'cred-nokey' }]);
              }
              return Promise.resolve([{ id: 'cred-nokey', encryptedData }]);
            }),
          }),
        }),
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db);
      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-1inch',
        venue: '1inch',
        swapAssets: { baseAsset: 'WETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('privateKey required');
    });

    it('throws for 1inch when the operator apiKey is unavailable', async () => {
      const credData = JSON.stringify({ privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
      const encryptedData = encryptForTest(credData, TEST_KEY);

      const db: any = {};
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              const callCount = (db.select as ReturnType<typeof vi.fn>).mock.calls.length;
              if (callCount === 1) {
                return Promise.resolve([{ id: 'va-1inch', credentialId: 'cred-noapikey' }]);
              }
              return Promise.resolve([{ id: 'cred-noapikey', encryptedData }]);
            }),
          }),
        }),
      });
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;

      const factory = makeFactory(db, {
        '1inch': { baseUrl: 'https://api.1inch.dev/swap/v6.0/8453', rpcUrl: 'https://mainnet.base.org', chainId: 8453 },
      });
      await expect(factory.buildSwapAdapter({
        venueAccountId: 'va-1inch',
        venue: '1inch',
        swapAssets: { baseAsset: 'WETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-1',
      })).rejects.toThrow('Operator apiKey required');
    });
  });

  describe('CredentialResolutionError', () => {
    it('has name CredentialResolutionError', () => {
      const err = new CredentialResolutionError('test');
      expect(err.name).toBe('CredentialResolutionError');
      expect(err.message).toBe('test');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
