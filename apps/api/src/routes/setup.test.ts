import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { setupRoutes } from './setup.js';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
  and: vi.fn((...args) => ({ _and: args })),
  inArray: vi.fn((_col, vals) => ({ _inArray: vals })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray) => ({ _sql: strings.join('') })),
}));

vi.mock('../crypto.js', () => ({
  getEncryptionKey: vi.fn().mockReturnValue('a'.repeat(64)),
  encryptCredential: vi.fn().mockReturnValue({
    encryptedData: 'encrypted-blob',
    encryptionMeta: { algorithm: 'aes-256-gcm', keyVersion: 1 },
  }),
}));

vi.mock('../trading-provisioner.js', () => ({
  provisionTradingTarget: vi.fn().mockResolvedValue({
    venueAccountId: 'va-new',
    connectionId: 'connection-new',
  }),
}));

let insertedValues: Record<string, unknown>[] = [];
let transactionCallCount = 0;

function buildMockDb(...selectResults: unknown[][]) {
  insertedValues = [];
  transactionCallCount = 0;
  let selectCallIdx = 0;
  const allSelectResults = selectResults.length > 0 ? selectResults : [[], []];

  const mockUpdateChain = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => allSelectResults[selectCallIdx++] ?? []),
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((v) => {
        insertedValues.push(v as Record<string, unknown>);
        return Promise.resolve();
      }),
    })),
    update: vi.fn().mockReturnValue(mockUpdateChain),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      transactionCallCount++;
      return fn({
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => allSelectResults[selectCallIdx++] ?? []),
          }),
        })),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v) => {
            insertedValues.push(v as Record<string, unknown>);
            return Promise.resolve();
          }),
        })),
        update: vi.fn().mockReturnValue({ ...mockUpdateChain }),
      });
    }),
  } as any;
}

const VALID_HL_PAYLOAD = {
  provider: 'hyperliquid',
  label: 'My HL Setup',
  secrets: {
    apiKey: 'test-api-key',
    secret: 'test-secret',
    walletAddress: '0xaAbBcCdDeEfF0011223344556677889900AaBbCc',
  },
};

const GENERATED_HL_WALLET = {
  wallet: {
    provider: 'hyperliquid' as const,
    custodyMode: 'direct' as const,
    address: '0x1111111111111111111111111111111111111111',
    network: 'Hyperliquid',
  },
  secrets: {
    apiKey: '0x1111111111111111111111111111111111111111',
    secret: `0x${'a'.repeat(64)}`,
    walletAddress: '0x1111111111111111111111111111111111111111',
  },
};

function generatedWalletDeps(walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET)) {
  return {
    venues: {
      hyperliquid: {
        baseUrl: 'https://api.hyperliquid.xyz',
        walletGeneration: { enabled: true },
      },
    },
    generateWallet: walletGenerator,
  } as any;
}

