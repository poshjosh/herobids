import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { connectionRoutes as registerConnectionRoutesImpl } from './connections.js';
import type { PlansConfig } from '@herobids/domain';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  loadActiveTradingProfileConnections: vi.fn().mockResolvedValue([]),
}));

import {
  loadActiveTradingProfileConnections,
} from '../agents/trading-profile-reconciliation-adapter.js';
import { planTradingProfileReconciliation, type TradingProfileConnection, type TypedTradingProfile } from '../agents/trading-profile-reconciliation.js';
import type { TradingProfilePlannerInput } from '../agents/trading-profile-reconciliation-saga.js';

const TEST_USER_ID = 'user-1';
const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4000,
};

async function connectionRoutes(
  app: ReturnType<typeof Fastify>,
  db: unknown,
  redisClient?: unknown,
  plansConfig?: PlansConfig,
  tradertonClient?: TradertonClient,
  profileReconciliationSaga = buildStagedSaga(db),
) {
  await registerConnectionRoutesImpl(app, db as never, TEST_RUNTIME_BUDGETS, redisClient as never, plansConfig, tradertonClient, profileReconciliationSaga as never);
}

function buildStagedSaga(db: unknown, onPrepared?: (input: TradingProfilePlannerInput) => void) {
  return {
    readCurrentProfiles: vi.fn(async (_ownerId: string, actorId: string, connections: TradingProfileConnection[]) => new Map(
      connections.flatMap((connection) => connection.venueAccountId === null ? [] : [[connection.venueAccountId, {
        actorId,
        venueAccountId: connection.venueAccountId,
        capital: '1000',
        riskPosture: null,
        executionDefaults: { mode: 'paper' },
      } satisfies TypedTradingProfile] as const]),
    )),
    executeStaged: vi.fn(async (input: {
      preparePlannerInput: () => Promise<TradingProfilePlannerInput>;
      commitLocal: (tx: unknown, markLocalCommitted: () => Promise<void>) => Promise<unknown>;
    }) => {
      const plannerInput = await input.preparePlannerInput();
      onPrepared?.(plannerInput);
      return input.commitLocal(db, vi.fn().mockResolvedValue(undefined));
    }),
    finalize: vi.fn().mockResolvedValue(undefined),
    compensate: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a stub Traderton read-boundary client. `count_bots_by_venue_account`
 * returns `byVenueAccount` (keyed by account id → bot ids); `get_venue_account`
 * returns `venueAccountRef`. Both are wrapped in the client `success` shape the
 * readBoundary helper expects. Unmapped account ids resolve to empty/null.
 */
function makeBoundaryClient(opts: {
  botsByAccount?: Record<string, string[]>;
  refByAccount?: Record<string, string | null>;
} = {}): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const botsByAccount = opts.botsByAccount ?? {};
  const refByAccount = opts.refByAccount ?? {};
  const invoke = vi.fn().mockImplementation((input: { toolName: string; payload: Record<string, unknown> }) => {
    if (input.toolName === 'count_bots_by_venue_account') {
      const ids = (input.payload['venueAccountIds'] as string[]) ?? [];
      const byVenueAccount: Record<string, string[]> = {};
      for (const id of ids) byVenueAccount[id] = botsByAccount[id] ?? [];
      return Promise.resolve({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { ok: true, byVenueAccount } } as TradertonClientResult);
    }
    if (input.toolName === 'get_venue_account') {
      const id = input.payload['venueAccountId'] as string;
      return Promise.resolve({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { ok: true, venueAccountId: id, venueAccountRef: refByAccount[id] ?? null, venue: 'hyperliquid', label: 'label' } } as TradertonClientResult);
    }
    return Promise.resolve({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'unexpected tool' } as TradertonClientResult);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/** A boundary client whose invoke always transport-errors (boundary down). */
function makeDownBoundaryClient(): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'boundary down' } as TradertonClientResult);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

function makePlansConfig(maxConnections = 5): PlansConfig {
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
            maxConnections,
            maxCredentials: 5,
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

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

vi.mock('drizzle-orm', () => {
  const sqlMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sqlObj = { _sql: strings.join('') };
    return new Proxy(sqlObj, {
      get(target, prop) {
        if (prop === 'mapWith') return () => sqlObj;
        return (target as Record<string, unknown>)[prop as string];
      },
    });
  });
  return {
    eq: vi.fn((_col, val) => ({ _eq: val })),
    inArray: vi.fn((_col, values) => ({ _in: values })),
    and: vi.fn((...args) => ({ _and: args })),
    sql: sqlMock,
  };
});

const CONNECTION_ROW = {
  id: 'conn-1',
  userId: TEST_USER_ID,
  credentialId: null,
  provider: 'hyperliquid',
  label: 'My Hyperliquid Connection',
  status: 'active',
  meta: null,
  profile: null,
  resolvedVenueAccountId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  assignedAgentCount: 0,
  referencingBotCount: 0,
  venueAccountRef: null,
};

let mockDbRows: Record<string, unknown>[] = [];
let lastInserted: Record<string, unknown> | undefined;
let insertedValues: Record<string, unknown>[] = [];
let lastUpdateSet: Record<string, unknown> | undefined;
let updateSets: Record<string, unknown>[] = [];

function buildMockDb() {
  lastInserted = undefined;
  insertedValues = [];
  lastUpdateSet = undefined;
  updateSets = [];

  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v) => {
        lastInserted = v;
        insertedValues.push(v);
        return Promise.resolve();
      }),
    }),
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (mockDbRows.length > 0) return mockDbRows;
            return [];
          }),
        }),
        where: vi.fn().mockImplementation(() => {
          if (mockDbRows.length > 0) return mockDbRows;
          if (insertedValues.length > 0) {
            return [{
              id: insertedValues[0]!['id'],
              ...insertedValues[0],
              assignedAgentCount: 0,
              referencingBotCount: 0,
            }];
          }
          return [];
        }),
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s) => {
        lastUpdateSet = s;
        updateSets.push(s);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  } as any;
  db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db));
  return db;
}

