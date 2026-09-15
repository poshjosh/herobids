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
  /**
   * The count returned for `count_venue_accounts` (the pre-provision plan-limit
   * check, sourced from the boundary after L3-P1b). Defaults to 0 so trading
   * links pass the venue-account limit and reach provisioning. Set at/over the
   * plan limit to exercise the pre-provision limit gate.
   */
  venueAccountCount = 0,
): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockImplementation((input: { toolName: string }) => {
    if (input.toolName === 'count_venue_accounts') {
      return Promise.resolve({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { count: venueAccountCount } } as TradertonClientResult);
    }
    return Promise.resolve(result);
  });
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

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    venues: {},
    ...overrides,
  } as any;
}

// Generated wallets are minted BEHIND the boundary (provision_venue_account
// generate mode) — herobids no longer holds a local wallet generator. This
// helper just enables wallet generation for hyperliquid so the generated path
// passes its pre-boundary capability check.
function generatedWalletDeps(extra: Record<string, unknown> = {}) {
  return {
    venues: {
      hyperliquid: {
        baseUrl: 'https://api.hyperliquid.xyz',
        walletGeneration: { enabled: true },
      },
    },
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

  it('mints the generated wallet behind the boundary (generate mode) and returns the boundary-sourced public wallet', async () => {
    // The keypair is minted behind the boundary: the provision success payload
    // carries data.wallet ({ address, network }) — never a private key. herobids
    // forwards only generate:{network} and threads the returned address to the user.
    const { client, invoke } = makeTradertonClient({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: {
        venueAccountId: 'va-new',
        venue: 'hyperliquid',
        label: 'Generated Hyperliquid Wallet',
        wallet: { address: '0xBoundaryMintedAddress', network: 'Hyperliquid' },
      },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, generatedWalletDeps({ tradertonClient: client }));

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
    // The boundary is invoked in generate mode: generate:{network}, NO secrets,
    // NO venueAccountRef (the keypair is minted behind the boundary).
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0]![0].payload;
    expect(payload).toEqual({
      venue: 'hyperliquid',
      label: 'Generated Hyperliquid Wallet',
      generate: { network: 'Hyperliquid' },
    });
    expect(payload).not.toHaveProperty('secrets');
    expect(payload).not.toHaveProperty('venueAccountRef');

    // The user-facing wallet address comes from the boundary result.
    const body = res.json<Record<string, unknown>>();
    expect(body['wallet']).toEqual({
      address: '0xBoundaryMintedAddress',
      network: 'Hyperliquid',
      fundingInstructionId: 'hyperliquid-mainnet',
      custodyMode: 'direct',
    });
  });

  it('rejects client-supplied secrets in generated mode before any boundary call or persistence', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, generatedWalletDeps({ tradertonClient: client }));

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
    expect(invoke).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
  });

  it('rejects generated setup when wallet creation is disabled — no boundary call', async () => {
    const { client, invoke } = makeTradertonClient();
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), undefined, {
      venues: { hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz', walletGeneration: { enabled: false } } },
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
    expect(invoke).not.toHaveBeenCalled();
    expect(transactionCallCount).toBe(0);
  });

  it('enforces the Phase-2 connection quota under the advisory lock (compensating the provision)', async () => {
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
    // Pre-provision venue-account check passes (boundary count defaults to 0 < 1),
    // provisioning runs, then Phase-2 re-checks the connection limit under the
    // advisory lock: the first select slot returns one existing connection row,
    // so maxConnections:1 trips, the provision is compensated, and the caller
    // sees a 403 limit. (The venue-account limit is now checked pre-provision
    // from the boundary — no longer inside the transaction.)
    await setupRoutes(app, buildMockDb([[{ id: 'existing-connection' }]]), plansConfig as any, generatedWalletDeps({ tradertonClient: client }));

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
    // count_venue_accounts (Phase 0) → provision_venue_account → deprovision (compensation).
    expect(invoke.mock.calls.map((c) => c[0].toolName)).toEqual([
      'count_venue_accounts',
      'provision_venue_account',
      'deprovision_venue_account',
    ]);
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

  it('enforces venue account plan limit for capability=trading before provisioning (boundary count)', async () => {
    // The venue-account count is sourced from the boundary (count_venue_accounts)
    // and checked pre-provision (Phase 0). With the count at the limit, the check
    // trips BEFORE any provision — so nothing is provisioned and there is nothing
    // to compensate.
    const { client, invoke } = makeTradertonClient(undefined, 1); // boundary reports 1 venue account
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

    const db = buildMockDb();

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
    // Only the pre-provision count ran — no provision, no compensation, no local write.
    expect(invoke.mock.calls.map((c) => c[0].toolName)).toEqual(['count_venue_accounts']);
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
  });

  it('fails closed with 503 when the pre-provision venue-account count is unavailable', async () => {
    // The pre-provision count fails (transport error) → precondition.not_ready →
    // 503, and provisioning never runs.
    const invoke = vi.fn().mockImplementation((input: { toolName: string }) => {
      if (input.toolName === 'count_venue_accounts') {
        return Promise.resolve({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'boundary down' } as TradertonClientResult);
      }
      return Promise.resolve({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { venueAccountId: 'va-new' } } as TradertonClientResult);
    });
    const client = { invoke } as unknown as TradertonClient;
    const plansConfig = {
      defaultPlanId: 'free',
      plans: {
        free: {
          entitlements: { skills: {}, agents: {}, limits: { maxConnections: 5, maxCredentials: 5, maxVenueAccounts: 5 } },
          usage: {},
        },
      },
    };
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDb(), plansConfig as any, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      payload: { ...VALID_HL_PAYLOAD, capability: 'trading' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('precondition.not_ready');
    expect(invoke.mock.calls.map((c) => c[0].toolName)).toEqual(['count_venue_accounts']);
    expect(insertedValues).toHaveLength(0);
    expect(transactionCallCount).toBe(0);
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
    // Select results in order (c4.9f — NO local bots reads):
    // 0: connection lookup (resolveProviderLinkDependents)
    // 1: agent_connections active (resolveProviderLinkDependents)
    // 2: agent_connections active (resolveBlockingAgentLabels)
    // The bot guard is the boundary deprovision (in_use → blocked; success → ok).
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
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
      [{ id: 'ac-1', agentId: 'agent-1' }], // active grants (resolveProviderLinkDependents)
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

  it('blocks on a boundary bot reference and preserves the empty blocking-bot wire arrays', async () => {
    // c4.9f: bots are Traderton-owned — no local bot pre-block. A bot referencing
    // the venue account surfaces via the boundary deprovision `provision.in_use`,
    // which maps to blocked. The blockingConnectionBotIds/blockingVenueAccountBotIds
    // fields are preserved in the wire shape but are empty (the boundary does not
    // return structured bot ids); the block still fires.
    const { client, invoke } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'in use by bot(s): bot-1',
      retryable: false,
      details: { errorCode: 'provision.in_use' },
    });
    const app = Fastify();
    decorateWithAuth(app);
    await setupRoutes(app, buildMockDbWithDelete(
      [{ id: 'conn-1', credentialId: null, resolvedVenueAccountId: 'va-1' }],
      [], // no active agent grants (resolveProviderLinkDependents)
      [], // no active agent grants (resolveBlockingAgentLabels)
    ), undefined, baseDeps({ tradertonClient: client }));

    const res = await app.inject({
      method: 'DELETE',
      url: '/setup/provider-link/conn-1',
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; params: Record<string, unknown> }>();
    expect(body.error).toBe('provider_link.in_use');
    // Boundary WAS the bot guard (not skipped) — the block came from deprovision.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(body.params.blockingConnectionBotIds).toEqual([]);
    expect(body.params.blockingVenueAccountBotIds).toEqual([]);
    // The local connection was NOT deleted (fail-closed).
    expect(deletedFromTx.length).toBe(0);
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
