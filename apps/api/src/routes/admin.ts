import type { FastifyInstance } from 'fastify';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { eq, count, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { users, bots, agents, agentRuntimeSessions } from '@herobids/db';

const VERSION = process.env['npm_package_version'] ?? '0.0.1';

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
  redis: { ping(): Promise<string> },
): Promise<void> {
  const adminPreHandler = requireAdmin();

  // GET /admin/stats — system health and counts
  app.get('/admin/stats', { preHandler: adminPreHandler }, async (_request, reply) => {
    const [postgresStatus, redisStatus] = await Promise.all([
      checkPostgres(db),
      checkRedis(redis),
    ]);

    const [userCount] = await db.select({ n: count(users.id) }).from(users);
    const [botCount] = await db.select({ n: count(bots.id) }).from(bots);
    const [agentCount] = await db.select({ n: count(agents.id) }).from(agents);

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
        users: userCount?.n ?? 0,
        bots: botCount?.n ?? 0,
        agents: agentCount?.n ?? 0,
      },
    });
  });

  // GET /admin/users — all users with bot and agent counts
  app.get('/admin/users', { preHandler: adminPreHandler }, async (_request, reply) => {
    const rows = await db
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
      .from(users);

    return reply.send({ users: rows });
  });

  // GET /admin/containers — running agent containers (requires Docker socket)
  app.get('/admin/containers', { preHandler: adminPreHandler }, async (_request, reply) => {
    let containerData: unknown;
    try {
      // Filter to containers with the herobids agent label
      containerData = await dockerSocketGet('/containers/json?all=false');
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
}