describe('POST /connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [];
    lastInserted = undefined;
    insertedValues = [];
  });

  it('creates a connection and returns 201', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'My Connection' },
    });

    expect(res.statusCode).toBe(201);
    expect(lastInserted).toBeDefined();
    expect(lastInserted!['provider']).toBe('hyperliquid');
    expect(lastInserted!['userId']).toBe(TEST_USER_ID);
    expect(lastInserted!['status']).toBe('active');
    // Only the connection itself is created — no hidden venue account or trading binding
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]!['provider']).toBe('hyperliquid');
    expect(res.json<{ assignedAgentCount: number; referencingBotCount: number }>().assignedAgentCount).toBe(0);
    expect(res.json<{ assignedAgentCount: number; referencingBotCount: number }>().referencingBotCount).toBe(0);
  });

  it('returns 400 for missing required fields', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid' }, // missing label
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
  });

  it('returns 403 when connection limit is reached', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    let selectCallCount = 0;
    const txInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    const db = {
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) {
                return Promise.resolve([{ id: 'conn-1' }]);
              }
              return Promise.resolve([]);
            }),
          }),
        })),
        insert: txInsert,
      })),
    } as any;
    await connectionRoutes(app, db, undefined, makePlansConfig(1));

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'My Connection' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('plan.limit_exceeded');
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('creates a connection with a valid credentialId', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'With Cred', credentialId: 'cred-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues[0]!['credentialId']).toBe('cred-1');
  });

  it('does not auto-create a trading binding for non-trading providers', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'telegram', label: 'Telegram bot', credentialId: 'cred-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toHaveLength(1);
  });

  it.each(['hyperliquid', 'jupiter', '1inch', 'bybit'] as const)(
    'creates only the connection (no hidden binding) for trading provider=%s',
    async (provider) => {
      const app = Fastify();
      decorateWithAuth(app);
      const db = buildMockDb();
      await connectionRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/connections',
        payload: { provider, label: `${provider} connection` },
      });

      expect(res.statusCode).toBe(201);
      // Only one insert: the connection itself
      expect(insertedValues).toHaveLength(1);
      expect(insertedValues[0]!['provider']).toBe(provider);
    },
  );

});