describe('POST /setup/provider-link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues = [];
    transactionCallCount = 0;
  });

  it('returns 400 for missing required fields', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { provider: 'hyperliquid' }, // missing label and secrets
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
  });

  it('returns 400 for invalid secrets (missing apiKey)', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'hyperliquid',
        label: 'test',
        secrets: { secret: 'x', walletAddress: '0xaAbBcCdDeEfF0011223344556677889900AaBbCc' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('credential.validation_error');
  });

  it('rejects unsupported provider when capability=trading before any inserts occur', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'telegram',
        label: 'Telegram setup',
        secrets: { botToken: 'token' },
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('capability.unsupported_provider');
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
    expect(provisionTradingTarget).not.toHaveBeenCalled();
  });

  it('creates credential and connection (no capability) within a transaction', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: VALID_HL_PAYLOAD,
    });

    expect(res.statusCode).toBe(201);
    expect(transactionCallCount).toBe(1);
    // Two inserts: credential + connection
    expect(insertedValues).toHaveLength(2);
    const [credInsert, connInsert] = insertedValues;
    expect(credInsert!['provider']).toBe('hyperliquid');
    expect(credInsert!['label']).toBe('My HL Setup');
    expect(connInsert!['provider']).toBe('hyperliquid');
    expect(connInsert!['credentialId']).toBe(credInsert!['id']);

    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
    expect(body['venueAccount']).toBeUndefined();
    expect(body['wallet']).toBeUndefined();
    expect((body['connection'] as Record<string, unknown>)['resolvedVenueAccountId']).toBeNull();
  });

  it('accepts custom non-trading providers such as gmail when capability is omitted', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'gmail',
        label: 'My Gmail inbox',
        secrets: { refreshToken: 'token-123' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(transactionCallCount).toBe(1);
    expect(insertedValues).toHaveLength(2);
    expect(provisionTradingTarget).not.toHaveBeenCalled();
    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
    expect((body['connection'] as Record<string, unknown>)['resolvedVenueAccountId']).toBeNull();
  });

  it('creates credential, connection, and venue account for capability=trading', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(201);
    expect(provisionTradingTarget).toHaveBeenCalledOnce();

    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
    expect(body['venueAccount']).toBeDefined();
    expect(body['venueAccount']).toMatchObject({
      id: 'va-new',
      venue: 'hyperliquid',
    });
    expect((body['connection'] as Record<string, unknown>)['resolvedVenueAccountId']).toBe('va-new');
  });

  it('creates an encrypted generated wallet setup and returns only public wallet data', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, generatedWalletDeps(walletGenerator));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'hyperliquid',
        label: 'Generated Hyperliquid Wallet',
        credentialMode: 'generated',
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(walletGenerator).toHaveBeenCalledWith({ provider: 'hyperliquid', enabled: true, network: 'Hyperliquid' });
    expect(provisionTradingTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      venueAccountRef: GENERATED_HL_WALLET.wallet.address,
    }));
    const body = res.json<Record<string, unknown>>();
    expect(body['wallet']).toEqual({
      address: GENERATED_HL_WALLET.wallet.address,
      network: 'Hyperliquid',
      fundingInstructionId: 'hyperliquid-mainnet',
      custodyMode: 'direct',
    });
    expect(JSON.stringify(body)).not.toContain(GENERATED_HL_WALLET.secrets.secret);
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });

  it('rejects client-supplied secrets in generated mode before generation or persistence', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, generatedWalletDeps(walletGenerator));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'hyperliquid',
        label: 'Generated Hyperliquid Wallet',
        credentialMode: 'generated',
        capability: 'trading',
        secrets: { secret: 'must-not-be-used' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(walletGenerator).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
  });

  it('rejects generated setup when wallet creation is disabled', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, {
      venues: { hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz', walletGeneration: { enabled: false } } },
      generateWallet: walletGenerator,
    } as any);

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'hyperliquid',
        label: 'Generated Hyperliquid Wallet',
        credentialMode: 'generated',
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('wallet_generation.disabled');
    expect(walletGenerator).not.toHaveBeenCalled();
    expect(transactionCallCount).toBe(0);
  });

  it('checks plan quota before generating a wallet', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const plansConfig = {
      defaultPlanId: 'free',
      plans: {
        free: {
          entitlements: {
            skills: {},
            agents: {},
            limits: { maxCredentials: 0, maxConnections: 1, maxVenueAccounts: 1 },
          },
          usage: {},
        },
      },
    };
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb([{ id: 'existing-credential' }]), plansConfig as any, generatedWalletDeps(walletGenerator));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'hyperliquid',
        label: 'Generated Hyperliquid Wallet',
        credentialMode: 'generated',
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(walletGenerator).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
  });

  it('propagates transaction failure and returns 500 — rollback path', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    vi.mocked(provisionTradingTarget).mockRejectedValueOnce(new Error('venue account insert failed'));

    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    // The error propagates out of db.transaction → real DB would roll back the whole
    // tx (credential + connection). In unit tests the DB mock does not perform actual
    // rollback, but we verify the endpoint does not return 201 so callers do not
    // treat a failed setup as successful.
    expect(res.statusCode).toBe(500);
    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeUndefined();
    expect(body['connection']).toBeUndefined();
  });

  it('returns 400 for jupiter with capability=trading when privateKey is missing', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'jupiter',
        label: 'My Jupiter Setup',
        secrets: {},
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('credential.validation_error');
  });

  it('creates credential and connection for jupiter with valid privateKey', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'jupiter',
        label: 'My Jupiter Setup',
        secrets: { privateKey: 'a'.repeat(64) },
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(provisionTradingTarget).toHaveBeenCalledOnce();
    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
  });

  it('persists a derived venueAccountRef for manual Jupiter trading setup', async () => {
    const { provisionTradingTarget } = await import('../trading-provisioner.js');
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    // Valid base58-encoded 64-byte Solana keypair (all 0xAB bytes — test-only)
    const testPrivateKey = '4S55ApgNWn8YKQL5J2uuxtfZrYXQZqBs8BUJTqGv3us4cAefggxxMLavbor7u47x4BfUhDRkfFBpW2rJTU6YMxux';
    const expectedAddress = 'CZ8YUVdk7znjrUmnb5n7kgySk9yRAsQDYmyCxzfSky9t';

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'jupiter',
        label: 'My Jupiter Manual Setup',
        secrets: { privateKey: testPrivateKey },
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(provisionTradingTarget).toHaveBeenCalledOnce();

    // Verify that venueAccountRef was derived from the private key
    const provisionCall = (provisionTradingTarget as ReturnType<typeof vi.fn>).mock.calls[0];
    // provisionTradingTarget(tx, opts) — second argument is opts
    const opts = provisionCall[1] as { venueAccountRef: string | null };
    expect(opts.venueAccountRef).toBe(expectedAddress);
    expect(opts.venueAccountRef).not.toBeNull();

    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
  });

  it('accepts bybit with apiSecret field name (canonicalized to secret)', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb());

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: {
        provider: 'bybit',
        label: 'My Bybit Setup',
        secrets: {
          apiKey: 'test-api-key',
          apiSecret: 'test-api-secret', // frontend template uses apiSecret; backend canonicalizes to secret
        },
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
  });

  it('enforces credential plan limit when plansConfig is provided', async () => {
    const plansConfig = {
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
              maxAgents: 1,
              maxBots: 1,
              maxConnections: 1,
              maxCredentials: 0,
              maxBindings: 1,
              maxVenueAccounts: 1,
              maxConcurrentBacktests: 1,
              liveEnabled: false,
            },
          },
          usage: {},
        },
      },
    };

    // credentialRows with 0 but limit is also 0 — exceeds limit immediately
    const db = buildMockDb([{ id: 'existing-cred' }]);
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, db, plansConfig as any);

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: VALID_HL_PAYLOAD,
    });

    expect(res.statusCode).toBe(403);
  });

  it('enforces venue account plan limit for capability=trading', async () => {
    const plansConfig = {
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
              maxAgents: 1,
              maxBots: 1,
              maxConnections: 5,
              maxCredentials: 5,
              maxBindings: 1,
              maxVenueAccounts: 1,
              maxConcurrentBacktests: 1,
              liveEnabled: false,
            },
          },
          usage: {},
        },
      },
    };

    // Return an existing venue account so that the limit (1) is hit.
    // Three select result slots: [credentials, connections, venueAccounts]
    const db = buildMockDb([], [], [{ id: 'existing-va' }]);

    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, db, plansConfig as any);

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('plan.limit_exceeded');
  });
});

