import type { FastifyInstance } from 'fastify';
import { eq, count, sql, gte, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { users, bots, agents, agentRuntimeSessions, billingWebhookEvents } from '@herobids/db';
import type { MarketDataConfig, ServerHealthSnapshot } from '@herobids/domain';
import { SERVER_TYPES, serverHealthKeyPattern } from '@herobids/domain';
import { checkPostgres, checkRedis, parseAppVersion, dockerSocketGetAgentContainers, getRunningContainerCount } from '../admin-utils.js';

/** Options passed to adminRoutes for market-data provisioning endpoints. */
export interface AdminRoutesOptions {
  marketDataConfig?: MarketDataConfig;
}

const PROVIDER_COUNTERS_HASH_KEY = 'market-intel:provider-counters:v2';
const LEGACY_PROVIDER_COUNTERS_KEY = 'market-intel:provider-counters';

const VERSION = parseAppVersion();

function parseLegacyProviderCounters(raw: string | null): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

async function readProviderCounters(redis: {
  get(key: string): Promise<string | null>;
  hgetall?(key: string): Promise<Record<string, string>>;
}): Promise<Record<string, Record<string, unknown>>> {
  if (redis.hgetall) {
    const counterFields = await redis.hgetall(PROVIDER_COUNTERS_HASH_KEY);
    if (Object.keys(counterFields).length > 0) {
      const counters: Record<string, Record<string, unknown>> = {};
      for (const [field, rawValue] of Object.entries(counterFields)) {
        const [providerName, requestClass, metric] = field.split(':');
        if (!providerName || !requestClass || !metric) continue;
        const key = `${providerName}:${requestClass}`;
        const parsedValue = metric === 'lastSuccessAt' ? rawValue : Number(rawValue);
        counters[key] ??= {};
        counters[key][metric] = Number.isNaN(parsedValue) ? rawValue : parsedValue;
      }
      return counters;
    }
  }

  return parseLegacyProviderCounters(await redis.get(LEGACY_PROVIDER_COUNTERS_KEY));
}

/** Middleware that returns 403 unless the authenticated request is marked as admin. */
function requireAdmin() {
  return async (request: { userId: string; isAdmin: boolean }, reply: { status(c: number): { send(b: unknown): unknown } }): Promise<void> => {
    if (!request.isAdmin) {
      reply.status(403).send({ error: 'forbidden', message: 'Admin access required' });
      return;
    }
  };
}

export async function adminRoutes(
  app: FastifyInstance,
  db: Database,
  redis: {
    ping(): Promise<string>;
    get(key: string): Promise<string | null>;
    hgetall?(key: string): Promise<Record<string, string>>;
    scan(cursor: string | number, ...args: unknown[]): Promise<[cursor: string, keys: string[]]>;
  },
  options: AdminRoutesOptions = {},
): Promise<void> {
  const adminPreHandler = requireAdmin();
  const { marketDataConfig } = options;

  // GET /admin/stats — system health and counts
  app.get('/admin/stats', { preHandler: adminPreHandler }, async (_request, reply) => {
    const [postgresStatus, redisStatus] = await Promise.all([
      checkPostgres(db),
      checkRedis(redis),
    ]);

    const recentWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      userCount,
      botCount,
      agentCount,
      runningSessionCount,
      failedWebhookCount,
      newUserCount,
      newAgentCount,
    ] = await Promise.all([
      db.select({ n: count(users.id) }).from(users).then((r) => r[0]?.n ?? 0),
      db.select({ n: count(bots.id) }).from(bots).then((r) => r[0]?.n ?? 0),
      db.select({ n: count(agents.id) }).from(agents).then((r) => r[0]?.n ?? 0),
      db
        .select({ n: count(agentRuntimeSessions.id) })
        .from(agentRuntimeSessions)
        .where(inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']))
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: count(billingWebhookEvents.id) })
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.status, 'failed'))
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: count(users.id) })
        .from(users)
        .where(gte(users.createdAt, recentWindowStart))
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: count(agents.id) })
        .from(agents)
        .where(gte(agents.createdAt, recentWindowStart))
        .then((r) => r[0]?.n ?? 0),
    ]);

    // Running container count — best-effort from Docker socket
    const runningContainerCount = await getRunningContainerCount();

    return reply.send({
      version: VERSION,
      postgres: postgresStatus,
      redis: redisStatus,
      counts: {
        users: userCount,
        bots: botCount,
        agents: agentCount,
        runningSessions: runningSessionCount,
        runningContainers: runningContainerCount,
        failedWebhooks: failedWebhookCount,
        newUsersLast24h: newUserCount,
        newAgentsLast24h: newAgentCount,
      },
    });
  });

  // GET /admin/servers — server health snapshots grouped by type
  app.get('/admin/servers', { preHandler: adminPreHandler }, async (_request, reply) => {
    const pattern = serverHealthKeyPattern();
    const servers: Record<string, ServerHealthSnapshot[]> = {};
    for (const t of SERVER_TYPES) {
      servers[t] = [];
    }

    // Cursor-based SCAN to collect all server health keys
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
      cursor = nextCursor;

      const values = await Promise.all(keys.map((key) => redis.get(key)));
      for (const raw of values) {
        if (!raw) continue;
        try {
          const snapshot = JSON.parse(raw) as ServerHealthSnapshot;
          const group = servers[snapshot.serverType];
          if (group) {
            group.push(snapshot);
          }
        } catch {
          // Skip malformed entries
        }
      }
    } while (cursor !== '0');

    return reply.send({ servers });
  });

  // GET /admin/users — all users with bot and agent counts
  app.get('/admin/users', { preHandler: adminPreHandler }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const hasPagination = query['limit'] !== undefined || query['offset'] !== undefined;
    const limit = Math.min(200, Math.max(1, parseInt(query['limit'] ?? '50', 10) || 50));
    const offset = Math.max(0, parseInt(query['offset'] ?? '0', 10) || 0);

    const [rows, [totalRow]] = await Promise.all([
      hasPagination
        ? db
            .select({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
              planId: users.planId,
              isAdmin: users.isAdmin,
              createdAt: users.createdAt,
              botCount: sql<number>`(SELECT COUNT(*) FROM bots WHERE bots.user_id = ${users.id})::int`,
              agentCount: sql<number>`(SELECT COUNT(*) FROM agents WHERE agents.user_id = ${users.id})::int`,
            })
            .from(users)
            .orderBy(sql`${users.createdAt} DESC`)
            .limit(limit)
            .offset(offset)
        : db
            .select({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
              planId: users.planId,
              isAdmin: users.isAdmin,
              createdAt: users.createdAt,
              botCount: sql<number>`(SELECT COUNT(*) FROM bots WHERE bots.user_id = ${users.id})::int`,
              agentCount: sql<number>`(SELECT COUNT(*) FROM agents WHERE agents.user_id = ${users.id})::int`,
            })
            .from(users)
            .orderBy(sql`${users.createdAt} DESC`),
      db.select({ total: count(users.id) }).from(users),
    ]);

    return reply.send({
      users: rows,
      total: totalRow?.total ?? 0,
      limit: hasPagination ? limit : rows.length,
      offset: hasPagination ? offset : 0,
    });
  });

  // GET /admin/containers — running agent containers (requires Docker socket)
  app.get('/admin/containers', { preHandler: adminPreHandler }, async (_request, reply) => {
    let containerData: unknown[] | null = null;
    let dockerError: string | undefined;
    try {
      containerData = await dockerSocketGetAgentContainers() as unknown[];
    } catch {
      dockerError = 'docker_unavailable';
      // Don't return early — still try to return session data from DB
    }

    // Query all non-terminal sessions (starting, launching, running, unhealthy)
    // so the admin can see sessions that are in-flight or recovering.
    // Include agent name for easier identification.
    let sessions: { id: string; agentId: string; agentName: string | null; cpuPct: number | null; memoryBytes: number | null; status: string }[] = [];
    try {
      const rows = await db
        .select({
          id: agentRuntimeSessions.id,
          agentId: agentRuntimeSessions.agentId,
          agentName: agents.name,
          cpuPct: agentRuntimeSessions.cpuPct,
          memoryBytes: agentRuntimeSessions.memoryBytes,
          status: agentRuntimeSessions.status,
        })
        .from(agentRuntimeSessions)
        .innerJoin(agents, eq(agentRuntimeSessions.agentId, agents.id))
        .where(
          inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
        );
      sessions = rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        agentName: r.agentName,
        cpuPct: r.cpuPct,
        memoryBytes: r.memoryBytes,
        status: r.status,
      }));
    } catch {
      // Sessions query is best-effort; still return whatever data we have
    }

    const response: { containers: unknown[] | null; sessions: typeof sessions; error?: string } = {
      containers: containerData,
      sessions,
    };
    if (dockerError) {
      response['error'] = dockerError;
    }
    return reply.send(response);
  });

  // POST /admin/users/:id/promote — grant admin to a user
  app.post<{ Params: { id: string } }>('/admin/users/:id/promote', { preHandler: adminPreHandler }, async (request, reply) => {
    const { id } = request.params;
    const now = new Date();
    const updated = await db
      .update(users)
      .set({ isAdmin: true, updatedAt: now })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, isAdmin: users.isAdmin });

    if (!updated[0]) {
      return reply.status(404).send({ error: 'not_found', message: 'User not found' });
    }

    return reply.send({ user: updated[0] });
  });

  // DELETE /admin/users/:id/admin — revoke admin from a user
  app.delete<{ Params: { id: string } }>('/admin/users/:id/admin', { preHandler: adminPreHandler }, async (request, reply) => {
    const { id } = request.params;

    if (id === request.userId) {
      return reply.status(400).send({ error: 'invalid_request', message: 'Cannot demote yourself' });
    }

    const now = new Date();
    const updated = await db
      .update(users)
      .set({ isAdmin: false, updatedAt: now })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, isAdmin: users.isAdmin });

    if (!updated[0]) {
      return reply.status(404).send({ error: 'not_found', message: 'User not found' });
    }

    return reply.send({ user: updated[0] });
  });

  // GET /admin/billing/webhooks — failed billing webhook events for investigation
  app.get('/admin/billing/webhooks', { preHandler: adminPreHandler }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const hasPagination = query['limit'] !== undefined || query['offset'] !== undefined;
    const limit = Math.min(200, Math.max(1, parseInt(query['limit'] ?? '50', 10) || 50));
    const offset = Math.max(0, parseInt(query['offset'] ?? '0', 10) || 0);

    const [rows, [totalRow]] = await Promise.all([
      hasPagination
        ? db
            .select({
              id: billingWebhookEvents.id,
              eventType: billingWebhookEvents.eventType,
              status: billingWebhookEvents.status,
              error: billingWebhookEvents.error,
              processedAt: billingWebhookEvents.processedAt,
            })
            .from(billingWebhookEvents)
            .where(eq(billingWebhookEvents.status, 'failed'))
            .orderBy(sql`${billingWebhookEvents.processedAt} DESC`)
            .limit(limit)
            .offset(offset)
        : db
            .select({
              id: billingWebhookEvents.id,
              eventType: billingWebhookEvents.eventType,
              status: billingWebhookEvents.status,
              error: billingWebhookEvents.error,
              processedAt: billingWebhookEvents.processedAt,
            })
            .from(billingWebhookEvents)
            .where(eq(billingWebhookEvents.status, 'failed'))
            .orderBy(sql`${billingWebhookEvents.processedAt} DESC`),
      db.select({ total: count(billingWebhookEvents.id) }).from(billingWebhookEvents).where(eq(billingWebhookEvents.status, 'failed')),
    ]);

    return reply.send({
      webhooks: rows,
      total: totalRow?.total ?? 0,
      limit: hasPagination ? limit : rows.length,
      offset: hasPagination ? offset : 0,
    });
  });

  // GET /admin/market-data/overview — discovery and regime freshness
  app.get('/admin/market-data/overview', { preHandler: adminPreHandler }, async (_request, reply) => {
    const [discoveryMetaRaw, lastErrorRaw] = await Promise.all([
      redis.get('market-intel:discovery:meta'),
      redis.get('market-intel:last-error'),
    ]);

    let discoveryMeta: Record<string, unknown> | null = null;
    if (discoveryMetaRaw) {
      try { discoveryMeta = JSON.parse(discoveryMetaRaw) as Record<string, unknown>; } catch { /* ignore */ }
    }

    let lastError: Record<string, unknown> | null = null;
    if (lastErrorRaw) {
      try { lastError = JSON.parse(lastErrorRaw) as Record<string, unknown>; } catch { /* ignore */ }
    }

    // Read regime snapshots — look up known benchmark symbols from discovery meta
    // The coordinator stores benchmarks in market-intel:coordinator-config
    const coordinatorConfigRaw = await redis.get('market-intel:coordinator-config');
    let benchmarkSymbols: string[] = ['BTC'];
    if (coordinatorConfigRaw) {
      try {
        const cfg = JSON.parse(coordinatorConfigRaw) as Record<string, unknown>;
        if (Array.isArray(cfg['benchmarkSymbols'])) {
          benchmarkSymbols = cfg['benchmarkSymbols'] as string[];
        }
      } catch { /* ignore */ }
    }

    const regimeEntries = await Promise.all(
      benchmarkSymbols.map(async (symbol) => {
        const raw = await redis.get(`market-intel:regime:${symbol}`);
        if (!raw) return { symbol, snapshot: null };
        try {
          return { symbol, snapshot: JSON.parse(raw) as Record<string, unknown> };
        } catch {
          return { symbol, snapshot: null };
        }
      }),
    );

    const regimeSnapshots = Object.fromEntries(
      regimeEntries.map(({ symbol, snapshot }) => [symbol, snapshot]),
    );

    return reply.send({
      discovery: discoveryMeta,
      regimeSnapshots,
      lastError,
    });
  });

  // GET /admin/market-data/providers — provider config and per-class counters
  app.get('/admin/market-data/providers', { preHandler: adminPreHandler }, async (_request, reply) => {
    const counters = await readProviderCounters(redis);

    const cfg = marketDataConfig;

    // Helper to look up per-class counters
    function classCounters(providerName: string, requestClass: string) {
      return counters[`${providerName}:${requestClass}`] ?? {};
    }

    const providers = [
      {
        name: 'dexscreener',
        configured: true,
        enabled: true,
        unwired: false,
        requestClasses: [
          {
            requestClass: 'price-support',
            requestsPerMinute: cfg?.dexscreener.search.requestsPerMinute ?? 30,
            burstCapacity: cfg?.dexscreener.search.burstCapacity ?? 30,
            maxWaitMs: cfg?.dexscreener.search.maxWaitMs ?? 5000,
            cacheTtlMs: cfg?.dexscreener.search.cacheTtlMs ?? 15000,
            counters: classCounters('dexscreener', 'price-support'),
          },
          {
            requestClass: 'discovery',
            requestsPerMinute: cfg?.dexscreener.discovery.requestsPerMinute ?? 30,
            burstCapacity: cfg?.dexscreener.discovery.burstCapacity ?? 15,
            maxWaitMs: cfg?.dexscreener.discovery.maxWaitMs ?? 5000,
            cacheTtlMs: cfg?.dexscreener.discovery.cacheTtlMs ?? 300000,
            counters: classCounters('dexscreener', 'discovery'),
          },
        ],
      },
      {
        name: 'geckoterminal',
        configured: true,
        enabled: true,
        unwired: false,
        requestClasses: [
          {
            requestClass: 'regime',
            requestsPerMinute: cfg?.geckoterminal.candles.requestsPerMinute ?? 15,
            burstCapacity: cfg?.geckoterminal.candles.burstCapacity ?? 15,
            maxWaitMs: cfg?.geckoterminal.candles.maxWaitMs ?? 5000,
            cacheTtlMs: cfg?.geckoterminal.candles.cacheTtlMs ?? 60000,
            counters: classCounters('geckoterminal', 'regime'),
          },
          {
            requestClass: 'discovery',
            requestsPerMinute: cfg?.geckoterminal.discovery.requestsPerMinute ?? 10,
            burstCapacity: cfg?.geckoterminal.discovery.burstCapacity ?? 5,
            maxWaitMs: cfg?.geckoterminal.discovery.maxWaitMs ?? 5000,
            cacheTtlMs: cfg?.geckoterminal.discovery.cacheTtlMs ?? 300000,
            counters: classCounters('geckoterminal', 'discovery'),
          },
        ],
      },
      {
        name: 'hyperliquid',
        configured: true,
        enabled: true,
        unwired: false,
        requestClasses: [
          {
            requestClass: 'price-support',
            requestsPerMinute: cfg?.hyperliquid.intelligence.requestsPerMinute ?? 120,
            burstCapacity: cfg?.hyperliquid.intelligence.burstCapacity ?? 20,
            maxWaitMs: cfg?.hyperliquid.intelligence.maxWaitMs ?? 2000,
            cacheTtlMs: cfg?.hyperliquid.intelligence.cacheTtlMs ?? 60000,
            counters: classCounters('hyperliquid', 'price-support'),
          },
        ],
      },
      {
        name: 'bybit',
        configured: true,
        enabled: true,
        unwired: false,
        requestClasses: [
          {
            requestClass: 'price-support',
            requestsPerMinute: cfg?.bybit.intelligence.requestsPerMinute ?? 120,
            burstCapacity: cfg?.bybit.intelligence.burstCapacity ?? 20,
            maxWaitMs: cfg?.bybit.intelligence.maxWaitMs ?? 2000,
            cacheTtlMs: cfg?.bybit.intelligence.cacheTtlMs ?? 60000,
            counters: classCounters('bybit', 'price-support'),
          },
        ],
      },
      {
        name: 'binance',
        configured: true,
        enabled: true,
        unwired: false,
        requestClasses: [
          {
            requestClass: 'regime',
            requestsPerMinute: cfg?.binance.requestsPerMinute ?? 200,
            burstCapacity: cfg?.binance.requestsPerMinute ?? 200,
            maxWaitMs: cfg?.timeoutMs ?? 5000,
            cacheTtlMs: 0,
            counters: classCounters('binance', 'regime'),
          },
        ],
      },
      {
        name: 'coinmarketcap',
        configured: true,
        enabled: cfg?.coinMarketCap.enabled ?? false,
        unwired: (cfg?.coinMarketCap.enabled ?? false) && !(cfg?.coinMarketCap.apiKey),
        requestClasses: [
          {
            requestClass: 'discovery',
            requestsPerMinute: cfg?.coinMarketCap.requestsPerMinute ?? 30,
            burstCapacity: cfg?.coinMarketCap.requestsPerMinute ?? 30,
            maxWaitMs: cfg?.timeoutMs ?? 5000,
            cacheTtlMs: cfg?.coinMarketCap.cacheTtlMs ?? 3600000,
            counters: classCounters('coinmarketcap', 'discovery'),
          },
        ],
      },
      {
        name: 'birdeye',
        configured: true,
        enabled: cfg?.birdeye.enabled ?? false,
        unwired: (cfg?.birdeye.enabled ?? false) && !(cfg?.birdeye.apiKey),
        requestClasses: [
          {
            requestClass: 'discovery',
            requestsPerMinute: cfg?.birdeye.requestsPerMinute ?? 60,
            burstCapacity: cfg?.birdeye.requestsPerMinute ?? 60,
            maxWaitMs: cfg?.timeoutMs ?? 5000,
            cacheTtlMs: cfg?.birdeye.cacheTtlMs ?? 3600000,
            counters: classCounters('birdeye', 'discovery'),
          },
        ],
      },
    ];

    return reply.send({ providers });
  });
}