describe('GET /connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [CONNECTION_ROW];
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([]);
  });

  it('returns 200 with list of connections', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ assignedAgentCount: number; referencingBotCount: number }> }>();
    expect(Array.isArray(body.connections)).toBe(true);
    expect(body.connections[0]?.assignedAgentCount).toBe(0);
    expect(body.connections[0]?.referencingBotCount).toBe(0);
  });

  it('returns null for venueAccountRef when no venue account is linked', async () => {
    mockDbRows = [CONNECTION_ROW]; // resolvedVenueAccountId is null
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ venueAccountRef: string | null }> }>();
    expect(body.connections[0]?.venueAccountRef ?? null).toBeNull();
  });

  it('returns venueAccountRef from the boundary when resolvedVenueAccountId is set', async () => {
    mockDbRows = [{
      ...CONNECTION_ROW,
      resolvedVenueAccountId: 'va-1',
    }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    // c4.9f: venueAccountRef is sourced over the boundary get_venue_account, not
    // a local venue_accounts read.
    const { client } = makeBoundaryClient({ refByAccount: { 'va-1': '0xabc123' } });
    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ venueAccountRef: string }> }>();
    expect(body.connections[0]?.venueAccountRef).toBe('0xabc123');
  });

  it('returns referencingBotCount from the boundary when the account has bots', async () => {
    mockDbRows = [{ ...CONNECTION_ROW, resolvedVenueAccountId: 'va-1' }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    const { client } = makeBoundaryClient({ botsByAccount: { 'va-1': ['bot-1', 'bot-2'] } });
    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ referencingBotCount: number }> }>();
    expect(body.connections[0]?.referencingBotCount).toBe(2);
  });

  it('degrades referencingBotCount to 0 and venueAccountRef to null when the boundary is down', async () => {
    mockDbRows = [{ ...CONNECTION_ROW, resolvedVenueAccountId: 'va-1' }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    const { client } = makeDownBoundaryClient();
    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    // The list read stays available even when the boundary is down — the
    // display fields degrade (the hard-delete still fails closed at the 409).
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ referencingBotCount: number; venueAccountRef: string | null }> }>();
    expect(body.connections[0]?.referencingBotCount).toBe(0);
    expect(body.connections[0]?.venueAccountRef).toBeNull();
  });

  it('returns null for venueAccountRef when resolvedVenueAccountId is null', async () => {
    mockDbRows = [CONNECTION_ROW]; // resolvedVenueAccountId is null
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ venueAccountRef: string | null }> }>();
    expect(body.connections[0]?.venueAccountRef).toBeNull();
  });

  it('returns the profile field', async () => {
    mockDbRows = [{
      ...CONNECTION_ROW,
      profile: { displayName: 'Trader Joe', avatar: 'https://example.com/avatar.png' },
    }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ profile: { displayName: string; avatar: string } }> }>();
    expect(body.connections[0]?.profile).toEqual({ displayName: 'Trader Joe', avatar: 'https://example.com/avatar.png' });
  });

  it('returns null profile when profile is not set', async () => {
    mockDbRows = [CONNECTION_ROW]; // profile is null
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<{ profile: unknown }> }>();
    expect(body.connections[0]?.profile).toBeNull();
  });

  it('does not expose secrets (encrypted_data, encryption_meta) in the response', async () => {
    // The connection view only selects explicit fields via selectConnectionView().
    // Verify the response shape matches exactly what is declared there — no more.
    mockDbRows = [CONNECTION_ROW];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: Array<Record<string, unknown>> }>();
    const conn = body.connections[0]!;
    // The view selects only these keys — secrets like encrypted_data and
    // encryption_meta are never part of selectConnectionView().
    const allowedKeys = new Set([
      'id', 'userId', 'credentialId', 'provider', 'label', 'status', 'meta',
      'profile', 'resolvedVenueAccountId', 'createdAt', 'updatedAt',
      'assignedAgentCount', 'referencingBotCount',
      'venueAccountRef',
    ]);
    const responseKeys = Object.keys(conn);
    for (const key of responseKeys) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Explicitly assert secrets are absent
    expect(responseKeys).not.toContain('encrypted_data');
    expect(responseKeys).not.toContain('encryption_meta');
  });
});

describe('GET /connections/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [CONNECTION_ROW];
  });

  it('returns 200 for an existing connection', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ assignedAgentCount: number; referencingBotCount: number }>().assignedAgentCount).toBe(0);
    expect(res.json<{ assignedAgentCount: number; referencingBotCount: number }>().referencingBotCount).toBe(0);
  });

  it('returns 404 when connection does not exist', async () => {
    mockDbRows = [];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });
});

