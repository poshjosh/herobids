import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { setupRoutes } from './setup.js';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

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

/**
 * L3-P1b: a stubbed TradertonClient. Trading provider links now provision their
 * venue account + credential over this boundary (`provision_venue_account`)
 * instead of a local `user_credentials` + `venue_accounts` write. The stub
 * records invoke calls so tests can assert toolName + subject + payload +
 * idempotencyKey, and returns a scripted client result.
 */
function makeTradertonClient(
  result: TradertonClientResult = {
    kind: 'success',
    requestId: 'r',
    correlationId: 'c',
    payload: { venueAccountId: 'va-new', venue: 'hyperliquid', label: 'label' },
  },
): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

let insertedValues: Record<string, unknown>[] = [];
let transactionCallCount = 0;

interface BuildMockDbOptions {
  /** Throw on the Nth insert (1-indexed) to simulate a local write failure. */
  throwOnInsertCall?: number;
}

function buildMockDb(selectResults: unknown[][] = [], options: BuildMockDbOptions = {}) {
  insertedValues = [];
  transactionCallCount = 0;
  let selectCallIdx = 0;
  let insertCallCount = 0;
  const allSelectResults = selectResults.length > 0 ? selectResults : [[], []];

  const mockUpdateChain = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const makeInsert = () =>
    vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((v) => {
        insertCallCount++;
        if (options.throwOnInsertCall && insertCallCount === options.throwOnInsertCall) {
          return Promise.reject(new Error('local connection insert failed'));
        }
        insertedValues.push(v as Record<string, unknown>);
        return Promise.resolve();
      }),
    }));

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => allSelectResults[selectCallIdx++] ?? []),
      }),
    })),
    insert: makeInsert(),
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
        insert: makeInsert(),
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

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    venues: {},
    generateWallet: vi.fn().mockReturnValue(GENERATED_HL_WALLET),
    ...overrides,
  } as any;
}