// ---------------------------------------------------------------------------
// DELETE /setup/provider-link/:connectionId — cascade delete
// ---------------------------------------------------------------------------

describe('DELETE /setup/provider-link/:connectionId', () => {
  let deletedFromDb: string[] = [];
  let deletedFromTx: string[] = [];

  function buildMockDbWithDelete(...selectResults: unknown[][]) {
    deletedFromDb = [];
    deletedFromTx = [];
    let selectCallIdx = 0;
    const allSelectResults = selectResults.length > 0 ? selectResults : [[], []];

    const mockDeleteChain = (tracker: string[]) => ({
      where: vi.fn().mockResolvedValue(undefined),
    });

    // Track which "table" gets deleted by intercepting from() if possible,
    // otherwise just track that delete was called.
    const mockDeleteFn = (tracker: string[]) =>
      vi.fn().mockImplementation(() => {
        tracker.push('deleted');
        return mockDeleteChain(tracker);
      });

    const makeSelect = () =>
      vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => allSelectResults[selectCallIdx++] ?? []),
        }),
      }));

    return {
      select: makeSelect(),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: mockDeleteFn(deletedFromDb),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          execute: vi.fn().mockResolvedValue([]),
          select: makeSelect(),
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockResolvedValue(undefined),
          })),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
          delete: mockDeleteFn(deletedFromTx),
        });
      }),
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cascade-deletes connection, venue account, and credential when no blockers exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // Select results in order:
    // 0: connection lookup (resolveProviderLinkDependents)
    // 1: agent_connections active
    // 2: bots on connection
    // 3: bots on venue account
    // 4: agent_connections active (resolveBlockingAgentLabels)
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: 'cred-1', resolvedVenueAccountId: 'va-1' }],
      [],
      [],
      [],
      [],
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; deleted: Record<string, boolean> }>();
    expect(body.status).toBe('deleted');
    expect(body.deleted.connection).toBe(true);
    expect(body.deleted.venueAccount).toBe(true);
    expect(body.deleted.credential).toBe(true);
    // Transaction deletes should have been called (connection, venue account, credential)
    expect(deletedFromTx.length).toBeGreaterThanOrEqual(3);
  });

  it('cascade-deletes connection and venue account when credentialId is null', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [],
      [],
      [],
      [],
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; deleted: Record<string, boolean> }>();
    expect(body.status).toBe('deleted');
    expect(body.deleted.connection).toBe(true);
    expect(body.deleted.venueAccount).toBe(true);
    expect(body.deleted.credential).toBe(false);
  });

  it('returns 409 when active agent grants block deletion', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: 'cred-1', resolvedVenueAccountId: 'va-1' }],
      [{ id: 'ac-1', agentId: 'agent-1' }], // active grants
      [],
      [],
      [{ id: 'ac-1', agentId: 'agent-1' }], // resolveBlockingAgentLabels: grants
      [{ id: 'agent-1' }], // resolveBlockingAgentLabels: agents
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; params: Record<string, unknown> }>();
    expect(body.error).toBe('provider_link.in_use');
    expect(body.params.blockingAgentIds).toEqual(['agent-1']);
    // No deletes should have occurred
    expect(deletedFromTx.length).toBe(0);
  });

  it('returns 409 when bots on the connection block deletion', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: 'cred-1', resolvedVenueAccountId: 'va-1' }],
      [], // no active agent grants
      [{ id: 'bot-1' }], // bot referencing connection
      [],
      [], // no active agent grants
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; params: Record<string, unknown> }>();
    expect(body.error).toBe('provider_link.in_use');
    expect(body.params.blockingConnectionBotIds).toEqual(['bot-1']);
  });

  it('returns 409 when bots on the venue account block deletion', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: 'cred-1', resolvedVenueAccountId: 'va-1' }],
      [], // no active agent grants
      [], // no bots on connection
      [{ id: 'bot-2' }], // bot referencing venue account
      [], // no active agent grants
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; params: Record<string, unknown> }>();
    expect(body.error).toBe('provider_link.in_use');
    expect(body.params.blockingVenueAccountBotIds).toEqual(['bot-2']);
  });

  it('returns 400 for connection with resolvedVenueAccountId = null (not eligible)', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: null }],
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('provider_link.not_eligible');
  });

  it('returns 404 when connection does not exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [], // empty — connection not found
    ));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });
});