describe('DELETE /connections/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [CONNECTION_ROW];
  });

  it('revokes an active connection and returns 204', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(204);
    // Two updates: first revokes agent_connections rows, then revokes the connection itself.
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]!['status']).toBe('revoked');
    expect(updateSets[0]!['revokedAt']).toBeDefined();
    expect(updateSets[1]!['status']).toBe('revoked');
  });

  it('returns 404 when connection does not exist', async () => {
    mockDbRows = [];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/connections/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when connection is already revoked', async () => {
    mockDbRows = [{ ...CONNECTION_ROW, status: 'revoked' }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.already_revoked');
  });

  it('revokes a connection with multiple agent grants and flips all of them', async () => {
    // When a connection is assigned to 3 agents, revoke should update all 3
    // agent_connections rows to status='revoked'.
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    // The mock returns one row for the conn lookup and CONNECTION_ROW for
    // the affectedAgents select. Override the select to return 3 agent IDs
    // for the affected agents query.
    let selectCount = 0;
    db.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCount++;
            return Promise.resolve([
              { agentId: 'agent-1', capital: null, riskPosture: null, executionDefaults: null },
              { agentId: 'agent-2', capital: null, riskPosture: null, executionDefaults: null },
              { agentId: 'agent-3', capital: null, riskPosture: null, executionDefaults: null },
            ]);
          }),
        }),
        where: vi.fn().mockImplementation(() => {
          selectCount++;
          if (selectCount === 1) {
            // conn lookup
            return Promise.resolve([{ id: CONNECTION_ROW.id, status: CONNECTION_ROW.status }]);
          }
          return Promise.resolve([{ id: `grant-${selectCount}`, userId: TEST_USER_ID, status: 'active' }]);
        }),
      })),
    }));
    // Override update to track calls
    updateSets = [];
    db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s: Record<string, unknown>) => {
        updateSets.push(s);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(204);
    // One local grant update per agent, then the connection update in the final commit.
    expect(updateSets).toHaveLength(4);
    expect(updateSets[0]!['status']).toBe('revoked');
    expect(updateSets[0]!['revokedAt']).toBeDefined();
    expect(updateSets[1]!['status']).toBe('revoked');
    expect(loadActiveTradingProfileConnections).toHaveBeenCalledTimes(6);
  });

  it('reconciles every shared grant from its prior binding to the remaining ready binding before revocation', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    let selectCount = 0;
    db.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { agentId: 'agent-1', capital: null, riskPosture: null, executionDefaults: null },
            { agentId: 'agent-2', capital: null, riskPosture: null, executionDefaults: null },
          ]),
        }),
        where: vi.fn().mockImplementation(() => {
          selectCount++;
          return Promise.resolve(selectCount === 1 ? [CONNECTION_ROW] : [{ id: `grant-${selectCount}`, userId: TEST_USER_ID, status: 'active' }]);
        }),
      }),
    }));
    vi.mocked(loadActiveTradingProfileConnections)
      .mockResolvedValueOnce([
        { connectionId: 'conn-1', venueAccountId: 'venue-1', active: true, ready: true, grantedAt: new Date('2026-01-02'), assignmentId: 'grant-b' },
        { connectionId: 'conn-fallback', venueAccountId: 'venue-fallback', active: true, ready: true, grantedAt: new Date('2026-01-01'), assignmentId: 'grant-a' },
      ])
      .mockResolvedValueOnce([
        { connectionId: 'conn-1', venueAccountId: 'venue-1', active: true, ready: true, grantedAt: new Date('2026-01-02'), assignmentId: 'grant-b' },
        { connectionId: 'conn-fallback', venueAccountId: 'venue-fallback', active: true, ready: true, grantedAt: new Date('2026-01-01'), assignmentId: 'grant-a' },
      ])
      .mockResolvedValueOnce([
        { connectionId: 'conn-1', venueAccountId: 'venue-2', active: true, ready: true, grantedAt: new Date('2026-01-02'), assignmentId: 'grant-d' },
        { connectionId: 'conn-fallback', venueAccountId: 'venue-fallback', active: true, ready: true, grantedAt: new Date('2026-01-01'), assignmentId: 'grant-c' },
      ])
      .mockResolvedValueOnce([
        { connectionId: 'conn-1', venueAccountId: 'venue-2', active: true, ready: true, grantedAt: new Date('2026-01-02'), assignmentId: 'grant-d' },
        { connectionId: 'conn-fallback', venueAccountId: 'venue-fallback', active: true, ready: true, grantedAt: new Date('2026-01-01'), assignmentId: 'grant-c' },
      ]);
    const stagedInputs: TradingProfilePlannerInput[] = [];
    await connectionRoutes(app, db, undefined, undefined, undefined, buildStagedSaga(db, (input) => stagedInputs.push(input)));

    const response = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });

    expect(response.statusCode).toBe(204);
    expect(stagedInputs).toHaveLength(2);
    for (const input of stagedInputs) {
      expect(input.prior.connections).toHaveLength(2);
      expect(input.proposed.connections).toEqual([
        expect.objectContaining({ connectionId: 'conn-fallback' }),
      ]);
      const plan = planTradingProfileReconciliation(input);
      expect(plan.selectedBinding).toEqual({
        previous: expect.objectContaining({ connectionId: 'conn-1' }),
        next: expect.objectContaining({ connectionId: 'conn-fallback' }),
      });
      expect(plan.inverseActions[0]).toEqual({
        kind: 'select_binding',
        binding: expect.objectContaining({ connectionId: 'conn-1' }),
      });
    }
  });

  it('restores both grants and both remote profiles when the second shared-agent revoke fails', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    const localGrants = new Map([['agent-1', 'active'], ['agent-2', 'active']]);
    const remoteProfiles = new Map([['agent-1', 'conn-1'], ['agent-2', 'conn-1']]);
    const affectedAgents = [
      { agentId: 'agent-1', capital: null, riskPosture: null, executionDefaults: null },
      { agentId: 'agent-2', capital: null, riskPosture: null, executionDefaults: null },
    ];
    db.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(affectedAgents) }),
        where: vi.fn().mockResolvedValue([{ id: 'conn-1', userId: TEST_USER_ID, status: 'active' }]),
      }),
    }));
    let localUpdateCount = 0;
    db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(async () => {
          if (values['status'] === 'revoked') localGrants.set('agent-1', 'revoked');
          if (values['status'] === 'active') localGrants.set('agent-1', 'active');
          localUpdateCount += 1;
        }),
      })),
    });
    let invocation = 0;
    const saga = {
      readCurrentProfiles: vi.fn(async (_ownerId: string, actorId: string, connections: TradingProfileConnection[]) => new Map(
        connections.flatMap((connection) => connection.venueAccountId === null ? [] : [[connection.venueAccountId, {
          actorId,
          venueAccountId: connection.venueAccountId,
          capital: '1000',
          riskPosture: null,
          executionDefaults: { mode: 'paper' },
        } satisfies TypedTradingProfile] as const]),
      )),
      executeStaged: vi.fn(async (input: { actorId: string; preparePlannerInput: () => Promise<TradingProfilePlannerInput>; commitLocal: (tx: unknown, markLocalCommitted: () => Promise<void>) => Promise<unknown>; onOperationStaged: (operation: { operationId: string; ownerId: string; actorId: string }) => void }) => {
        invocation += 1;
        await input.preparePlannerInput();
        input.onOperationStaged({ operationId: `operation-${invocation}`, ownerId: TEST_USER_ID, actorId: input.actorId });
        remoteProfiles.set(input.actorId, 'fallback');
        if (invocation === 2) {
          remoteProfiles.set(input.actorId, 'conn-1');
          throw new Error('second remote revoke failed');
        }
        return input.commitLocal(db, vi.fn().mockResolvedValue(undefined));
      }),
      compensate: vi.fn(async (operation: { actorId: string }) => {
        remoteProfiles.set(operation.actorId, 'conn-1');
      }),
      finalize: vi.fn(),
    };
    await connectionRoutes(app, db, undefined, undefined, undefined, saga);

    const response = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });

    expect(response.statusCode).toBe(500);
    expect(saga.finalize).not.toHaveBeenCalled();
    expect(saga.compensate).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'agent-1' }));
    expect(localUpdateCount).toBe(2);
    expect([...localGrants.values()]).toEqual(['active', 'active']);
    expect([...remoteProfiles.values()]).toEqual(['conn-1', 'conn-1']);
  });

  it('keeps every grant revoked and lets recovery finish when the second shared-agent finalization fails', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    const localGrants = new Map([['agent-1', 'active'], ['agent-2', 'active']]);
    const remoteProfiles = new Map([['agent-1', 'conn-1'], ['agent-2', 'conn-1']]);
    const outboxStates = new Map<string, 'completed' | 'finalizing'>();
    const affectedAgents = [
      { agentId: 'agent-1', capital: null, riskPosture: null, executionDefaults: null },
      { agentId: 'agent-2', capital: null, riskPosture: null, executionDefaults: null },
    ];
    db.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(affectedAgents) }),
        where: vi.fn().mockResolvedValue([{ id: 'conn-1', userId: TEST_USER_ID, status: 'active' }]),
      }),
    }));
    db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    let invocation = 0;
    const saga = {
      readCurrentProfiles: vi.fn(async (_ownerId: string, actorId: string, connections: TradingProfileConnection[]) => new Map(
        connections.flatMap((connection) => connection.venueAccountId === null ? [] : [[connection.venueAccountId, {
          actorId,
          venueAccountId: connection.venueAccountId,
          capital: '1000',
          riskPosture: null,
          executionDefaults: { mode: 'paper' },
        } satisfies TypedTradingProfile] as const]),
      )),
      executeStaged: vi.fn(async (input: { actorId: string; preparePlannerInput: () => Promise<TradingProfilePlannerInput>; commitLocal: (tx: unknown, markLocalCommitted: () => Promise<void>) => Promise<unknown>; onOperationStaged: (operation: { operationId: string; ownerId: string; actorId: string }) => void }) => {
        invocation += 1;
        await input.preparePlannerInput();
        input.onOperationStaged({ operationId: `operation-${invocation}`, ownerId: TEST_USER_ID, actorId: input.actorId });
        remoteProfiles.set(input.actorId, 'cleared');
        localGrants.set(input.actorId, 'revoked');
        return input.commitLocal(db, vi.fn().mockResolvedValue(undefined));
      }),
      finalize: vi.fn(async (operation: { operationId: string }) => {
        if (operation.operationId === 'operation-1') {
          outboxStates.set(operation.operationId, 'completed');
          return;
        }
        outboxStates.set(operation.operationId, 'finalizing');
        throw new Error('second finalization failed');
      }),
      compensate: vi.fn(),
      recover: vi.fn(async () => {
        outboxStates.set('operation-2', 'completed');
      }),
    };
    await connectionRoutes(app, db, undefined, undefined, undefined, saga);

    const response = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });

    expect(response.statusCode).toBe(500);
    expect(saga.compensate).not.toHaveBeenCalled();
    expect([...localGrants.values()]).toEqual(['revoked', 'revoked']);
    expect([...remoteProfiles.values()]).toEqual(['cleared', 'cleared']);
    expect([...outboxStates.entries()]).toEqual([
      ['operation-1', 'completed'],
      ['operation-2', 'finalizing'],
    ]);

    await saga.recover();

    expect([...outboxStates.values()]).toEqual(['completed', 'completed']);
  });

  it('revokes a connection with zero agent grants and still returns 204', async () => {
    // When a connection has no agent grants, the revoke should still succeed.
    // The agent_connections update will just match zero rows.
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    let selectCount = 0;
    db.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
        where: vi.fn().mockImplementation(() => {
          selectCount++;
          if (selectCount === 1) {
            return Promise.resolve([{ id: CONNECTION_ROW.id, status: CONNECTION_ROW.status }]);
          }
          // affectedAgents query — no agents
          return Promise.resolve([]);
        }),
      })),
    }));
    updateSets = [];
    db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s: Record<string, unknown>) => {
        updateSets.push(s);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(204);
    // Still two updates: agent_connections (matching 0 rows) + connections.
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]!['status']).toBe('revoked');
    expect(updateSets[1]!['status']).toBe('revoked');
  });

  it('publishes a runtime refresh after revoking a connection with active trading grants', async () => {
    const dbModule = await import('@herobids/db');
    vi.spyOn(dbModule, 'resolveRuntimeCapabilityDescriptor').mockResolvedValue({
      grantedConnectionsByFamily: {},
      readinessByFamily: {},
      resolvedSkills: [],
      defaultConnectionByFamily: {},
    } as never);
    vi.spyOn(dbModule, 'buildRuntimeDescriptor').mockReturnValue({
      agentId: 'agent-1',
      schemaVersion: 'v1',
      name: 'agent-1',
      goal: 'Trade carefully',
      executionMode: 'paper',
      toolPolicy: {},
      budgets: TEST_RUNTIME_BUDGETS,
      grantedConnectionsByFamily: {},
      readinessByFamily: {},
      resolvedSkills: [],
      defaultConnectionByFamily: {},
      guardrails: {
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      },
    } as never);

    const app = Fastify();
    decorateWithAuth(app);
    const redisClient = { xadd: vi.fn().mockResolvedValue('msg-1') };
    const selectSequence: unknown[][] = [
      [{ id: CONNECTION_ROW.id, status: CONNECTION_ROW.status }],
      [{ agentId: 'agent-1' }],
      [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active' }],
      [{ id: 'grant-1' }],
      [{
        id: 'agent-1',
        name: 'agent-1',
        prompt: 'Trade carefully',
        skillIds: [],
        toolPolicy: null,
        executionMode: 'paper',
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      }],
      [],
    ];
    let callIdx = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockImplementation(() => chain);
        chain.innerJoin = vi.fn().mockImplementation(() => chain);
        chain.leftJoin = vi.fn().mockImplementation(() => chain);
        chain.groupBy = vi.fn().mockImplementation(() => chain);
        chain.where = vi.fn().mockImplementation(() => Promise.resolve(selectSequence[callIdx++] ?? []));
        return chain;
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };

    await connectionRoutes(app, db, redisClient as any, undefined, undefined, buildStagedSaga(db));

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });

    expect(res.statusCode).toBe(204);
    expect(redisClient.xadd).toHaveBeenCalled();

    const envelope = JSON.parse((redisClient.xadd as ReturnType<typeof vi.fn>).mock.calls[0][6] as string) as {
      payload: { runtimeDescriptor: { budgets: { maxVisibleToolSchemas: number } } };
    };
    expect(envelope.payload.runtimeDescriptor.budgets.maxVisibleToolSchemas).toBe(37);
  });
});

