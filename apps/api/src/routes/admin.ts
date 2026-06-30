import type { FastifyInstance } from 'fastify';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { eq, count, sql, gte } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { users, bots, agents, agentRuntimeSessions, billingWebhookEvents } from '@herobids/db';
import type { MarketDataConfig } from '@herobids/domain';

/** Options passed to adminRoutes for market-data provisioning endpoints. */
export interface AdminRoutesOptions {
  marketDataConfig?: MarketDataConfig;
}

const AGENT_CONTAINER_FILTER = encodeURIComponent(JSON.stringify({ label: ['herobids.role=agent'] }));
const PROVIDER_COUNTERS_HASH_KEY = 'market-intel:provider-counters:v2';
const LEGACY_PROVIDER_COUNTERS_KEY = 'market-intel:provider-counters';

function parseAppVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, '../../../../package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return 'parse-failed';
  }
}

const VERSION = parseAppVersion();

// Docker socket path — standard on Linux; customisable via env.
const DOCKER_SOCKET = process.env['DOCKER_SOCKET_PATH'] ?? '/var/run/docker.sock';

/** Send a single HTTP GET over a Unix socket and return the raw response body. */
async function dockerSocketGet(path: string): Promise<unknown> {
  const { default: net } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(DOCKER_SOCKET);
    let rawData = '';
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => { rawData += chunk.toString(); });
    socket.on('end', () => {
      const bodyStart = rawData.indexOf('\r\n\r\n');
      if (bodyStart === -1) return reject(new Error('Malformed HTTP response'));
      try {
        resolve(JSON.parse(rawData.slice(bodyStart + 4)));
      } catch {
        reject(new Error('Non-JSON response from Docker socket'));
      }
    });
    socket.on('error', reject);
    // Abort if the socket call takes too long
    socket.setTimeout(3000, () => {
      socket.destroy(new Error('Docker socket timeout'));
    });
  });
}

async function dockerSocketGetAgentContainers(): Promise<unknown[]> {
  const result = await dockerSocketGet(`/containers/json?all=false&filters=${AGENT_CONTAINER_FILTER}`);
  return Array.isArray(result) ? result : [];
}

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

/** Get disk usage for the root filesystem (or a configured path). */
function getDiskStats(): { totalBytes: number; freeBytes: number; usedBytes: number } | null {
  try {
    const stat = fs.statfsSync('/');
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bfree * stat.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    // statfsSync not available on all Node.js versions / platforms (added in v19)
    return null;
  }
}

/** Check database connectivity with a timeout. */
async function checkPostgres(db: Database): Promise<'ok' | 'timeout' | 'error'> {
  try {
    const result = await Promise.race<'ok' | 'timeout'>([
      db.execute(sql`SELECT 1`).then(() => 'ok' as const),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 1500)),
    ]);
    return result;
  } catch {
    return 'error';
  }
}

/** Check Redis connectivity with a timeout. */
async function checkRedis(redis: { ping(): Promise<string> }): Promise<'ok' | 'timeout' | 'error'> {
  try {
    const result = await Promise.race<'ok' | 'timeout'>([
      redis.ping().then(() => 'ok' as const),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 1500)),
    ]);
    return result;
  } catch {
    return 'error';
  }
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
        .where(eq(agentRuntimeSessions.status, 'running'))
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
    let runningContainerCount: number | null = null;
    try {
      const containers = await dockerSocketGetAgentContainers();
      runningContainerCount = containers.length;
    } catch {
      // Docker unavailable — leave as null
    }

    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();

    return reply.send({
      version: VERSION,
      postgres: postgresStatus,
      redis: redisStatus,
      memory: {
        totalBytes: totalMemBytes,
        freeBytes: freeMemBytes,
        usedBytes: totalMemBytes - freeMemBytes,
      },
      disk: getDiskStats(),
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
    let containerData: unknown;
    try {
      containerData = await dockerSocketGetAgentContainers();
    } catch {
      return reply.send({ error: 'docker_unavailable' });
    }

    // Augment with agent runtime session data for CPU/memory
    let sessions: { id: string; agentId: string; cpuPct: number | null; memoryBytes: number | null; status: string }[] = [];
    try {
      const rows = await db
        .select({
          id: agentRuntimeSessions.id,
          agentId: agentRuntimeSessions.agentId,
          cpuPct: agentRuntimeSessions.cpuPct,
          memoryBytes: agentRuntimeSessions.memoryBytes,
          status: agentRuntimeSessions.status,
        })
        .from(agentRuntimeSessions)
        .where(
          eq(agentRuntimeSessions.status, 'running'),
        );
      sessions = rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        cpuPct: r.cpuPct,
        memoryBytes: r.memoryBytes,
        status: r.status,
      }));
    } catch {
      // Sessions query is best-effort; still return container data
    }

    return reply.send({ containers: containerData, sessions });
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