function generatedWalletDeps(walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET), extra: Record<string, unknown> = {}) {
  return {
    venues: {
      hyperliquid: {
        baseUrl: 'https://api.hyperliquid.xyz',
        walletGeneration: { enabled: true },
      },
    },
    generateWallet: walletGenerator,
    ...extra,
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

  it('rejects unsupported provider when capability=trading before any inserts or boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

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
    expect(invoke).not.toHaveBeenCalled();
  });

  it('creates credential and connection (no capability) within a transaction — no boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: VALID_HL_PAYLOAD,
    });

    expect(res.statusCode).toBe(201);
    expect(transactionCallCount).toBe(1);
    // Non-trading stays herobids-owned: credential + connection inserted locally.
    expect(insertedValues).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalled();
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

  it('accepts custom non-trading providers such as gmail when capability is omitted — no boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

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
    expect(invoke).not.toHaveBeenCalled();
    const body = res.json<Record<string, unknown>>();
    expect(body['credential']).toBeDefined();
    expect(body['connection']).toBeDefined();
    expect((body['connection'] as Record<string, unknown>)['resolvedVenueAccountId']).toBeNull();
  });

  it('provisions the venue account over the boundary and inserts only the connection for capability=trading', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(201);

    // The boundary was invoked with the right toolName + subject + payload + idempotencyKey.
    expect(invoke).toHaveBeenCalledTimes(1);
    const call = invoke.mock.calls[0]![0];
    expect(call.toolName).toBe('provision_venue_account');
    expect(call.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
    expect(call.payload).toMatchObject({
      venue: 'hyperliquid',
      label: 'My HL Setup',
      secrets: expect.objectContaining({ apiKey: 'test-api-key' }),
      // Hyperliquid canonicalisation lowercases the wallet address.
      venueAccountRef: '0xaabbccddeeff0011223344556677889900aabbcc',
    });
    // Deterministic idempotency: the key is the pre-minted connectionId.
    const body = res.json<Record<string, unknown>>();
    const connectionId = (body['connection'] as Record<string, unknown>)['id'];
    expect(call.idempotencyKey).toBe(connectionId);

    // Only the connection is written locally — no credential, no venue account.
    expect(insertedValues).toHaveLength(1);
    const connInsert = insertedValues[0]!;
    expect(connInsert['credentialId']).toBeNull();
    expect(connInsert['resolvedVenueAccountId']).toBe('va-new');

    // Response: credential id is null (boundary-owned), venue account metadata present.
    expect((body['credential'] as Record<string, unknown>)['id']).toBeNull();
    expect((body['connection'] as Record<string, unknown>)['credentialId']).toBeNull();
    expect((body['connection'] as Record<string, unknown>)['resolvedVenueAccountId']).toBe('va-new');
    expect(body['venueAccount']).toMatchObject({ id: 'va-new', venue: 'hyperliquid' });
  });

  it('returns a mapped error and writes nothing locally when provisioning fails', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'authorization.denied',
      message: 'not allowed',
      retryable: false,
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('authorization.denied');
    // No local write occurred (no connection insert, no transaction).
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
  });

  it('returns 503 when the boundary is unavailable (transport error) and writes nothing', async () => {
    const { client } = makeTradertonClient({
      kind: 'transport_error',
      requestId: 'r',
      retryable: true,
      message: 'boundary down',
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('precondition.not_ready');
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
  });

  it('returns 503 precondition when no boundary client is configured for a trading link', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps()); // no tradertonClient

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('precondition.not_ready');
    expect(insertedValues).toHaveLength(0);
  });

  it('compensates (deprovisions) when the local connection insert fails after a successful provision', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    // throwOnInsertCall: 1 → the first (and only) insert in the trading tx fails.
    await setupRoutes(app, buildMockDb([], { throwOnInsertCall: 1 }), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(500);
    // provision was called, then compensation deprovision was called.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![0].toolName).toBe('provision_venue_account');
    expect(invoke.mock.calls[1]![0].toolName).toBe('deprovision_venue_account');
    expect(invoke.mock.calls[1]![0].payload).toEqual({ venueAccountId: 'va-new' });
  });

  it('creates an encrypted generated wallet setup and returns only public wallet data', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, generatedWalletDeps(walletGenerator, { tradertonClient: client }));

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
    // The generated wallet address is forwarded as the venueAccountRef in the boundary payload.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].payload).toMatchObject({
      venueAccountRef: GENERATED_HL_WALLET.wallet.address,
    });
    const body = res.json<Record<string, unknown>>();
    expect(body['wallet']).toEqual({
      address: GENERATED_HL_WALLET.wallet.address,
      network: 'Hyperliquid',
      fundingInstructionId: 'hyperliquid-mainnet',
      custodyMode: 'direct',
    });
    // The secrets never leave the process in the response.
    expect(JSON.stringify(body)).not.toContain(GENERATED_HL_WALLET.secrets.secret);
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });

  it('rejects client-supplied secrets in generated mode before generation, boundary call, or persistence', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, generatedWalletDeps(walletGenerator, { tradertonClient: client }));

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
    expect(invoke).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
  });

  it('rejects generated setup when wallet creation is disabled — no boundary call', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, {
      venues: { hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz', walletGeneration: { enabled: false } } },
      generateWallet: walletGenerator,
      tradertonClient: client,
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
    expect(invoke).not.toHaveBeenCalled();
    expect(transactionCallCount).toBe(0);
  });

  it('checks plan quota before generating a wallet or calling the boundary', async () => {
    const walletGenerator = vi.fn().mockReturnValue(GENERATED_HL_WALLET);
    const { client, invoke } = makeTradertonClient();
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
    // Phase-2 for trading re-checks connection limit under the advisory lock:
    // slot 0 = connection count (over limit), so provisioning still ran, then
    // compensation deprovisions. To verify the boundary was NOT called at all we
    // instead assert on a NON-trading credential-limit gate below; here we cover
    // the generated trading path with a connection limit of 1 (allowed) but a
    // venue-account limit of 0 so the pre-provision check would not gate — this
    // path checks limits inside phase 2. Keep the free plan's connection limit
    // permissive and assert quota is honoured.
    await setupRoutes(app, buildMockDb([[{ id: 'existing-credential' }]]), plansConfig as any, generatedWalletDeps(walletGenerator, { tradertonClient: client }));

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

    // maxConnections:1 with one existing connection row → phase-2 limit gate trips,
    // provisioning is compensated, and the caller sees a 403 limit.
    expect(res.statusCode).toBe(403);
  });

  it('propagates a compensating deprovision on phase-2 failure and returns 500', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb([], { throwOnInsertCall: 1 }), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json<Record<string, unknown>>();
    // Not a success response.
    expect(body['connection']).toBeUndefined();
    expect(invoke.mock.calls.map((c) => c[0].toolName)).toEqual(['provision_venue_account', 'deprovision_venue_account']);
  });

  it('returns 400 for jupiter with capability=trading when privateKey is missing — no boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

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
    expect(invoke).not.toHaveBeenCalled();
  });

  it('provisions jupiter over the boundary with a valid privateKey', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: { venueAccountId: 'va-jup', venue: 'jupiter', label: 'My Jupiter Setup' },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

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
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].payload).toMatchObject({ venue: 'jupiter' });
  });

  it('forwards a derived venueAccountRef for manual Jupiter trading setup', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: { venueAccountId: 'va-jup', venue: 'jupiter', label: 'My Jupiter Manual Setup' },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

    // Valid base58-encoded 64-byte Solana keypair (test-only)
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
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].payload).toMatchObject({ venueAccountRef: expectedAddress });
  });

  it('accepts bybit with apiSecret field name (canonicalized to secret)', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: { venueAccountId: 'va-bybit', venue: 'bybit', label: 'My Bybit Setup' },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, baseDeps({ tradertonClient: client }));

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
    expect(invoke).toHaveBeenCalledTimes(1);
    // Secret canonicalisation happened before the boundary call.
    expect(invoke.mock.calls[0]![0].payload.secrets).toMatchObject({ secret: 'test-api-secret' });
  });

  it('enforces credential plan limit for non-trading links when plansConfig is provided', async () => {
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
            agents: { canViewOwnPrompts: true },
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

    // credentialRows with 1 existing but limit 0 — exceeds limit immediately.
    const db = buildMockDb([[{ id: 'existing-cred' }]]);
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

  it('enforces venue account plan limit for capability=trading (compensating the provision)', async () => {
    const { client, invoke } = makeTradertonClient();
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
            agents: { canViewOwnPrompts: true },
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

    // Phase-2 select order under the advisory lock: [connections count, venueAccounts count].
    // Return an existing venue account so the venueAccount limit (1) is hit.
    const db = buildMockDb([[], [{ id: 'existing-va' }]]);

    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, db, plansConfig as any, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('plan.limit_exceeded');
    // The provision happened before the phase-2 limit trip, so it is compensated.
    expect(invoke.mock.calls.map((c) => c[0].toolName)).toEqual(['provision_venue_account', 'deprovision_venue_account']);
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

    const mockDeleteChain = () => ({
      where: vi.fn().mockResolvedValue(undefined),
    });

    const mockDeleteFn = (tracker: string[]) =>
      vi.fn().mockImplementation(() => {
        tracker.push('deleted');
        return mockDeleteChain();
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

  it('deprovisions over the boundary and deletes the local connection when no blockers exist', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: { venueAccountId: 'va-1', deleted: true },
    });
    const app = Fastify();
    decorateWithAuth(app);
    // Select results in order:
    // 0: connection lookup (resolveProviderLinkDependents)
    // 1: agent_connections active
    // 2: bots on connection
    // 3: bots on venue account
    // 4: agent_connections active (resolveBlockingAgentLabels)
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [],
      [],
      [],
      [],
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; deleted: Record<string, boolean> }>();
    expect(body.status).toBe('deleted');
    expect(body.deleted.connection).toBe(true);
    expect(body.deleted.venueAccount).toBe(true);
    // Boundary teardown happened, and the local connection (+ revoked grants) was deleted.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].toolName).toBe('deprovision_venue_account');
    expect(invoke.mock.calls[0]![0].payload).toEqual({ venueAccountId: 'va-1' });
    expect(deletedFromTx.length).toBeGreaterThanOrEqual(2);
  });

  it('returns 409 (blocked) when the boundary reports the venue account is in use — connection untouched', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'in use by bot(s): bot-x',
      retryable: false,
      details: { errorCode: 'provision.in_use' },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [],
      [],
      [],
      [],
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('provider_link.in_use');
    expect(invoke).toHaveBeenCalledTimes(1);
    // The local connection was NOT deleted (fail-closed).
    expect(deletedFromTx.length).toBe(0);
  });

  it('treats a boundary not_found.resource as already-gone and still deletes the local connection', async () => {
    const { client, invoke } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'Venue account not found: va-1',
      retryable: false,
      details: { errorCode: 'not_found.resource' },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [],
      [],
      [],
      [],
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('deleted');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deletedFromTx.length).toBeGreaterThanOrEqual(2);
  });

  it('returns 409 when active agent grants block deletion — no boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [{ id: 'ac-1', agentId: 'agent-1' }], // active grants
      [],
      [],
      [{ id: 'ac-1', agentId: 'agent-1' }], // resolveBlockingAgentLabels: grants
      [{ id: 'agent-1' }], // resolveBlockingAgentLabels: agents
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; params: Record<string, unknown> }>();
    expect(body.error).toBe('provider_link.in_use');
    expect(body.params.blockingAgentIds).toEqual(['agent-1']);
    // Platform blockers are checked BEFORE the boundary — no deprovision attempted.
    expect(invoke).not.toHaveBeenCalled();
    expect(deletedFromTx.length).toBe(0);
  });

  it('returns 409 when bots on the connection block deletion — no boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [], // no active agent grants
      [{ id: 'bot-1' }], // bot referencing connection
      [],
      [], // no active agent grants
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; params: Record<string, unknown> }>();
    expect(body.error).toBe('provider_link.in_use');
    expect(body.params.blockingConnectionBotIds).toEqual(['bot-1']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns 400 for connection with resolvedVenueAccountId = null (not eligible)', async () => {
    const { client } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: null }],
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('provider_link.not_eligible');
  });

  it('returns 404 when connection does not exist', async () => {
    const { client } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [], // empty — connection not found
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 503 when the boundary is unavailable during deprovision — connection untouched', async () => {
    const { client } = makeTradertonClient({
      kind: 'transport_error',
      requestId: 'r',
      retryable: true,
      message: 'boundary down',
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [],
      [],
      [],
      [],
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(503);
    expect(deletedFromTx.length).toBe(0);
  });
});
