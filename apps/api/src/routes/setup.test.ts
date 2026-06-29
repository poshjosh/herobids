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
    expect(body['tradingBinding']).toBeUndefined();
    expect(body['venueAccount']).toBeUndefined();
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
    expect(body['tradingBinding']).toBeUndefined();
    expect((body['connection'] as Record<string, unknown>)['resolvedVenueAccountId']).toBeNull();
  });

  it('creates credential, connection, venue account, and binding for capability=trading', async () => {
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