describe('DELETE /connections/:id?permanent=true (hard-delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a Drizzle-like mock whose select→from→where chain yields rows
   * from a sequence. Supports .limit(1) chained after .where().
   */
  function buildHardDeleteDb(selectSequence: unknown[][]) {
    let callIdx = 0;

    function makeThenable(rows: unknown[]) {
      // Drizzle query objects are thenable AND have chain methods like .limit()
      const thenable: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => resolve(rows),
      };
      thenable.limit = vi.fn().mockImplementation(() => makeThenable(rows));
      return thenable;
    }

    return {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockImplementation(() => {
          const innerChain: Record<string, unknown> = {};
          innerChain.where = vi.fn().mockImplementation(() =>
            makeThenable(selectSequence[callIdx++] ?? []),
          );
          return innerChain;
        });
        return chain;
      }),
      delete: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
      transaction: vi.fn().mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          await fn({
            delete: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockResolvedValue(undefined),
            })),
          });
        },
      ),
    } as any;
  }

  it('hard-deletes when no active agent grants and the boundary reports no bots', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: 'va-1' }], // conn lookup
      [],                                                                    // active grants → none
    ]);
    // c4.9f: the bot guard is the boundary count_bots_by_venue_account.
    const { client } = makeBoundaryClient({ botsByAccount: { 'va-1': [] } });

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/conn-1?permanent=true',
    });
    expect(res.statusCode).toBe(204);
  });

  it('skips the bot guard and hard-deletes a connection with a null resolvedVenueAccountId', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: null }], // non-trading connection
      [],                                                                  // active grants → none
    ]);
    // A null-account connection has no trading bots — the boundary must NOT be called.
    const { client, invoke } = makeBoundaryClient();

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/conn-1?permanent=true',
    });
    expect(res.statusCode).toBe(204);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns 503 when the boundary is unavailable during the hard-delete bot guard', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: 'va-1' }],
      [], // no active grants
    ]);
    const { client } = makeDownBoundaryClient();

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/conn-1?permanent=true',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('precondition.not_ready');
  });

  it('returns 409 when active agent grants reference the connection', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: 'va-1' }],
      [{ agentId: 'agent-1' }], // active grant exists
    ]);
    // Grants are checked BEFORE the boundary — the bot guard is never reached.
    const { client, invoke } = makeBoundaryClient();

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/conn-1?permanent=true',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.in_use');
    expect(
      res.json<{ params: { hint: string } }>().params.hint,
    ).toContain('Revoke the connection instead');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns 409 with blockingBotIds when the boundary reports bots reference the account', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: 'va-1' }],
      [], // no active agent grants
    ]);
    // c4.9f: blockingBotIds come from the boundary count_bots_by_venue_account.
    const { client } = makeBoundaryClient({ botsByAccount: { 'va-1': ['bot-1', 'bot-2'] } });

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/conn-1?permanent=true',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.in_use');
    const params = res.json<{
      params: { blockingBotIds: string[]; hint: string };
    }>().params;
    expect(params.blockingBotIds).toEqual(['bot-1', 'bot-2']);
    expect(params.hint).toContain('Delete the bots');
  });

  it('returns 404 when connection does not exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([[]]); // conn not found

    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/missing?permanent=true',
    });
    expect(res.statusCode).toBe(404);
  });

  it('allows hard-delete after a connection has been revoked', async () => {
    // Simulate the post-revoke state: connection is revoked, agent_connections are revoked.
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'revoked', resolvedVenueAccountId: 'va-1' }], // conn lookup
      [],                                                                     // active grants → none (already revoked)
    ]);
    const { client } = makeBoundaryClient({ botsByAccount: { 'va-1': [] } }); // no bots

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1?permanent=true' });
    expect(res.statusCode).toBe(204);
  });

  it('returns 409 when a revoked connection has a concurrent active agent grant', async () => {
    // Regression: after revoke, a new agent grant could be created concurrently.
    // Hard-delete must still detect the active grant and block.
    const app = Fastify();
    decorateWithAuth(app);

    const db = buildHardDeleteDb([
      [{ id: 'conn-1', status: 'revoked', resolvedVenueAccountId: 'va-1' }], // conn lookup → revoked
      [{ agentId: 'agent-1' }],                                               // active grants → concurrent grant exists!
    ]);
    const { client } = makeBoundaryClient();

    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1?permanent=true' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.in_use');
    expect(
      res.json<{ params: { hint: string } }>().params.hint,
    ).toContain('Revoke the connection instead');
  });

  it('handles concurrent FK violation after checks pass (race condition)', async () => {
    const app = Fastify();
    decorateWithAuth(app);

    const selectSequence: unknown[][] = [
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: 'va-1' }],
      [], // no active agent grants
      [], // FK-race re-check: no concurrent active grants → re-throw
    ];
    let callIdx = 0;
    const fkError = new Error(
      'update or delete on table "connections" violates foreign key constraint',
    ) as Error & { code: string };
    fkError.code = '23503';

    function makeThenable(rows: unknown[]) {
      const thenable: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => resolve(rows),
      };
      thenable.limit = vi.fn().mockImplementation(() => makeThenable(rows));
      return thenable;
    }

    const db = {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockImplementation(() => {
          const innerChain: Record<string, unknown> = {};
          innerChain.where = vi.fn().mockImplementation(() =>
            makeThenable(selectSequence[callIdx++] ?? []),
          );
          return innerChain;
        });
        return chain;
      }),
      transaction: vi.fn().mockRejectedValue(fkError),
    } as any;

    // Boundary reports no bots so the delete proceeds to the transaction (which
    // then FK-races on a concurrent grant).
    const { client } = makeBoundaryClient({ botsByAccount: { 'va-1': [] } });
    await connectionRoutes(app, db, undefined, undefined, client);

    const res = await app.inject({
      method: 'DELETE',
      url: '/connections/conn-1?permanent=true',
    });
    // FK error is re-thrown after re-checks find no concurrent grants → 500
    expect(res.statusCode).toBe(500);
  });
});
